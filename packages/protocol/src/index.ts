// Shared protocol types used by every process: extension, native-host,
// companion-core, mcp-adapter. Nothing here should depend on Node or Chrome
// APIs so it can be imported from any of them.

export const NATIVE_HOST_NAME = "com.browseragent.companion";
// Fixed extension ID produced by the dev keypair in apps/extension/dev-keys
// (see manifest.json's "key" field). Because MV3 lets an unpacked extension
// declare a stable "key", the ID never changes across reloads, so the
// Native Messaging host manifest's allowed_origins can be generated once
// with no manual "paste your extension ID" step.
export const EXTENSION_ID = "maeongoknbjmjhiodjomkldpgbpfkfak";
export const APP_DIR_NAME = "BrowserAgent";
export const SOCKET_FILE_NAME = "core.sock";
export const BROWSER_AGENT_MCP_NAME = "wingman";

export const REQUEST_TIMEOUT_MS = 10_000;
export const SCREENSHOT_TIMEOUT_MS = 20_000;
// Companion Core's local HTTP server (replay files, the Demoly upload panel's
// API, and recording status) -- fixed rather than ephemeral so both replay
// .html files and the extension can hardcode it. See companion-core's
// ensureStaticServer.
export const STATIC_SERVER_PORT = 47811;

export type ErrorCode =
  | "NO_ACTIVE_TAB"
  | "EXTENSION_DISCONNECTED"
  | "NATIVE_HOST_DISCONNECTED"
  | "COMPANION_NOT_RUNNING"
  | "STALE_ELEMENT"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_NOT_EDITABLE"
  | "UNSUPPORTED_PAGE"
  | "INVALID_URL"
  | "REQUEST_TIMEOUT"
  | "SCREENSHOT_FAILED"
  | "RECORDING_ALREADY_ACTIVE"
  | "RECORDING_NOT_ACTIVE"
  | "RECORDING_START_FAILED"
  | "EXPORT_FAILED"
  | "DEMOLY_NOT_CONNECTED"
  | "DEMOLY_UPLOAD_FAILED"
  | "UNKNOWN_ACTION"
  | "INTERNAL_ERROR";

