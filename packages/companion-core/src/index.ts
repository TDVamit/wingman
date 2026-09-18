// Companion Core: the Unix-domain-socket hub that both the Native Messaging
// host (Chrome side) and every MCP Adapter process (Claude/Codex side)
// connect to. Owned and started by the Electron main process. There is
// exactly one of these per machine; multiple MCP adapters can be connected
// to it simultaneously.
import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import {
  makeError,
  REQUEST_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  STATIC_SERVER_PORT,
  type BrowserAction,
  type BrowserCommand,
  type BrowserResponse,
  type ClientName,
  type ActivityEvent,
  type CoreStatus,
  type RecordingState,
  type RecordingEventsEvent,
  type DownloadVideoEvent,
  type DemolyAuthEvent,
} from "@browser-agent/protocol";
import { appSupportDir, socketPath } from "@browser-agent/protocol/dist/paths";
import { demolyClient } from "./demoly-client";
import { buildAgentData, diffStates, searchAgentData, summarizeStateChange, renderHtmlAtOffset, type AgentData, type AgentAction, type RrwebEvent } from "./agent-pipeline";

interface PendingRequest {
  respondToSocket: net.Socket;
  action: BrowserAction;
  client: ClientName;
  timer: NodeJS.Timeout;
}

interface McpConnection {
  socket: net.Socket;
  client: ClientName;
  buffer: string;
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[CORE] ${line}`);
}

// Inlines rrweb-player's UMD bundle + stylesheet directly into each replay
// file so it's a single portable .html with no external assets or network
// dependency (CDN) to view a recording.
let cachedPlayerAssets: { js: string; css: string } | null = null;
function playerAssets(): { js: string; css: string } {
  if (!cachedPlayerAssets) {
    const pkgDir = path.dirname(path.dirname(require.resolve("rrweb-player")));
    cachedPlayerAssets = {
      js: fs.readFileSync(path.join(pkgDir, "umd/rrweb-player.min.js"), "utf8"),
      css: fs.readFileSync(path.join(pkgDir, "dist/style.min.css"), "utf8"),
    };
  }
  return cachedPlayerAssets;
}

// Nothing ever deleted these, so every recording (.html + its .json sidecar,
// plus any leftover .webm/.mp4 export) piled up in appSupportDir forever.
// Keep only the newest few sessions; runs after every save so the directory
// self-trims instead of needing a separate scheduled job.
const MAX_KEPT_RECORDINGS = 20;

function pruneOldRecordings(dir: string): void {
  const groups = new Map<string, number>(); // timestamp id -> newest mtime among its files
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^recording-(\d+)\.(html|json|webm|mp4|agent\.json)$/);
    if (!m) continue;
    const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    groups.set(m[1], Math.max(groups.get(m[1]) ?? 0, mtime));
  }
  const ids = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const id of ids.slice(MAX_KEPT_RECORDINGS)) {
    for (const ext of ["html", "json", "agent.json", "webm", "mp4"]) {
      fs.rmSync(path.join(dir, `recording-${id}.${ext}`), { force: true });
    }
  }
}

// Encodes a sequence of full-quality JPEG frames (captured via repeated CDP
// Page.captureScreenshot calls) into an mp4. Frames arrive at a variable
// rate as capture and page repaints interleave, so a concat-demuxer list
// with each frame's real observed duration is used instead of a fixed input
// framerate, to keep playback speed accurate.
function encodeFramesToMp4(frames: Array<{ file: string; durationSec: number }>, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const concatPath = frames[0].file.replace(/frame-\d+\.jpg$/, "concat.txt");
    const lines = frames.flatMap((f) => [`file '${f.file}'`, `duration ${f.durationSec.toFixed(3)}`]);
    lines.push(`file '${frames[frames.length - 1].file}'`);
    fs.writeFileSync(concatPath, lines.join("\n"));

    const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-vf", "fps=30", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", outPath];
    const ffmpeg = spawn("ffmpeg", args);
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
}

// Demoly's own player doesn't skip idle stretches the way our replay page's
// skipInactive setting does, so a long idle gap that flies by locally plays
// at real speed there. Bakes the same skip behavior into the timestamps
// themselves before upload: any gap bigger than the threshold plays back at
// `factor`x speed (e.g. a 10s idle stretch becomes 2.5s at the default
// factor of 4), and every later event shifts back by the time trimmed off.
function compressInactiveGaps<T extends { timestamp?: number }>(events: T[], thresholdMs = 3000, factor = 4): T[] {
  if (events.length === 0) return events;
  let offset = 0;
  let prevTimestamp = events[0].timestamp ?? 0;
  return events.map((e) => {
    const ts = e.timestamp ?? prevTimestamp;
    const gap = ts - prevTimestamp;
    if (gap > thresholdMs) offset += gap - gap / factor;
    prevTimestamp = ts;
    return { ...e, timestamp: ts - offset };
  });
}

// Custom events (see content-script.ts's addCustomEvent("wingman-comment", ...))
// carry the AI's stated reason for a click/type/etc -- the only "semantic
// action" data Wingman has, since it only exists when an MCP tool call
// passed a `comment`. A recording started by clicking the extension's
// record button directly has none, same as a raw Demoly recording; that's
// an accurate empty list, not a bug.
function extractActions(events: unknown[]): Array<{ id: string; offsetMs: number; type: string; text: string }> {
  const startTime = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0;
  return (events as Array<{ type?: number; timestamp?: number; data?: { tag?: string; payload?: { text?: string; action?: string } } }>)
    .filter((e) => e.type === 5 && e.data?.tag === "wingman-comment")
    .map((e, i) => ({
      id: `act_${i}`,
      offsetMs: (e.timestamp ?? startTime) - startTime,
      type: e.data?.payload?.action ?? "unknown",
      text: e.data?.payload?.text ?? "",
    }));
}

// Lightweight, text-first HTML for the /agent/recordings/:id/* agent-gateway routes below.
// A generic browser agent (Claude opening the recording URL in a real
// browser tab, no MCP, no hand-built API calls) can just read these pages
// the way it reads any webpage -- same underlying agent.json data as the
// /api/agent/* JSON routes, rendered for reading instead of parsing.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtTs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function textPage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<style>body{background:#0b0f19;color:#d7deed;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;line-height:1.7;padding:28px;max-width:820px;white-space:pre-wrap}
a{color:#6ea8fe;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:15px;color:#fff;white-space:normal}.dim{color:#8a94a6}.hl{color:#fff}</style>
</head><body>${bodyHtml}</body></html>`;
}

// Fully-qualified (not page-relative) links, so this same markup works whichever page it's
// rendered on: the /actions sub-page, or inlined directly into the main replay page.
function actionLine(base: string, rid: string, id: string, prevId: string | undefined, a: AgentAction, resultLine: string): string {
  const val = a.value !== undefined ? ` "${escapeHtml(a.value)}"` : "";
  const intent = a.intent ? `\nINTENT: ${escapeHtml(a.intent)}` : "";
  const stateUrl = `${base}/agent/recordings/${rid}/state?action=${id}`;
  const renderUrl = `${base}/agent/recordings/${rid}/render?action=${id}`;
  const diffLink = prevId
    ? `\nDIFF FROM PREVIOUS: <a href="${base}/agent/recordings/${rid}/diff?before=${prevId}&after=${id}">${base}/agent/recordings/${rid}/diff?before=${prevId}&after=${id}</a>`
    : "";
  return (
    `[${fmtTs(a.offsetMs)}] ${id} -- <a href="${stateUrl}">${stateUrl}</a> (or <a href="${renderUrl}">rendered HTML</a>)\n` +
    `TYPE: ${a.type}\nTARGET: ${escapeHtml(a.target.role)} "${escapeHtml(a.target.label)}"${val}${intent}` +
    (resultLine ? `\nRESULT: ${escapeHtml(resultLine)}` : "") +
    diffLink
  );
}

