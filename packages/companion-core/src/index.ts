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
    const m = name.match(/^recording-(\d+)\.(html|json|webm|mp4)$/);
    if (!m) continue;
    const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    groups.set(m[1], Math.max(groups.get(m[1]) ?? 0, mtime));
  }
  const ids = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const id of ids.slice(MAX_KEPT_RECORDINGS)) {
    for (const ext of ["html", "json", "webm", "mp4"]) {
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

function renderReplayHtml(events: unknown[], fileName: string): string {
  const { js, css } = playerAssets();
  // Defends against a "</script>" substring inside the (untrusted, page-
  // sourced) recorded events prematurely closing the inline script tag.
  const eventsJson = JSON.stringify(events).replace(/<\/script/gi, "<\\/script");

  // Custom events (see content-script.ts's addCustomEvent("wingman-comment", ...))
  // carry the AI's stated reason for a click/type/etc; pulled out here so the
  // replay page can list them in a sidebar next to when they happened,
  // instead of them only existing invisibly inside the rrweb event stream.
  const startTime = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0;
  const comments = (events as Array<{ type?: number; timestamp?: number; data?: { tag?: string; payload?: { text?: string; action?: string } } }>)
    .filter((e) => e.type === 5 && e.data?.tag === "wingman-comment")
    .map((e) => ({
      offsetMs: (e.timestamp ?? startTime) - startTime,
      text: e.data?.payload?.text ?? "",
      action: e.data?.payload?.action ?? "",
    }));
  const commentsJson = JSON.stringify(comments);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Wingman recording replay</title>
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
</div>
</div>
<script>${js}</script>
<script>
const RECORDING_FILE = ${JSON.stringify(fileName)};
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

async function loadDemolyPanel() {
  workspaceEl.disabled = true;
  projectEl.disabled = true;
  uploadBtn.disabled = true;
  showMsg("Loading Demoly workspaces…", false);
  try {
    const status = await fetch(DEMOLY_API + "/status").then((r) => r.json());
    if (!status.connected) {
      workspaceEl.innerHTML = '<option value="">Not connected</option>';
      showMsg("Log into app.demoly.dev in a normal tab (with Wingman installed) to connect.", false);
      return;
    }

    const [{ workspaces }, { projects }] = await Promise.all([
      fetch(DEMOLY_API + "/workspaces").then((r) => r.json()),
      fetch(DEMOLY_API + "/projects").then((r) => r.json()),
    ]);

    workspaceEl.innerHTML = workspaces.map((w) => \`<option value="\${w.id}"\${w.id === status.workspaceId ? " selected" : ""}>\${w.name}</option>\`).join("");
    projectEl.innerHTML =
      '<option value="">Unfiled (Default)</option>' +
      projects.map((p) => \`<option value="\${p.id}"\${p.id === status.projectId ? " selected" : ""}>\${p.name}</option>\`).join("");
    workspaceEl.disabled = false;
    projectEl.disabled = false;
    uploadBtn.disabled = false;
    showMsg("", false);
  } catch (err) {
    showMsg("Could not reach Companion Core at " + DEMOLY_API + ": " + (err && err.message ? err.message : err), true);
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
            const comments = (events as Array<{ type?: number; timestamp?: number; data?: { tag?: string; payload?: { text?: string } } }>)
              .filter((e) => e.type === 5 && e.data?.tag === "wingman-comment")
              .map((e) => ({ text: e.data?.payload?.text ?? "", offsetMs: (e.timestamp ?? first) - first }));
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
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(data);
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