export interface BrowserError {
  code: ErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Commands (id/action/params triple, per spec)
// ---------------------------------------------------------------------------

export type BrowserAction =
  | "browser.getTabs"
  | "browser.getPageInfo"
  | "browser.navigate"
  | "browser.click"
  | "browser.type"
  | "browser.scroll"
  | "browser.pressKey"
  | "browser.screenshot"
  | "recording.start"
  | "recording.stop"
  | "recording.status"
  | "demoly.getStatus"
  | "demoly.listWorkspaces"
  | "demoly.setWorkspace"
  | "demoly.listProjects"
  | "demoly.setProject"
  | "ping";

export interface BaseCommand<A extends BrowserAction, P> {
  id: string;
  action: A;
  params: P;
}

export type GetTabsCommand = BaseCommand<"browser.getTabs", Record<string, never>>;
export type GetPageInfoCommand = BaseCommand<"browser.getPageInfo", Record<string, never>>;
export type NavigateCommand = BaseCommand<"browser.navigate", { url: string }>;
export type ClickCommand = BaseCommand<"browser.click", { elementId: string; comment?: string }>;
export type TypeCommand = BaseCommand<"browser.type", { elementId: string; text: string; comment?: string }>;
export type ScrollCommand = BaseCommand<
  "browser.scroll",
  { direction: "up" | "down"; amount?: number; comment?: string }
>;
export type PressKeyCommand = BaseCommand<
  "browser.pressKey",
  { key: "Enter" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Backspace"; comment?: string }
>;
export type ScreenshotCommand = BaseCommand<"browser.screenshot", Record<string, never>>;
export type StartRecordingCommand = BaseCommand<"recording.start", Record<string, never>>;
export type StopRecordingCommand = BaseCommand<"recording.stop", Record<string, never>>;
export type RecordingStatusCommand = BaseCommand<"recording.status", Record<string, never>>;
export type PingCommand = BaseCommand<"ping", Record<string, never>>;

export type BrowserCommand =
  | GetTabsCommand
  | GetPageInfoCommand
  | NavigateCommand
  | ClickCommand
  | TypeCommand
  | ScrollCommand
  | PressKeyCommand
  | ScreenshotCommand
  | StartRecordingCommand
  | StopRecordingCommand
  | RecordingStatusCommand
  | PingCommand;

export interface BrowserResponseSuccess<T = unknown> {
  id: string;
  success: true;
  data: T;
}

export interface BrowserResponseFailure {
  id: string;
  success: false;
  error: BrowserError;
}

export type BrowserResponse<T = unknown> = BrowserResponseSuccess<T> | BrowserResponseFailure;

// ---------------------------------------------------------------------------
// Data shapes returned by specific commands
// ---------------------------------------------------------------------------

export interface TabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
}

export interface PageElement {
  id: string;
  tag: string;
  type?: string;
  role?: string | null;
  label: string | null;
  text: string;
  placeholder?: string;
  disabled: boolean;
}

export interface PageInfo {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}

export interface ScreenshotResult {
  // JPEG is used (not PNG) to stay well under Chrome Native Messaging's
  // 1MB host->extension message size limit on high-DPI displays.
  mimeType: "image/jpeg";
  base64: string;
}

export interface RecordingState {
  recording: boolean;
  // Set by Companion Core (not the extension) once the recorded session's
  // rrweb events have been fully written to disk as a viewable .html replay;
  // absent while a recording is in progress.
  path?: string;
  startedAt?: number;
  stoppedAt?: number;
}

// Pushed by the extension (via the native host, which forwards any JSON it
// receives verbatim) as rrweb DOM events are captured, independent of the
// command/response cycle above — there's no MCP client waiting on these.
export interface RecordingEventsEvent {
  type: "event";
  event: "recording.events";
  events: unknown[];
  done: boolean;
}

// Pushed by the extension when the on-page "Download video" button is
// clicked on any rrweb replay page (Wingman's own or a third party's, e.g.
// Demoly's, both detected generically by the presence of a `.replayer-wrapper`
// element -- see replay-detect.ts). Fire-and-forget: Companion Core captures
// and encodes the video entirely on its own via Playwright, so there's no
// command/response round trip and no per-frame streaming.
export interface DownloadVideoEvent {
  type: "event";
  event: "download.video";
  id: string;
  url: string;
}

// Pushed by the extension once it captures a Demoly login handshake on
// app.demoly.dev (see apps/extension/src/demoly-handshake.ts); Companion Core
// persists the resulting token pair so later `demoly.*` MCP commands and the
// replay page's upload panel can call Demoly's API without the extension.
export interface DemolyAuthEvent {
  type: "event";
  event: "demoly.auth";
  apiBase: string;
  accessToken: string;
  refreshToken: string;
  user?: unknown;
  organization?: { _id?: string; id?: string; name?: string };
}

// ---------------------------------------------------------------------------
// Companion Core <-> MCP Adapter socket envelope
// (native-host <-> core exchanges BrowserCommand/BrowserResponse directly,
// see packages/native-host)
// ---------------------------------------------------------------------------

export type ClientName = "claude" | "codex" | "gui" | "unknown";

export interface McpHello {
  type: "hello";
  role: "mcp";
  client: ClientName;
}

export interface McpCommandEnvelope {
  type: "command";
  id: string;
  action: BrowserAction;
  params: unknown;
}

export interface McpResponseEnvelope {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: BrowserError;
}

export type McpSocketMessage = McpHello | McpCommandEnvelope | McpResponseEnvelope;

export interface NativeHostHello {
  type: "hello";
  role: "native-host";
}

// ---------------------------------------------------------------------------
// Companion GUI activity events (core -> electron renderer, in-process)
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  timestamp: number;
  client: ClientName;
  action: string;
  status: "success" | "error";
  detail?: string;
  // Distinguishes concurrent instances of the same action (e.g. two
  // simultaneous "download.video" captures) so the companion UI can track
  // each one's own progress instead of one clobbering the other's.
  id?: string;
}

export interface CoreStatus {
  extensionConnected: boolean;
  nativeHostConnected: boolean;
  connectedClients: ClientName[];
  recording: RecordingState;
  currentTab: { title: string; url: string } | null;
  activity: ActivityEvent[];
}

export function makeError(code: ErrorCode, message: string): BrowserError {
  return { code, message };
}

// NOTE: filesystem path helpers (Node-only: os/path) intentionally live in
// ./paths and are NOT re-exported here, so this entry point stays safe to
// bundle into the Chrome extension (service worker / browser environment).
// Node processes should import "@browser-agent/protocol/paths" directly.