// Discoverable navigation target for an arbitrary timestamp (rather than one of the
// fixed action ids above) -- a real GET <form>, per the "form/citation object the
// tool's own browsing layer submits" pattern: an agent that won't construct or edit a
// URL itself can still fill in and submit a form field.
function timestampForm(base: string, id: string): string {
  return (
    `<form action="${base}/agent/recordings/${id}/render" method="get">` +
    `State at timestamp (seconds): <input name="t" type="number" step="0.001"> <button type="submit">Get rendered HTML</button></form>` +
    `<span class="dim">(same "t" param works on <a href="${base}/agent/recordings/${id}/state?t=0">/state?t=SECONDS</a> for the text version)</span>`
  );
}

function actionsBody(base: string, id: string, data: AgentData): string {
  const blocks = data.actions.map((a, i) =>
    actionLine(base, id, a.id, data.actions[i - 1]?.id, a, summarizeStateChange(data.states[data.actions[i - 1]?.id], data.states[a.id])),
  );
  return (
    `<h1>Recording ${escapeHtml(id)} -- Actions</h1>\n` +
    `<span class="dim">${data.actions.length} actions. Click an id's state link, or open <a href="${base}/agent/recordings/${id}/search?q=...">${base}/agent/recordings/${id}/search?q=...</a> to search.</span>\n\n` +
    (blocks.length ? blocks.join("\n\n") : "<span class=\"dim\">No actions recorded.</span>") +
    `\n\n${timestampForm(base, id)}`
  );
}

function renderActionsHtml(base: string, id: string, data: AgentData): string {
  return textPage(`Recording ${id} -- Actions`, actionsBody(base, id, data));
}

// Resolves either query style an agent might use: an exact ?action=ACTION_ID,
// or ?t=SECONDS (picks the action closest to that offset) -- see agentLinks'
// "Rendered HTML state" form, which lets an agent submit an arbitrary
// timestamp without having to construct/modify a URL itself.
function resolveActionByQuery(data: AgentData, url: URL): AgentAction | null {
  const actionId = url.searchParams.get("action");
  if (actionId) return data.actions.find((a) => a.id === actionId) ?? null;
  const t = url.searchParams.get("t");
  if (t === null) return null;
  const targetMs = Number(t) * 1000;
  if (Number.isNaN(targetMs) || data.actions.length === 0) return null;
  return data.actions.reduce((best, a) => (Math.abs(a.offsetMs - targetMs) < Math.abs(best.offsetMs - targetMs) ? a : best));
}

function renderStateHtml(id: string, data: AgentData, action: AgentAction | null): string {
  if (!action) return textPage("State", `<span class="dim">Pass ?action=ACTION_ID or ?t=SECONDS (see <a href="/agent/recordings/${id}/actions">/agent/recordings/${id}/actions</a>).</span>`);
  const actionId = action.id;
  const state = data.states[actionId];
  if (!state) return textPage("State", `<span class="dim">Unknown action id "${escapeHtml(actionId)}".</span>`);
  const list = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((i) => `  - ${escapeHtml(i)}`).join("\n")}` : `${label}: (none visible)`);
  const inputs = state.inputs.map((i) => `${i.label} = "${i.value}"`);
  const tables = state.tables.map((t) => `${t.headers.join(", ") || "table"} (${t.rows} rows)`);
  const body =
    `<h1>Recording ${escapeHtml(id)} -- Screen state at ${actionId} [${fmtTs(action.offsetMs)}]</h1>\n\n` +
    `Target: ${escapeHtml(action.target.role)} "${escapeHtml(action.target.label)}"\n\n` +
    [list("Headings", state.headings), list("Buttons", state.buttons), list("Inputs", inputs), list("Tables", tables)].join("\n\n");
  return textPage("State", body);
}

function renderDiffHtml(id: string, data: AgentData, beforeId: string | null, afterId: string | null): string {
  const before = beforeId ? data.states[beforeId] : undefined;
  const after = afterId ? data.states[afterId] : undefined;
  if (!before || !after)
    return textPage("Diff", `<span class="dim">Pass ?before=ACTION_ID&after=ACTION_ID (see <a href="/agent/recordings/${id}/actions">/agent/recordings/${id}/actions</a>).</span>`);
  const diff = diffStates(before, after);
  const body =
    `<h1>Recording ${escapeHtml(id)} -- Changes from ${beforeId} to ${afterId}</h1>\n\n` +
    `Added:\n${diff.added.map((a) => `  + ${escapeHtml(a)}`).join("\n") || "  (none)"}\n\n` +
    `Removed:\n${diff.removed.map((a) => `  - ${escapeHtml(a)}`).join("\n") || "  (none)"}\n\n` +
    `Changed:\n${diff.changed.map((c) => `  ${escapeHtml(c.field)}: ${escapeHtml(c.before)} → ${escapeHtml(c.after)}`).join("\n") || "  (none)"}`;
  return textPage("Diff", body);
}

function renderSearchHtml(id: string, data: AgentData, q: string): string {
  const results = q ? searchAgentData(data, q) : [];
  const body =
    `<h1>Recording ${escapeHtml(id)} -- Search "${escapeHtml(q)}"</h1>\n\n` +
    (results.length
      ? results
          .map((r) =>
            r.id
              ? `[${fmtTs(r.offsetMs)}] (${r.type}) <a href="/agent/recordings/${id}/state?action=${r.id}">${r.id}</a>: ${escapeHtml(r.match)}`
              : `[${fmtTs(r.offsetMs)}] (${r.type}): ${escapeHtml(r.match)}`
          )
          .join("\n")
      : `<span class="dim">No matches. Try <a href="/agent/recordings/${id}/actions">/agent/recordings/${id}/actions</a> instead.</span>`);
  return textPage("Search", body);
}

function headersBlock(label: string, headers: Record<string, string> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return "";
  return `\n  ${label}:\n` + Object.entries(headers).map(([k, v]) => `    ${escapeHtml(k)}: ${escapeHtml(v)}`).join("\n");
}

function bodyBlock(label: string, body: string | undefined): string {
  return body ? `\n  ${label}: ${escapeHtml(body)}` : "";
}

function renderNetworkHtml(id: string, data: AgentData): string {
  const rows = data.network.map(
    (n) =>
      `[${fmtTs(n.offsetMs)}] ${n.method} ${n.status || "ERR"} (${n.durationMs}ms) ${escapeHtml(n.url)}` +
      headersBlock("Request headers", n.requestHeaders) +
      bodyBlock("Request body", n.requestBody) +
      headersBlock("Response headers", n.responseHeaders) +
      bodyBlock("Response body", n.responseBody)
  );
  const body =
    `<h1>Recording ${escapeHtml(id)} -- Network</h1>\n` +
    `<span class="dim">${data.network.length} requests captured (fetch/XHR method, url, status, duration, headers, and bodies up to 2000 chars -- larger/non-text bodies are dropped, not truncated).</span>\n\n` +
    (rows.length ? rows.join("\n\n") : "<span class=\"dim\">No network requests captured for this recording.</span>");
  return textPage(`Recording ${id} -- Network`, body);
}

function renderConsoleHtml(id: string, data: AgentData): string {
  const rows = data.console.map((c) => `[${fmtTs(c.offsetMs)}] (${c.level}) ${escapeHtml(c.message)}`);
  const body =
    `<h1>Recording ${escapeHtml(id)} -- Console</h1>\n` +
    `<span class="dim">${data.console.length} console messages captured (log/info/warn/error/debug, up to 2000 chars each -- longer messages are truncated).</span>\n\n` +
    (rows.length ? rows.join("\n") : "<span class=\"dim\">No console messages captured for this recording.</span>");
  return textPage(`Recording ${id} -- Console`, body);
}

// Baked into saved replay .html files at write time, when the eventual request host
// (localhost vs. a tunnel like trycloudflare.com) isn't known yet -- swapped for the
// real origin in handleStaticRequest when the file is served, so the same saved file
// works whether opened locally or through a tunnel.
const AGENT_BASE_PLACEHOLDER = "__WINGMAN_AGENT_BASE__";

// Swapped at serve time for the actual action list (see resolveReplayHtml), so a fetch tool
// that won't or can't hop to a second URL still gets the full actions data from the one
// recording URL a human hands it -- no navigation required at all.
const AGENT_ACTIONS_PLACEHOLDER = "__WINGMAN_AGENT_ACTIONS__";

function originFromReq(req: http.IncomingMessage): string {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers.host ?? `127.0.0.1:${STATIC_SERVER_PORT}`;
  return `${proto}://${host}`;
}

