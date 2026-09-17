// Deterministic (no-LLM) extraction of semantic actions + screen states from
// a raw rrweb event stream -- see "Demoly Agent-Readable Recording
// Specification": actions/state/diff/search should all be programmatic,
// derived once at save time and just read back per request, never
// recomputed or handed to an LLM.
//
// Runs the real rrweb Replayer inside a headless Chromium page (Playwright
// is already a companion-core dependency, used for "Download video") so a
// clicked/typed node id resolves against the actual reconstructed DOM
// instead of reimplementing rrweb's snapshot/mutation logic here. This is
// why it works on a plain browser-extension recording with zero AI
// involvement -- clicks, inputs and scrolls are rrweb's own event types,
// not something Wingman's MCP tools add.
import * as fs from "fs";
import * as path from "path";

export interface AgentAction {
  id: string;
  offsetMs: number;
  type: "click" | "dblclick" | "contextmenu" | "input" | "scroll";
  target: { role: string; label: string; geometry: { x: number; y: number; width: number; height: number } | null };
  value?: string;
  // The AI's stated reason for this action, if one was recorded within
  // INTENT_WINDOW_MS of it (see content-script.ts's wingman-comment custom
  // event) -- an enrichment on top of the deterministic action, never the
  // only source for it.
  intent?: string;
}

export interface AgentState {
  headings: string[];
  buttons: string[];
  inputs: Array<{ label: string; value: string }>;
  tables: Array<{ rows: number; headers: string[] }>;
}