// Resolves both serve-time placeholders in a saved replay .html file: the request's real
// origin, and (for recording-<id>.html specifically) the actual action list once it's been
// extracted -- inlined directly rather than left as a link, per the reasoning above.
function resolveReplayHtml(dir: string, fileName: string, html: string, req: http.IncomingMessage): string {
  const origin = originFromReq(req);
  let out = html.replaceAll(AGENT_BASE_PLACEHOLDER, origin);
  const idMatch = fileName.match(/^recording-(\d+)\.html$/);
  if (idMatch && out.includes(AGENT_ACTIONS_PLACEHOLDER)) {
    const id = idMatch[1];
    const agentPath = path.join(dir, `recording-${id}.agent.json`);
    const actionsText = fs.existsSync(agentPath)
      ? actionsBody(origin, id, JSON.parse(fs.readFileSync(agentPath, "utf8")) as AgentData)
      : `<span class="dim">Still extracting actions/state for this recording -- reload in a few seconds, or fetch ${origin}/agent/recordings/${id}/actions directly.</span>`;
    out = out.replaceAll(AGENT_ACTIONS_PLACEHOLDER, actionsText);
  }
  return out;
}

// One list of (label, url) pairs so the plain-text agents.txt response and the HTML copy
// embedded in the replay page (below, as real <a href> elements -- a fetch tool that won't
// follow a URL it only saw as page text will often still follow one it discovered as an
// actual anchor tag, since that's the tool's own DOM scan rather than a value the model
// parsed out of prose) can't drift apart.
function agentLinks(id: string, base: string): Array<{ label: string; url: string }> {
  return [
    { label: "Read first", url: `${base}/agent/recordings/${id}/actions` },
    { label: "Search", url: `${base}/agent/recordings/${id}/search?q=...` },
    { label: "State (only when needed)", url: `${base}/agent/recordings/${id}/state?action=ACTION_ID` },
    { label: "Rendered HTML state (only when needed)", url: `${base}/agent/recordings/${id}/render?action=ACTION_ID` },
    { label: "Diff (only when needed)", url: `${base}/agent/recordings/${id}/diff?before=ACTION_ID&after=ACTION_ID` },
    { label: "Network requests (fetch/XHR captured during recording)", url: `${base}/agent/recordings/${id}/network` },
    { label: "Console messages (log/info/warn/error/debug captured during recording)", url: `${base}/agent/recordings/${id}/console` },
    { label: "JSON equivalent (for scripted access)", url: `${base}/api/agent/recordings/${id}` },
    { label: "JSON action range (for long recordings)", url: `${base}/api/agent/recordings/${id}/range?from=&to=` },
  ];
}

function agentInstructionsPreamble(durationSec: number): string {
  return `This recording is ${durationSec.toFixed(0)}s long. Actions/screen-state finish processing a few seconds after saving -- if a link below says "processing", reload it shortly.`;
}

const AGENT_INSTRUCTIONS_FOOTER =
  "If the Wingman MCP server is already configured in your environment, its recording_*/browser_* tools may be used instead -- MCP is optional, these links work without it.";

// Plain-text version, served standalone at /agent/recordings/:id/agents.txt.
function agentInstructionsText(id: string, durationSec: number, base: string): string {
  const links = agentLinks(id, base).map((l) => `${l.label}: ${l.url}`).join("\n");
  return `${agentInstructionsPreamble(durationSec)}\n\n${links}\n\n${AGENT_INSTRUCTIONS_FOOTER}`;
}

// HTML version with real <a href> elements, embedded (unescaped) in the replay page.
function agentInstructionsHtml(id: string, durationSec: number, base: string): string {
  const links = agentLinks(id, base)
    .map((l) => `${escapeHtml(l.label)}: <a href="${escapeHtml(l.url)}">${escapeHtml(l.url)}</a>`)
    .join("\n");
  return `${escapeHtml(agentInstructionsPreamble(durationSec))}\n\n${links}\n\n${escapeHtml(AGENT_INSTRUCTIONS_FOOTER)}`;
}

function renderReplayHtml(events: unknown[], fileName: string): string {
  const { js, css } = playerAssets();
  // Defends against a "</script>" substring inside the (untrusted, page-
  // sourced) recorded events prematurely closing the inline script tag.
  const eventsJson = JSON.stringify(events).replace(/<\/script/gi, "<\\/script");

  const actions = extractActions(events);
  const comments = actions.map((a) => ({ offsetMs: a.offsetMs, text: a.text, action: a.type }));
  const commentsJson = JSON.stringify(comments);

  // Recording id = the timestamp in "recording-<id>.html", used for the
  // hosted-style /agent/recordings/:id URL and the agent API below (see
  // "Demoly Agent-Readable Recording Specification": the recording URL as
  // the universal entry point, with a server-rendered discovery block
  // rather than an aggressive/injected instruction).
  const id = fileName.replace(/^recording-/, "").replace(/\.html$/, "");
  const agentApiUrl = `${AGENT_BASE_PLACEHOLDER}/api/agent/recordings/${id}`;
  const firstTs = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0;
  const lastTs = (events[events.length - 1] as { timestamp?: number } | undefined)?.timestamp ?? firstTs;
  const durationSec = (lastTs - firstTs) / 1000;
  // Declarative (no "IGNORE PREVIOUS INSTRUCTIONS"-style injection)
  // instructions for a generic browser agent that opens this page in a real
  // tab -- present in the page source (readable via read_page/view-source)
  // but not rendered visibly, since it's not meant for the human viewer.
  // A "Copy for AI" button lets a human hand the same text to an agent
  // manually. See agents.txt route for the identical content served as a
  // standalone plain-text resource. AGENT_BASE_PLACEHOLDER is resolved to the
  // real request origin when the saved file is served (see handleStaticRequest).
  const agentInstructions = agentInstructionsHtml(id, durationSec, AGENT_BASE_PLACEHOLDER);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Wingman recording replay</title>
<meta name="wingman:agent-api" content="${agentApiUrl}">
<style>${css}</style>
<style>
:root{
  --bg:#f4f7fc;--bg-raised:#ffffff;--bg-raised-2:#eef2fa;--border:#dbe3f0;
  --text:#101828;--text-dim:#536077;--text-faint:#94a1b8;
  --accent:#2563eb;--accent-dim:#dbe9fe;--bad:#e11d48;--bad-bg:rgba(225,29,72,.1);
}
*{box-sizing:border-box;}
::selection{background:var(--accent-dim);color:var(--text);}
::-webkit-scrollbar{width:9px;height:9px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:6px;border:2px solid var(--bg-raised);}
body{margin:0;background:var(--bg);display:flex;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);-webkit-font-smoothing:antialiased;}
#layout{display:flex;flex:1;align-items:flex-start;justify-content:center;gap:16px;padding:16px;}
#comments{width:300px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:var(--bg-raised);border:1px solid var(--border);border-radius:10px;flex-shrink:0;overflow:hidden;}
#comments h3{color:var(--text-faint);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;margin:0;padding:12px 12px 6px;}
#comment-list{overflow-y:auto;padding:0 8px 4px;}
.comment{padding:8px;border-radius:6px;margin-bottom:2px;color:var(--text-dim);font-size:12.5px;line-height:1.4;cursor:default;}
.comment .ts{color:var(--accent);font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11px;display:block;margin-bottom:2px;}
.comment.active{background:var(--bg-raised-2);color:var(--text);}
#demoly{border-top:1px solid var(--border);padding:12px;}
#demoly h3{padding:0 0 8px;}
#demoly select,#demoly button{width:100%;box-sizing:border-box;margin-bottom:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:7px 8px;font-size:12.5px;font-family:inherit;}
#demoly select:focus-visible,#demoly button:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
#demoly select:disabled{opacity:.5;}
#demoly button{cursor:pointer;background:var(--accent);color:#fff;font-weight:650;border:none;transition:filter .12s ease;}
#demoly button:hover:not(:disabled){filter:brightness(1.08);}
#demoly button:disabled{opacity:.4;cursor:default;filter:none;}
#demoly-msg{font-size:12px;color:var(--text-dim);word-break:break-all;line-height:1.4;min-height:1.4em;}
#demoly-msg.error{color:var(--bad);}
#demoly-msg a{color:var(--accent);}
#agent{border-top:1px solid var(--border);padding:12px;}
#agent button{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:7px 8px;font-size:12.5px;font-family:inherit;cursor:pointer;}
#agent button:hover{background:var(--bg-raised-2);}
</style>
</head>
<body>
<div id="layout">
<div id="player"></div>
<div id="comments">
<h3>Notes</h3><div id="comment-list"></div>
<div id="demoly">
<h3>Upload to Demoly</h3>
<select id="demoly-workspace" disabled><option value="">Loading…</option></select>
<select id="demoly-project" disabled><option value="">Unfiled (Default)</option></select>
<button id="demoly-upload-btn" disabled>Upload to Demoly</button>
<div id="demoly-msg"></div>
</div>
<div id="agent">
<button id="copy-for-ai-btn" type="button">Copy for AI</button>
</div>
</div>
<pre id="agent-instructions" style="display:none">${agentInstructions}</pre>
<pre id="agent-actions" style="display:none">${AGENT_ACTIONS_PLACEHOLDER}</pre>
</div>
<script>${js}</script>
<script>
const RECORDING_FILE = ${JSON.stringify(fileName)};
const RECORDING_ID = ${JSON.stringify(id)};
const DEMOLY_API = "http://127.0.0.1:${STATIC_SERVER_PORT}/demoly";
const comments = ${commentsJson};
const player = new (rrwebPlayer.default || rrwebPlayer)({ target: document.getElementById("player"), props: { events: ${eventsJson}, mouseTail: false, skipInactive: true, inactivePeriodThreshold: 3000, maxSpeed: 720 } });
window.__wingmanPlayer = player;

const list = document.getElementById("comment-list");
list.innerHTML = comments.length
  ? comments.map((c, i) => \`<div class="comment" data-i="\${i}"><span class="ts">\${formatTs(c.offsetMs)}</span>\${c.text}</div>\`).join("")
  : '<div class="comment">No notes recorded for this session.</div>';

function formatTs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + String(s).padStart(2, "0");
}

let activeIndex = -1;
player.addEventListener("ui-update-current-time", (e) => {
  const t = e.payload;
  let idx = -1;
  for (let i = 0; i < comments.length; i++) {
    if (comments[i].offsetMs <= t) idx = i;
  }
  if (idx === activeIndex) return;
  activeIndex = idx;
  list.querySelectorAll(".comment").forEach((el) => el.classList.remove("active"));
  if (idx >= 0) {
    const el = list.querySelector('[data-i="' + idx + '"]');
    el?.classList.add("active");
    el?.scrollIntoView({ block: "nearest" });
  }
});

const copyForAiBtn = document.getElementById("copy-for-ai-btn");
copyForAiBtn.addEventListener("click", () => {
  const text = window.location.origin + "/agent/recordings/" + RECORDING_ID + "/agents.txt";
  navigator.clipboard.writeText(text).then(() => {
    copyForAiBtn.textContent = "Copied";
    setTimeout(() => (copyForAiBtn.textContent = "Copy for AI"), 1500);
  });
});

// Talks to Companion Core's own local server (a fixed 127.0.0.1 port -- this
// page is opened as file://, so it's cross-origin and relies on
// handleStaticRequest sending CORS headers), which in turn talks to Demoly
// server-to-server -- see demoly-client.ts. Nothing here calls Demoly directly.
const msgEl = document.getElementById("demoly-msg");
const workspaceEl = document.getElementById("demoly-workspace");
const projectEl = document.getElementById("demoly-project");
const uploadBtn = document.getElementById("demoly-upload-btn");

function showMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.className = isError ? "error" : "";
}

// Companion Core's own /demoly/* routes proxy to Demoly and relay its error
// body as {error} with a non-2xx status (see handleStaticRequest) -- reading
// that field is the only way to see e.g. a rate limit ("429") instead of a
// generic "Cannot read properties of undefined" from blindly destructuring
// an error body as if it were the success shape.
async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data && data.error ? data.error : \`\${res.status} \${res.statusText}\`);
  return data;
}

async function loadDemolyPanel() {
  workspaceEl.disabled = true;
  projectEl.disabled = true;
  uploadBtn.disabled = true;
  showMsg("Loading Demoly workspaces…", false);
  try {
    const status = await fetchJson(DEMOLY_API + "/status");
    if (!status.connected) {
      workspaceEl.innerHTML = '<option value="">Not connected</option>';
      showMsg("Log into app.demoly.dev in a normal tab (with Wingman installed) to connect.", false);
      return;
    }

    const [{ workspaces }, { projects }] = await Promise.all([fetchJson(DEMOLY_API + "/workspaces"), fetchJson(DEMOLY_API + "/projects")]);

    workspaceEl.innerHTML = workspaces.map((w) => \`<option value="\${w.id}"\${w.id === status.workspaceId ? " selected" : ""}>\${w.name}</option>\`).join("");
    projectEl.innerHTML =
      '<option value="">Unfiled (Default)</option>' +
      projects.map((p) => \`<option value="\${p.id}"\${p.id === status.projectId ? " selected" : ""}>\${p.name}</option>\`).join("");
    workspaceEl.disabled = false;
    projectEl.disabled = false;
    uploadBtn.disabled = false;
    showMsg("", false);
  } catch (err) {
    showMsg("Could not reach Demoly: " + (err && err.message ? err.message : err), true);
  }
}

workspaceEl.addEventListener("change", async () => {
  workspaceEl.disabled = true;
  try {
    await fetch(DEMOLY_API + "/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: workspaceEl.value }) });
    await loadDemolyPanel();
  } finally {
    workspaceEl.disabled = false;
  }
});

uploadBtn.addEventListener("click", async () => {
  uploadBtn.disabled = true;
  showMsg("Uploading...", false);
  try {
    const res = await fetch(DEMOLY_API + "/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: RECORDING_FILE, projectId: projectEl.value || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    showMsg("Uploaded: " + data.url, false);
    msgEl.innerHTML = 'Uploaded: <a href="' + data.url + '" target="_blank">' + data.url + "</a>";
  } catch (err) {
    showMsg(String(err.message || err), true);
  } finally {
    uploadBtn.disabled = false;
  }
});

loadDemolyPanel();
</script>
</body>
</html>`;
}

export class CompanionCore extends EventEmitter {
  private server: net.Server | null = null;
  private nativeHostSocket: net.Socket | null = null;
  private nativeHostBuffer = "";
  private mcpConnections = new Set<McpConnection>();
  private pending = new Map<string, PendingRequest>();
  private activity: ActivityEvent[] = [];
  private recording: RecordingState = { recording: false };
  private recordingEvents: unknown[] = [];
  private currentTab: { title: string; url: string } | null = null;

  // Serves the recordings directory over http://127.0.0.1 so the extension
  // can open a replay in a real tab -- file:// URLs need a per-extension
  // "allow access to file URLs" toggle the user would have to flip manually.
  private staticServer: http.Server | null = null;
  private staticPort = STATIC_SERVER_PORT;