export interface NetworkEntry {
  offsetMs: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  ok: boolean;
  // Headers and small text bodies (see content-script.ts's MAX_BODY_CHARS) --
  // large or non-text bodies are dropped entirely at capture time, not
  // truncated, so these are never partial.
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

export interface ActionsAndStates {
  actions: AgentAction[];
  states: Record<string, AgentState>;
}

export interface AgentData extends ActionsAndStates {
  network: NetworkEntry[];
}

export type RrwebEvent = { type?: number; timestamp?: number; data?: any };

// rrweb's own enums (see node_modules/rrweb/dist/rrweb.js: IncrementalSource,
// MouseInteractions, EventType) -- duplicated as plain numbers here since
// this file only reads raw JSON, it never imports rrweb's Node build.
const INCREMENTAL_SNAPSHOT = 3;
const SOURCE_MOUSE_INTERACTION = 2;
const SOURCE_SCROLL = 3;
const SOURCE_INPUT = 5;
const MOUSE_CLICK = 2;
const MOUSE_CONTEXTMENU = 3;
const MOUSE_DBLCLICK = 4;

const INTENT_WINDOW_MS = 1500;
const MAX_ACTIONS = 300; // ponytail: hard cap so one huge recording can't hang the headless pass; paginate if that's ever hit for real

let rrwebBundleCache: string | null = null;
function rrwebBundle(): string {
  if (!rrwebBundleCache) {
    const pkgDir = path.dirname(path.dirname(require.resolve("rrweb")));
    rrwebBundleCache = fs.readFileSync(path.join(pkgDir, "dist/rrweb.umd.min.cjs"), "utf8");
  }
  return rrwebBundleCache;
}

function pickInteresting(events: RrwebEvent[]): Array<{ ts: number; kind: AgentAction["type"]; nodeId: number; value?: string }> {
  const base = events[0]?.timestamp ?? 0;
  const out: Array<{ ts: number; kind: AgentAction["type"]; nodeId: number; value?: string }> = [];
  let lastScroll = -Infinity;
  for (const e of events) {
    if (e.type !== INCREMENTAL_SNAPSHOT || !e.data) continue;
    const ts = (e.timestamp ?? base) - base;
    if (e.data.source === SOURCE_MOUSE_INTERACTION && [MOUSE_CLICK, MOUSE_DBLCLICK, MOUSE_CONTEXTMENU].includes(e.data.type)) {
      out.push({ ts, kind: e.data.type === MOUSE_DBLCLICK ? "dblclick" : e.data.type === MOUSE_CONTEXTMENU ? "contextmenu" : "click", nodeId: e.data.id });
    } else if (e.data.source === SOURCE_INPUT) {
      out.push({ ts, kind: "input", nodeId: e.data.id, value: typeof e.data.text === "string" ? e.data.text : undefined });
    } else if (e.data.source === SOURCE_SCROLL) {
      // A drag-scroll fires dozens of these a second; keep roughly one per
      // second of scrolling instead of every single frame.
      if (ts - lastScroll < 1000) continue;
      lastScroll = ts;
      out.push({ ts, kind: "scroll", nodeId: e.data.id });
    }
  }
  return out.slice(0, MAX_ACTIONS);
}

// Runs inside the headless page via page.evaluate -- kept as a single
// function (rather than several) because everything it touches (rrweb
// global, the replayer instance, its iframe) only exists in that page.
function browserExtract({ events, points }: { events: RrwebEvent[]; points: Array<{ ts: number; kind: string; nodeId: number; value?: string }> }) {
  // @ts-expect-error rrweb UMD global, injected by addScriptTag
  const replayer = new window.rrweb.Replayer(events, { root: document.body, mouseTail: false, useVirtualDom: false, showWarning: false });
  const mirror = replayer.getMirror();

  function labelOf(node: any): { role: string; label: string; geometry: { x: number; y: number; width: number; height: number } | null } {
    if (!node || node.nodeType !== 1) return { role: "unknown", label: "", geometry: null };
    const el = node as HTMLElement;
    const rect = el.getBoundingClientRect();
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const label =
      el.getAttribute("aria-label") ||
      (el as HTMLInputElement).placeholder ||
      (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) ||
      el.getAttribute("name") ||
      "";
    return { role, label, geometry: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    const viewportH = replayer.iframe.contentWindow?.innerHeight ?? 1080;
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewportH;
  }

  function text(el: Element): string {
    return (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  // The recorded page can itself embed an iframe (e.g. a demo host page
  // wrapping the real app), so the content worth reading isn't always in
  // replayer.iframe.contentDocument directly -- it can be nested arbitrarily
  // deep inside same-origin (rrweb-reconstructed) child iframes. Collect
  // every reachable document instead of assuming a single level, or state
  // extraction silently reads only the outer shell forever.
  function allDocuments(doc: Document | null, depth = 0): Document[] {
    if (!doc || depth > 4) return [];
    const nested = [...doc.querySelectorAll("iframe")].flatMap((f: any) => {
      try {
        return allDocuments(f.contentDocument, depth + 1);
      } catch {
        return [];
      }
    });
    return [doc, ...nested];
  }

  function extractState(): AgentState {
    const docs = allDocuments(replayer.iframe.contentDocument);
    if (docs.length === 0) return { headings: [], buttons: [], inputs: [], tables: [] };
    const headings = docs.flatMap((doc) => [...doc.querySelectorAll("h1,h2,h3")].filter(isVisible).map(text)).filter(Boolean).slice(0, 10);
    const buttons = docs.flatMap((doc) => [...doc.querySelectorAll("button,[role=button],a")].filter(isVisible).map(text)).filter(Boolean).slice(0, 15);
    const inputs = docs
      .flatMap((doc) =>
        [...doc.querySelectorAll("input,textarea,select")]
          .filter(isVisible)
          .map((el: any) => ({ label: el.getAttribute("aria-label") || el.placeholder || el.name || "", value: String(el.value ?? "") }))
      )
      .filter((i) => i.label)
      .slice(0, 15);
    const tables = docs
      .flatMap((doc) =>
        [...doc.querySelectorAll("table")]
          .filter(isVisible)
          .map((t) => ({ rows: t.querySelectorAll("tr").length, headers: [...t.querySelectorAll("th")].map(text).filter(Boolean).slice(0, 10) }))
      )
      .slice(0, 5);
    return { headings, buttons, inputs, tables };
  }

  const actions: AgentAction[] = [];
  const states: Record<string, AgentState> = {};
  let i = 0;
  for (const p of points) {
    replayer.pause(Math.max(0, p.ts));
    const id = `act_${i++}`;
    actions.push({ id, offsetMs: p.ts, type: p.kind as AgentAction["type"], target: labelOf(mirror.getNode(p.nodeId)), value: p.value });
    states[id] = extractState();
  }
  return { actions, states };
}

// Shared by buildAgentData and renderHtmlAtOffset -- both just need a headless
// page with the rrweb Replayer's script loaded, then run some page.evaluate.
async function withReplayerPage<T>(run: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<!DOCTYPE html><html><body></body></html>");
    await page.addScriptTag({ content: rrwebBundle() });
    return await run(page);
  } finally {
    await browser.close();
  }
}

// Deterministic, no headless page needed -- "wingman-network" custom events
// (see content-script.ts's fetch/XHR patch) are already plain JSON on the
// raw event stream, same shape as wingman-comment's intent extraction below.
function extractNetwork(events: RrwebEvent[]): NetworkEntry[] {
  const base = events[0]?.timestamp ?? 0;
  return events
    .filter((e) => e.type === 5 && e.data?.tag === "wingman-network")
    .map((e) => ({ offsetMs: (e.timestamp ?? base) - base, ...(e.data.payload as Omit<NetworkEntry, "offsetMs">) }));
}

export async function buildAgentData(events: RrwebEvent[]): Promise<AgentData> {
  const network = extractNetwork(events);
  if (events.length === 0) return { actions: [], states: {}, network };
  const points = pickInteresting(events);
  if (points.length === 0) return { actions: [], states: {}, network };

  const raw = await withReplayerPage((page) => page.evaluate(browserExtract, { events, points } as any));
  return { ...attachIntents(raw as ActionsAndStates, events), network };
}

// Runs inside the headless page: replays up to the requested offset and hands
// back the reconstructed document's HTML, for an agent that wants the actual
// rendered screen rather than the text summary from AgentState.
function browserRenderHtml({ events, offsetMs }: { events: RrwebEvent[]; offsetMs: number }): string {
  // @ts-expect-error rrweb UMD global, injected by addScriptTag
  const replayer = new window.rrweb.Replayer(events, { root: document.body, mouseTail: false, useVirtualDom: false, showWarning: false });
  replayer.pause(Math.max(0, offsetMs));
  return replayer.iframe.contentDocument?.documentElement.outerHTML ?? "";
}

// On-demand (not precomputed at save time, unlike actions/states -- this is
// an "only when needed" render, so the headless-Chromium cost is paid per
// request instead of bloating the sidecar .agent.json with an HTML snapshot
// per action).
export async function renderHtmlAtOffset(events: RrwebEvent[], offsetMs: number): Promise<string> {
  if (events.length === 0) return "";
  return withReplayerPage((page) => page.evaluate(browserRenderHtml, { events, offsetMs }));
}

// Attaches the AI's stated intent (wingman-comment) to whichever
// deterministic action happened closest to it in time. A recording with no
// AI-driven MCP calls just has no comments to attach -- every action still
// exists, only `intent` stays unset.
function attachIntents(data: ActionsAndStates, events: RrwebEvent[]): ActionsAndStates {
  const base = events[0]?.timestamp ?? 0;
  const intents = events
    .filter((e) => e.type === 5 && e.data?.tag === "wingman-comment")
    .map((e) => ({ offsetMs: (e.timestamp ?? base) - base, text: e.data?.payload?.text ?? "" }));
  if (intents.length === 0) return data;

  const actions = data.actions.map((a) => {
    let best: { text: string; dist: number } | null = null;
    for (const c of intents) {
      const dist = Math.abs(c.offsetMs - a.offsetMs);
      if (dist <= INTENT_WINDOW_MS && (!best || dist < best.dist)) best = { text: c.text, dist };
    }
    return best ? { ...a, intent: best.text } : a;
  });
  return { ...data, actions };
}

// Programmatic before/after comparison -- section 11 of the spec. Pure set
// diff on the two precomputed states, no re-inspection of the recording.
export function diffStates(before: AgentState, after: AgentState): { added: string[]; removed: string[]; changed: Array<{ field: string; before: string; after: string }> } {
  const setDiff = (a: string[], b: string[]) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
  const headings = setDiff(before.headings, after.headings);
  const buttons = setDiff(before.buttons, after.buttons);
  const beforeInputs = new Map(before.inputs.map((i) => [i.label, i.value]));
  const changed: Array<{ field: string; before: string; after: string }> = [];
  for (const inp of after.inputs) {
    const prev = beforeInputs.get(inp.label);
    if (prev !== undefined && prev !== inp.value) changed.push({ field: inp.label, before: prev, after: inp.value });
  }
  return { added: [...headings.added, ...buttons.added], removed: [...headings.removed, ...buttons.removed], changed };
}

// One-line, deterministic "what happened" summary for an action page (e.g.
// "Rows per page: 10 → 25") -- picks the most notable change between the
// state right before this action and right after it. No LLM: just the
// first entry out of diffStates, in priority order (a changed value is more
// informative than something merely appearing/disappearing).
export function summarizeStateChange(before: AgentState | undefined, after: AgentState): string {
  if (!before) return "";
  const diff = diffStates(before, after);
  if (diff.changed.length) return `${diff.changed[0].field}: ${diff.changed[0].before} → ${diff.changed[0].after}`;
  if (diff.added.length) return `"${diff.added[0]}" appeared`;
  if (diff.removed.length) return `"${diff.removed[0]}" disappeared`;
  return "";
}

// Full-text search over action labels/intent + visible state text -- section
// 13. Linear scan: recordings are, at most, a few hundred actions.
export function searchAgentData(data: AgentData, query: string): Array<{ type: "action" | "state" | "network"; id: string; offsetMs: number; match: string }> {
  const needle = query.toLowerCase();
  const results: Array<{ type: "action" | "state" | "network"; id: string; offsetMs: number; match: string }> = [];
  for (const a of data.actions) {
    const hay = `${a.target.label} ${a.intent ?? ""}`.toLowerCase();
    if (needle && hay.includes(needle)) results.push({ type: "action", id: a.id, offsetMs: a.offsetMs, match: a.target.label || a.intent || "" });
  }
  for (const a of data.actions) {
    const state = data.states[a.id];
    if (!state) continue;
    for (const t of [...state.headings, ...state.buttons]) {
      if (t.toLowerCase().includes(needle)) results.push({ type: "state", id: a.id, offsetMs: a.offsetMs, match: t });
    }
  }
  // Matches on URL only -- request/response bodies and headers are never
  // captured (see content-script.ts's network patch), so there's nothing
  // else to search here.
  for (const n of data.network) {
    if (needle && n.url.toLowerCase().includes(needle)) results.push({ type: "network", id: "", offsetMs: n.offsetMs, match: `${n.method} ${n.status || "ERR"} ${n.url}` });
  }
  return results;
}

// Self-check: run with `node dist/agent-pipeline.js` after building. Builds
// a minimal synthetic rrweb stream (a full snapshot with one button, then a
// click on it) and asserts the deterministic pipeline resolves the click to
// that button's label with no LLM and no wingman-comment involved.
if (require.main === module) {
  void (async () => {
    const now = Date.now();
    const buttonId = 5;
    const events: RrwebEvent[] = [
      { type: 4, timestamp: now, data: { href: "http://example.test/", width: 800, height: 600 } },
      {
        type: 2,
        timestamp: now,
        data: {
          node: {
            type: 0,
            childNodes: [
              {
                type: 2,
                tagName: "html",
                attributes: {},
                id: 1,
                childNodes: [
                  {
                    type: 2,
                    tagName: "body",
                    attributes: {},
                    id: 2,
                    childNodes: [{ type: 2, tagName: "button", attributes: {}, id: buttonId, childNodes: [{ type: 3, textContent: "Save", id: 6 }] }],
                  },
                ],
              },
            ],
          },
          initialOffset: { top: 0, left: 0 },
        },
      },
      { type: INCREMENTAL_SNAPSHOT, timestamp: now + 500, data: { source: SOURCE_MOUSE_INTERACTION, type: MOUSE_CLICK, id: buttonId, x: 10, y: 10 } },
    ];
    const data = await buildAgentData(events);
    console.assert(data.actions.length === 1, `expected 1 action, got ${data.actions.length}`);
    console.assert(data.actions[0].type === "click", `expected click, got ${data.actions[0].type}`);
    console.assert(data.actions[0].target.label === "Save", `expected label "Save", got "${data.actions[0].target.label}"`);
    console.log("agent-pipeline self-test passed:", JSON.stringify(data.actions[0]));
  })();
}