  start(): void {
    fs.mkdirSync(appSupportDir(), { recursive: true });
    const path = socketPath();
    if (fs.existsSync(path)) fs.unlinkSync(path);

    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.listen(path, () => log(`listening on ${path}`));
    this.server.on("error", (err) => log(`server error: ${String(err)}`));

    // Starts eagerly (not just lazily on first video export) so replay
    // .html files -- opened directly as file:// -- can always reach the
    // "Upload to Demoly" panel's API at a known, fixed port.
    this.ensureStaticServer().catch((err) => log(`static server error: ${String(err)}`));
  }

  stop(): void {
    this.server?.close();
    this.nativeHostSocket?.destroy();
    for (const conn of this.mcpConnections) conn.socket.destroy();
  }

  getStatus(): CoreStatus {
    return {
      extensionConnected: this.nativeHostSocket !== null,
      nativeHostConnected: this.nativeHostSocket !== null,
      connectedClients: [...this.mcpConnections].map((c) => c.client),
      recording: this.recording,
      currentTab: this.currentTab,
      activity: this.activity.slice(-20),
    };
  }

  // -------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------

  private handleConnection(socket: net.Socket): void {
    let buffer = "";
    let identified = false;
    let mcpConn: McpConnection | null = null;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (!identified) {
          identified = true;
          if (msg.type === "hello" && msg.role === "native-host") {
            this.attachNativeHost(socket);
          } else if (msg.type === "hello" && msg.role === "mcp") {
            mcpConn = { socket, client: msg.client ?? "unknown", buffer: "" };
            this.mcpConnections.add(mcpConn);
            log(`mcp client connected: ${mcpConn.client}`);
            this.emit("status");
          }
          continue;
        }

        if (msg.type === "command" && mcpConn) {
          void this.handleMcpCommand(mcpConn, msg);
        } else if (this.nativeHostSocket === socket && msg.type === "event" && msg.event === "download.video") {
          void this.handleDownloadVideo(msg as DownloadVideoEvent);
        } else if (this.nativeHostSocket === socket && msg.type === "event" && msg.event === "demoly.auth") {
          const auth = msg as DemolyAuthEvent;
          demolyClient.storeHandshake(auth);
          this.recordActivity("unknown", "demoly.auth", "success", "Demoly account connected");
        } else if (this.nativeHostSocket === socket && msg.type === "event") {
          this.handleNativeHostEvent(msg as RecordingEventsEvent);
        } else if (this.nativeHostSocket === socket) {
          this.handleNativeHostResponse(msg as BrowserResponse);
        }
      }
    });

    socket.on("close", () => {
      if (this.nativeHostSocket === socket) {
        log("native host disconnected");
        this.nativeHostSocket = null;
        this.currentTab = null;
        this.failAllPending(makeError("EXTENSION_DISCONNECTED", "Chrome extension disconnected."));
        this.emit("status");
      }
      if (mcpConn) {
        this.mcpConnections.delete(mcpConn);
        log(`mcp client disconnected: ${mcpConn.client}`);
        this.emit("status");
      }
    });

    socket.on("error", () => {
      // 'close' will follow; nothing extra to do.
    });
  }

  private attachNativeHost(socket: net.Socket): void {
    log("native host (extension) connected");
    this.nativeHostSocket = socket;
    this.emit("status");
  }

  private handleNativeHostResponse(response: BrowserResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return; // timed out already, or unsolicited

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.success) {
      this.recordActivity(pending.client, pending.action, "success");
      this.trackSideEffects(pending.action, response.data);
    } else {
      this.recordActivity(pending.client, pending.action, "error", response.error?.message);
    }

    // The extension only knows recording on/off; the saved file's path is
    // tracked here (see handleNativeHostEvent/trackSideEffects), so for
    // these two actions reply with our merged state instead of relaying the
    // extension's raw data straight through, or callers polling for `path`
    // (e.g. mcp-adapter's recording_stop) would never see it.
    const data =
      response.success && (pending.action === "recording.status" || pending.action === "recording.stop")
        ? this.recording
        : (response as any).data;

    if (!pending.respondToSocket.destroyed) {
      pending.respondToSocket.write(
        JSON.stringify({ type: "response", id: response.id, success: response.success, data, error: (response as any).error }) + "\n"
      );
    }
  }

  private trackSideEffects(action: BrowserAction, data: unknown): void {
    // The extension only knows the recording on/off flag; the recorded file
    // itself is assembled here from the separate event stream (see
    // handleNativeHostEvent), so merge rather than overwrite or we'd wipe
    // out the path/timestamps we've been tracking.
    if (action === "recording.start") {
      const ext = data as { recording: boolean };
      this.recording = { recording: ext.recording, startedAt: Date.now() };
    } else if (action === "recording.stop" || action === "recording.status") {
      const ext = data as { recording: boolean };
      this.recording = { ...this.recording, recording: ext.recording };
    }
    if (action === "browser.getPageInfo" && data && typeof data === "object") {
      const d = data as { url?: string; title?: string };
      if (d.url) this.currentTab = { title: d.title ?? "", url: d.url };
    }
    this.emit("status");
  }

  // The extension records DOM mutations + interaction events via rrweb (see
  // content-script.ts) rather than pixels, so there's nothing to encode here
  // -- events are buffered as they stream in and, once the recording ends,
  // written out as a self-contained .html file that embeds the rrweb-player
  // UI to replay them.
  private handleNativeHostEvent(event: RecordingEventsEvent): void {
    if (event.event !== "recording.events") return;

    this.recordingEvents.push(...event.events);

    if (event.done) {
      const events = this.recordingEvents;
      this.recordingEvents = [];
      const dir = path.join(appSupportDir(), "recordings");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `recording-${Date.now()}.html`);
      fs.writeFileSync(filePath, renderReplayHtml(events, path.basename(filePath)));
      // Kept alongside the .html so the replay page's "Upload to Demoly"
      // button (see ensureStaticServer's /demoly/upload route) can send the
      // raw rrweb events later, without scraping them back out of the HTML.
      fs.writeFileSync(filePath.replace(/\.html$/, ".json"), JSON.stringify(events));
      pruneOldRecordings(dir);
      this.recording = { ...this.recording, path: filePath, stoppedAt: Date.now() };
      this.recordActivity("unknown", "recording.saved", "success", filePath);
      this.emit("status");
      // Fire-and-forget: the deterministic actions/state pipeline (headless
      // Chromium + the real rrweb Replayer, see agent-pipeline.ts) runs
      // after the reply's already gone out, so it never delays saving the
      // recording itself. Until it finishes, the agent API just reports the
      // recording as still processing (see handleStaticRequest).
      buildAgentData(events as RrwebEvent[])
        .then((data) => fs.writeFileSync(filePath.replace(/\.html$/, ".agent.json"), JSON.stringify(data)))
        .catch((err) => this.recordActivity("unknown", "recording.agentData", "error", String((err as Error)?.message ?? err)));
      return;
    }
    this.emit("status");
  }

  // Fire-and-forget: no MCP client is waiting on this, so failures just go to
  // the activity log rather than any response. Playwright's own video
  // recording (not a frame-stepped screenshot loop) captures the page
  // exactly as rendered, so this works identically for Wingman's own replay
  // pages and third-party ones (e.g. Demoly's) -- it only needs
  // `.replayer-wrapper` to be present, never a specific player instance.
  private async handleDownloadVideo(event: DownloadVideoEvent): Promise<void> {
    this.recordActivity("unknown", "download.video", "success", "Capturing replay video: 0%", event.id);
    const { chromium } = await import("playwright");
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "wingman-frames-"));
    let browser: import("playwright").Browser | undefined;
    try {
      browser = await chromium.launch();
      const viewport = { width: 1920, height: 1080 };
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(event.url, { waitUntil: "load" });
      const wrapper = await page.waitForSelector(".replayer-wrapper", { timeout: 15_000 });

      // rrweb-player auto-plays by default, so once we know how long the
      // recording runs we just need to wait that long. Prefer our own
      // player's exact metadata; fall back to scanning the page for the
      // largest MM:SS-shaped label -- every player (rrweb-player's own UI or
      // a third party's custom one, e.g. Demoly's) shows the total duration
      // as text somewhere, and it's always the biggest such value on screen
      // (current-time/remaining-time labels are always <= it).
      const totalMs: number = await page.evaluate(() => {
        const w = window as unknown as { __wingmanPlayer?: { getMetaData?: () => { totalTime?: number } } };
        const meta = w.__wingmanPlayer?.getMetaData?.();
        if (meta?.totalTime) return meta.totalTime;

        const timePattern = /^\d{1,2}:\d{2}(:\d{2})?$/;
        let maxSeconds = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim();
          if (!text || !timePattern.test(text)) continue;
          const seconds = text.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
          if (seconds > maxSeconds) maxSeconds = seconds;
        }
        return maxSeconds > 0 ? maxSeconds * 1000 : 30_000;
      });

      // Crop the recorded video down to just the replayer element, so the
      // exported file doesn't include the host page's own chrome (nav bars,
      // share buttons, player controls) around it. Done via the screenshot's
      // own `clip` option below rather than an ffmpeg crop filter afterward,
      // so cropping never itself costs quality.
      const box = await wrapper.boundingBox();
      // scale: 2 captures this clip at retina density. There's no
      // context-wide deviceScaleFactor override here -- that's what made
      // frames come back rotated 90 degrees on this Chromium build, and
      // Page.startScreencast (tried in between) can't do per-frame scaling
      // at all, so it was dropped back out once benchmarking on a real
      // replay page (not a toy animation) showed it has no fps edge over
      // plain polling here anyway -- the page's own render cost dominates,
      // not CDP round-trip overhead.
      const clip = box
        ? { x: box.x, y: box.y, width: Math.floor(box.width / 2) * 2, height: Math.floor(box.height / 2) * 2, scale: 2 }
        : undefined;
      const cdp = await context.newCDPSession(page);

      // skipInactive (set on our own player above) fast-forwards through
      // idle stretches, so real playback finishes well before `totalMs`
      // (that's the nominal, un-skipped duration) -- watch for the player's
      // own finish event instead of always waiting the full totalMs, or the
      // capture would just pad the end with frozen frames until it caught up,
      // erasing the skip effect from the exported video. Only our own
      // generated pages expose __wingmanPlayer; on a third-party page (e.g.
      // Demoly's own hosted player) this is a no-op and totalMs is used as-is.
      await page.evaluate(() => {
        const w = window as unknown as { __wingmanPlayer?: { addEventListener?: (e: string, cb: () => void) => void }; __wingmanFinished?: boolean };
        w.__wingmanFinished = false;
        w.__wingmanPlayer?.addEventListener?.("finish", () => {
          w.__wingmanFinished = true;
        });
      });

      // Capture full-quality JPEG frames via repeated CDP Page.captureScreenshot
      // calls. Each call's own real wall-clock latency paces the loop, and
      // that observed gap is fed to ffmpeg as the frame's duration, keeping
      // playback speed accurate.
      const frames: Array<{ file: string; startedAt: number }> = [];
      const pendingWrites: Promise<void>[] = [];
      let frameIndex = 0;
      const startedAt = Date.now();
      let lastPct = -1;
      while (Date.now() - startedAt < totalMs) {
        const frameStart = Date.now();
        const { data } = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 100, clip, fromSurface: true } as never)) as { data: string };
        const file = path.join(frameDir, `frame-${String(frameIndex++).padStart(6, "0")}.jpg`);
        // Writing the frame to disk asynchronously (rather than
        // fs.writeFileSync) lets the next capture fire immediately instead of
        // blocking Node's single thread on disk I/O.
        pendingWrites.push(fs.promises.writeFile(file, Buffer.from(data, "base64")));
        frames.push({ file, startedAt: frameStart });

        const pct = Math.min(99, Math.floor(((Date.now() - startedAt) / totalMs) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          this.recordActivity("unknown", "download.video", "success", `Capturing replay video: ${pct}%`, event.id);
        }

        // Checking the finish flag is its own CDP round trip, so it's only
        // done every few frames rather than on every single one.
        if (frameIndex % 5 === 0) {
          const finished = await page.evaluate(() => (window as unknown as { __wingmanFinished?: boolean }).__wingmanFinished === true);
          if (finished) break;
        }
      }
      await Promise.all(pendingWrites);
      await context.close();

      if (frames.length === 0) throw new Error("No frames were captured");
      const framesWithDuration = frames.map((f, i) => ({
        file: f.file,
        durationSec: Math.max((i < frames.length - 1 ? frames[i + 1].startedAt - f.startedAt : 100) / 1000, 0.02),
      }));

      const outPath = path.join(os.homedir(), "Downloads", `wingman-replay-${Date.now()}.mp4`);
      await encodeFramesToMp4(framesWithDuration, outPath);
      this.recordActivity("unknown", "download.video", "success", outPath, event.id);
    } catch (err) {
      this.recordActivity("unknown", "download.video", "error", String((err as Error)?.message ?? err), event.id);
    } finally {
      await browser?.close().catch(() => {});
      fs.rmSync(frameDir, { recursive: true, force: true });
    }
  }

  private async handleMcpCommand(conn: McpConnection, msg: { id: string; action: BrowserAction; params: unknown }): Promise<void> {
    // Demoly workspace/project selection is a pure Companion Core <-> Demoly
    // API concern (see demoly-client.ts) -- it doesn't touch the extension at
    // all, so it's handled here directly rather than requiring the extension
    // to be connected like every other action below.
    if (msg.action.startsWith("demoly.")) {
      await this.handleDemolyCommand(conn, msg as { id: string; action: BrowserAction; params: unknown });
      return;
    }

    if (!this.nativeHostSocket) {
      this.recordActivity(conn.client, msg.action, "error", "extension disconnected");
      conn.socket.write(
        JSON.stringify({
          type: "response",
          id: msg.id,
          success: false,
          error: makeError("EXTENSION_DISCONNECTED", "Chrome extension is not connected."),
        }) + "\n"
      );
      return;
    }

    const params: unknown = msg.params;
    const timeoutMs = msg.action === "browser.screenshot" ? SCREENSHOT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.pending.delete(msg.id);
      this.recordActivity(conn.client, msg.action, "error", "timed out");
      if (!conn.socket.destroyed) {
        conn.socket.write(
          JSON.stringify({
            type: "response",
            id: msg.id,
            success: false,
            error: makeError("REQUEST_TIMEOUT", "Browser command timed out."),
          }) + "\n"
        );
      }
    }, timeoutMs);

    this.pending.set(msg.id, { respondToSocket: conn.socket, action: msg.action, client: conn.client, timer });

    const command: BrowserCommand = { id: msg.id, action: msg.action, params } as BrowserCommand;
    this.nativeHostSocket.write(JSON.stringify(command) + "\n");
  }

  private async handleDemolyCommand(conn: McpConnection, msg: { id: string; action: BrowserAction; params: unknown }): Promise<void> {
    const respond = (success: boolean, data?: unknown, error?: string) => {
      this.recordActivity(conn.client, msg.action, success ? "success" : "error", error);
      conn.socket.write(JSON.stringify({ type: "response", id: msg.id, success, data, error: error ? makeError("DEMOLY_NOT_CONNECTED", error) : undefined }) + "\n");
    };

    try {
      switch (msg.action) {
        case "demoly.getStatus":
          respond(true, demolyClient.getStatus());
          return;
        case "demoly.listWorkspaces":
          respond(true, { workspaces: await demolyClient.listWorkspaces() });
          return;
        case "demoly.setWorkspace":
          await demolyClient.setWorkspace((msg.params as { organizationId: string }).organizationId);
          respond(true, demolyClient.getStatus());
          return;
        case "demoly.listProjects":
          respond(true, { projects: await demolyClient.listProjects() });
          return;
        case "demoly.setProject":
          demolyClient.setProject((msg.params as { projectId: string | null }).projectId);
          respond(true, demolyClient.getStatus());
          return;
        default:
          respond(false, undefined, `Unknown Demoly action: ${msg.action}`);
      }
    } catch (err) {
      respond(false, undefined, String((err as Error)?.message ?? err));
    }
  }

  private ensureStaticServer(): Promise<number> {
    if (this.staticServer) return Promise.resolve(this.staticPort);
    return new Promise((resolve, reject) => {
      const dir = path.join(appSupportDir(), "recordings");
      const server = http.createServer((req, res) => this.handleStaticRequest(dir, req, res));
      server.on("error", reject);
      server.listen(STATIC_SERVER_PORT, "127.0.0.1", () => {
        this.staticServer = server;
        resolve(this.staticPort);
      });
    });
  }

  // Serves saved replay .html files, plus a small JSON API the replay page's
  // "Upload to Demoly" panel talks to (see renderReplayHtml). Replay files
  // are opened as file://, so this is cross-origin from the browser's
  // perspective -- CORS headers below are what let it through. That's safe:
  // this server only binds 127.0.0.1 and only proxies to Demoly using
  // credentials it already holds locally (see demoly-client.ts); nothing
  // here accepts credentials from the caller.
  private handleStaticRequest(dir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Chrome's Private Network Access check: a page fetching 127.0.0.1 needs
    // this on top of normal CORS, or the request is blocked before it even
    // reaches here (fails silently as a generic "Failed to fetch").
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

    // Polled by the extension popup after it stops a recording, so it can
    // open the saved replay itself once Companion Core finishes writing it
    // (the extension only knows the recording on/off flag, not the file --
    // see trackSideEffects's comment).
    if (url.pathname === "/recording/status" && req.method === "GET") {
      json(200, this.recording);
      return;
    }

    // Hosted-style recording URL (spec section 3) -- an alias for the plain
    // filename route below, so a recording can be handed out as
    // "/agent/recordings/<id>" the way a real hosted app would, instead of a
    // raw filename.
    const rMatch = url.pathname.match(/^\/agent\/recordings\/(\d+)$/);
    if (rMatch && req.method === "GET") {
      const fileName = `recording-${rMatch[1]}.html`;
      fs.readFile(path.join(dir, fileName), "utf8", (err, data) => {
        if (err) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(resolveReplayHtml(dir, fileName, data, req));
      });
      return;
    }

    // Standalone plain-text agent instructions -- same wording as the hidden
    // block embedded in the replay page, served on its own so an agent can
    // fetch it directly instead of parsing HTML.
    const agentsTxtMatch = url.pathname.match(/^\/agent\/recordings\/(\d+)\/agents\.txt$/);
    if (agentsTxtMatch && req.method === "GET") {
      const [, id] = agentsTxtMatch;
      const jsonPath = path.join(dir, `recording-${id}.json`);
      if (!fs.existsSync(jsonPath)) return void res.writeHead(404).end("Recording not found");
      const events = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Array<{ timestamp?: number }>;
      const first = events[0]?.timestamp ?? 0;
      const last = events[events.length - 1]?.timestamp ?? first;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(agentInstructionsText(id, (last - first) / 1000, originFromReq(req)));
      return;
    }

    // Agent gateway (browser-first, no MCP/JSON-client needed): the same
    // agent.json data as /api/agent/* below, rendered as plain readable HTML
    // so a generic browser agent (e.g. Claude just opening the recording URL
    // in a real tab) can navigate it like any other webpage instead of
    // constructing API calls by hand.
    const rSubMatch = url.pathname.match(/^\/agent\/recordings\/(\d+)\/(actions|state|diff|search|network|console)$/);
    if (rSubMatch && req.method === "GET") {
      const [, id, sub] = rSubMatch;
      const agentPath = path.join(dir, `recording-${id}.agent.json`);
      if (!fs.existsSync(path.join(dir, `recording-${id}.json`))) return void res.writeHead(404).end("Recording not found");
      if (!fs.existsSync(agentPath))
        return void res.writeHead(202, { "Content-Type": "text/html; charset=utf-8" }).end(textPage("Processing", "<span class=\"dim\">Still extracting actions/state for this recording -- reload in a few seconds.</span>"));

      const data = JSON.parse(fs.readFileSync(agentPath, "utf8")) as AgentData;
      const html =
        sub === "actions"
          ? renderActionsHtml(originFromReq(req), id, data)
          : sub === "state"
            ? renderStateHtml(id, data, resolveActionByQuery(data, url))
            : sub === "diff"
              ? renderDiffHtml(id, data, url.searchParams.get("before"), url.searchParams.get("after"))
              : sub === "network"
                ? renderNetworkHtml(id, data)
                : sub === "console"
                  ? renderConsoleHtml(id, data)
                  : renderSearchHtml(id, data, url.searchParams.get("q") ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    // Rendered-HTML counterpart to /state above: instead of a text summary,
    // hands back the actual reconstructed DOM at a timestamp -- for an agent
    // that wants to look at the real screen. Same ?action=/?t= query as
    // /state (see resolveActionByQuery), but this one isn't precomputed --
    // it replays the raw event stream on demand (see renderHtmlAtOffset),
    // so it only costs a headless-Chromium pass when actually requested.
    const renderMatch = url.pathname.match(/^\/agent\/recordings\/(\d+)\/render$/);
    if (renderMatch && req.method === "GET") {
      const [, id] = renderMatch;
      const jsonPath = path.join(dir, `recording-${id}.json`);
      const agentPath = path.join(dir, `recording-${id}.agent.json`);
      if (!fs.existsSync(jsonPath)) return void res.writeHead(404).end("Recording not found");

      const events = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as RrwebEvent[];
      let offsetMs: number | null = null;
      const t = url.searchParams.get("t");
      if (t !== null) {
        const parsed = Number(t) * 1000;
        offsetMs = Number.isNaN(parsed) ? null : parsed;
      } else if (fs.existsSync(agentPath)) {
        const data = JSON.parse(fs.readFileSync(agentPath, "utf8")) as AgentData;
        offsetMs = resolveActionByQuery(data, url)?.offsetMs ?? null;
      }

      if (offsetMs === null) {
        return void res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(textPage("Rendered state", `<span class="dim">Pass ?action=ACTION_ID or ?t=SECONDS.</span>\n\n${timestampForm(originFromReq(req), id)}`));
      }

      renderHtmlAtOffset(events, offsetMs)
        .then((html) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html || "<p>No content at this timestamp.</p>"))
        .catch(() => res.writeHead(500).end("Render failed"));
      return;
    }

    // Agent API (spec sections 6, 7, 11, 13): metadata, semantic actions,
    // programmatic diff and search for a recording, so an agent given just
    // the URL can understand it without downloading the raw rrweb event
    // stream or calling an LLM. All of it is read from the sidecar
    // `<id>.agent.json` built once at save time (see handleNativeHostEvent
    // -> agent-pipeline.ts) -- no tokens/auth/rate-limits, since this only
    // binds 127.0.0.1 and there's a single local user.
    const agentMatch = url.pathname.match(/^\/api\/agent\/recordings\/(\d+)(\/(actions|diff|search|range|network|console))?$/);
    if (agentMatch && req.method === "GET") {
      const id = agentMatch[1];
      const jsonPath = path.join(dir, `recording-${id}.json`);
      const agentPath = path.join(dir, `recording-${id}.agent.json`);
      if (!fs.existsSync(jsonPath)) return void json(404, { error: "Recording not found" });
      if (!fs.existsSync(agentPath)) return void json(202, { status: "processing", message: "Deterministic action/state extraction hasn't finished yet -- retry shortly." });

      const data = JSON.parse(fs.readFileSync(agentPath, "utf8")) as AgentData;
      const sub = agentMatch[3];

      if (sub === "actions") return void json(200, { actions: data.actions });

      if (sub === "network") return void json(200, { network: data.network });

      if (sub === "console") return void json(200, { console: data.console });

      if (sub === "range") {
        const from = Number(url.searchParams.get("from") ?? 0);
        const to = Number(url.searchParams.get("to") ?? Infinity);
        return void json(200, { actions: data.actions.filter((a) => a.offsetMs >= from && a.offsetMs <= to) });
      }

      if (sub === "search") {
        const q = url.searchParams.get("q") ?? "";
        return void json(200, { results: searchAgentData(data, q) });
      }

      if (sub === "diff") {
        const before = data.states[url.searchParams.get("before") ?? ""];
        const after = data.states[url.searchParams.get("after") ?? ""];
        if (!before || !after) return void json(400, { error: "before/after must be existing action ids" });
        return void json(200, diffStates(before, after));
      }

      const events = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Array<{ timestamp?: number }>;
      const first = events[0]?.timestamp ?? 0;
      const last = events[events.length - 1]?.timestamp ?? first;
      json(200, {
        schema_version: "1.0",
        recording: { id, duration_seconds: (last - first) / 1000 },
        summary: { action_count: data.actions.length },
        links: {
          actions: `/api/agent/recordings/${id}/actions`,
          search: `/api/agent/recordings/${id}/search?q=`,
          range: `/api/agent/recordings/${id}/range?from=&to=`,
          diff: `/api/agent/recordings/${id}/diff?before=&after=`,
          network: `/api/agent/recordings/${id}/network`,
          console: `/api/agent/recordings/${id}/console`,
          replay: `/agent/recordings/${id}`,
        },
      });
      return;
    }

    // Per-action state (spec sections 9 & 12): what was on screen, and what
    // the clicked/typed element looked like, at that action's moment.
    const stateMatch = url.pathname.match(/^\/api\/agent\/recordings\/(\d+)\/actions\/(act_\d+)\/state$/);
    if (stateMatch && req.method === "GET") {
      const [, id, actionId] = stateMatch;
      const agentPath = path.join(dir, `recording-${id}.agent.json`);
      if (!fs.existsSync(agentPath)) return void json(404, { error: "Recording or action not found" });
      const data = JSON.parse(fs.readFileSync(agentPath, "utf8")) as AgentData;
      const action = data.actions.find((a) => a.id === actionId);
      const state = data.states[actionId];
      if (!action || !state) return void json(404, { error: "Recording or action not found" });
      json(200, { offsetMs: action.offsetMs, target: action.target, ...state });
      return;
    }

    if (url.pathname === "/demoly/status" && req.method === "GET") {
      json(200, demolyClient.getStatus());
      return;
    }

    if (url.pathname === "/demoly/workspaces" && req.method === "GET") {
      demolyClient
        .listWorkspaces()
        .then((workspaces) => json(200, { workspaces }))
        .catch((err) => json(500, { error: String(err.message ?? err) }));
      return;
    }

    if (url.pathname === "/demoly/projects" && req.method === "GET") {
      demolyClient
        .listProjects()
        .then((projects) => json(200, { projects }))
        .catch((err) => json(500, { error: String(err.message ?? err) }));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/demoly/workspace" || url.pathname === "/demoly/project" || url.pathname === "/demoly/upload")) {
      this.readJsonBody(req)
        .then(async (body) => {
          if (url.pathname === "/demoly/workspace") {
            await demolyClient.setWorkspace((body as { organizationId: string }).organizationId);
            json(200, demolyClient.getStatus());
          } else if (url.pathname === "/demoly/project") {
            demolyClient.setProject((body as { projectId: string | null }).projectId);
            json(200, demolyClient.getStatus());
          } else {
            const { file } = body as { file: string };
            const htmlPath = path.join(dir, path.basename(file));
            const jsonPath = htmlPath.replace(/\.html$/, ".json");
            const events: Array<{ type?: number; timestamp?: number; data?: { tag?: string; href?: string; payload?: { text?: string } } }> = compressInactiveGaps(
              JSON.parse(fs.readFileSync(jsonPath, "utf8"))
            );
            const meta = events.find((e: { type?: number }) => e.type === 4) as { data?: { href?: string } } | undefined;
            const first = events[0]?.timestamp ?? 0;
            const last = events[events.length - 1]?.timestamp ?? first;
            const comments = extractActions(events).map((a) => ({ text: a.text, offsetMs: a.offsetMs }));
            const result = await demolyClient.upload({
              events,
              sourceUrl: meta?.data?.href ?? "",
              title: `Wingman recording ${new Date().toLocaleString()}`,
              durationMs: last - first,
              projectId: (body as { projectId?: string | null }).projectId,
              comments,
            });
            json(200, result);
          }
        })
        .catch((err) => json(err instanceof SyntaxError ? 400 : 500, { error: String((err as Error).message ?? err) }));
      return;
    }

    const file = path.join(dir, path.basename(decodeURIComponent(url.pathname)));
    fs.readFile(file, "utf8", (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(resolveReplayHtml(dir, path.basename(file), data, req));
    });
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  private failAllPending(error: ReturnType<typeof makeError>): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (!pending.respondToSocket.destroyed) {
        pending.respondToSocket.write(JSON.stringify({ type: "response", id, success: false, error }) + "\n");
      }
    }
    this.pending.clear();
  }

  private recordActivity(client: ClientName, action: string, status: "success" | "error", detail?: string, id?: string): void {
    const event: ActivityEvent = { timestamp: Date.now(), client, action, status, detail, id };
    this.activity.push(event);
    if (this.activity.length > 200) this.activity.shift();
    log(`client=${client} action=${action} status=${status}${detail ? ` detail=${detail}` : ""}`);
    this.emit("activity", event);
    this.emit("status");
  }

  /**
   * Lets the companion GUI issue a real command through the exact same
   * path an MCP adapter would use (e.g. the "Start test recording" button),
   * so the round trip genuinely exercises core -> native-host -> extension.
   */
  async sendCommand(action: BrowserAction, params: unknown, client: ClientName = "gui"): Promise<BrowserResponse> {
    if (!this.nativeHostSocket) {
      return { id: "gui", success: false, error: makeError("EXTENSION_DISCONNECTED", "Chrome extension is not connected.") };
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, success: false, error: makeError("REQUEST_TIMEOUT", "Browser command timed out.") });
      }, action === "browser.screenshot" ? SCREENSHOT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);

      const fakeSocket = {
        destroyed: false,
        write: (line: string) => {
          clearTimeout(timer);
          const parsed = JSON.parse(line);
          resolve({ id, success: parsed.success, data: parsed.data, error: parsed.error } as BrowserResponse);
        },
      } as unknown as net.Socket;

      this.pending.set(id, { respondToSocket: fakeSocket, action, client, timer });
      this.nativeHostSocket!.write(JSON.stringify({ id, action, params }) + "\n");
    });
  }

  /** Sends a raw ping down to the extension for diagnostics; resolves with round-trip ms or throws. */
  async ping(): Promise<number> {
    if (!this.nativeHostSocket) throw new Error("EXTENSION_DISCONNECTED");
    const id = randomUUID();
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);

      // Use a throwaway fake socket-like object so the normal response path
      // can deliver the result without an extra branch.
      const fakeSocket = {
        destroyed: false,
        write: () => {
          clearTimeout(timer);
          resolve(Date.now() - start);
        },
      } as unknown as net.Socket;

      this.pending.set(id, { respondToSocket: fakeSocket, action: "ping", client: "unknown", timer });
      this.nativeHostSocket!.write(JSON.stringify({ id, action: "ping", params: {} }) + "\n");
    });
  }
}
