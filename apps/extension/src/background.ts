import {
  NATIVE_HOST_NAME,
  STATIC_SERVER_PORT,
  makeError,
  type BrowserCommand,
  type BrowserResponse,
  type TabInfo,
  type RecordingState,
} from "@browser-agent/protocol";

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let recording: RecordingState = { recording: false };

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[EXTENSION] ${line}`);
}

async function setBadgeConnected(connected: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: connected ? "" : "!" });
  await chrome.storage.local.set({ companionConnected: connected });
}

function connect(): void {
  log("connecting to native host " + NATIVE_HOST_NAME);
  const p = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port = p;

  p.onMessage.addListener((message: BrowserCommand) => {
    handleCommand(message)
      .then((response) => p.postMessage(response))
      .catch((err) => p.postMessage({ id: message.id, success: false, error: makeError("INTERNAL_ERROR", String(err)) }));
  });

  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    log(`native host disconnected${err ? `: ${err.message}` : ""}`);
    port = null;
    void setBadgeConnected(false);
    scheduleReconnect();
  });

  void setBadgeConnected(true);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

async function ensureContentScriptAndSend(tabId: number, request: Record<string, unknown>): Promise<any> {
  const send = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { target: "browser-agent-content", ...request }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });

  try {
    return await send();
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    } catch (err) {
      throw Object.assign(new Error("UNSUPPORTED_PAGE"), { code: "UNSUPPORTED_PAGE" });
    }
    return send();
  }
}

// Demoly's own extension has no fixed audience check on this exchange (see
// content/handshake.js + background/service-worker.js in their extension) --
// it just trades a short-lived handshakeToken minted by app.demoly.dev for a
// token pair, so any extension that captures the same broadcast can redeem
// it. Companion Core stores the resulting tokens (see demoly.auth event).
const DEMOLY_API_BASE = "https://api.demoly.dev/api/v1";

async function exchangeDemolyHandshake(handshakeToken: string, apiBase?: string): Promise<void> {
  const base = apiBase || DEMOLY_API_BASE;
  const res = await fetch(`${base}/auth/extension-token/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handshakeToken }),
  });
  if (!res.ok) throw new Error(`Demoly handshake exchange failed: ${res.status}`);
  const data = await res.json();
  port?.postMessage({
    type: "event",
    event: "demoly.auth",
    apiBase: base,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: data.user,
    organization: data.organization,
  });
  log("Demoly account connected");
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    throw Object.assign(new Error("No active tab"), { code: "NO_ACTIVE_TAB" });
  }
  return tab;
}

function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//.test(url);
}

// chrome.tabCapture/getUserMedia need a real user gesture (activeTab
// invocation) Chrome will never grant to an MCP/native-messaging-driven
// call, and screenshot-based video is capped at Chrome's ~2fps
// captureVisibleTab quota no matter how it's composited. Instead the content
// script uses rrweb to record DOM mutations + interaction events directly —
// no pixels, no fps ceiling, no gesture required (same approach Demoly's
// extension uses). Companion Core assembles the event stream into a
// self-contained replay .html file; there's no video encoding step at all.
async function startRecording(): Promise<{ ok: true } | { ok: false; code: "RECORDING_ALREADY_ACTIVE" | "UNSUPPORTED_PAGE"; error: string }> {
  if (recording.recording) return { ok: false, code: "RECORDING_ALREADY_ACTIVE", error: "Recording is already active." };

  const tab = await getActiveTab();
  if (!isSupportedUrl(tab.url)) return { ok: false, code: "UNSUPPORTED_PAGE", error: `Cannot record ${tab.url}` };

  await ensureContentScriptAndSend(tab.id!, { op: "recording.begin" });
  // Network patching must run in the page's MAIN world (see network-patch.ts)
  // -- a content script's window is a separate isolated-world global.
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: "MAIN", files: ["network-patch.js"] });
  recording = { recording: true, startedAt: Date.now() };
  await chrome.storage.local.set({ recording });
  log("Recording started");
  return { ok: true };
}

async function stopRecording(): Promise<{ ok: true } | { ok: false; code: "RECORDING_NOT_ACTIVE"; error: string }> {
  if (!recording.recording) return { ok: false, code: "RECORDING_NOT_ACTIVE", error: "Recording is not active." };

  const tab = await getActiveTab();
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: "MAIN", files: ["network-patch.js"] });
  await ensureContentScriptAndSend(tab.id!, { op: "recording.end" });
  recording = { recording: false, startedAt: recording.startedAt, stoppedAt: Date.now() };
  await chrome.storage.local.set({ recording });
  log("Recording stopped");
  return { ok: true };
}

// The extension only knows the on/off flag (see the RecordingState comment
// above); the saved .html only exists once Companion Core finishes writing
// the buffered rrweb events out to disk (handleNativeHostEvent), so poll its
// local HTTP server briefly rather than guessing when that's done.
async function waitForSavedRecording(after: number): Promise<{ path: string; url: string } | null> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${STATIC_SERVER_PORT}/recording/status`);
      const data = (await res.json()) as RecordingState;
      if (data.path && (data.stoppedAt ?? 0) >= after) {
        // "/agent/recordings/<id>" rather than the raw filename -- this is the
        // URL meant to be handed to a person or an AI agent (see
        // companion-core's handleStaticRequest), the filename route still
        // works underneath.
        const id = data.path.replace(/^.*[\\/]recording-/, "").replace(/\.html$/, "");
        return { path: data.path, url: `http://127.0.0.1:${STATIC_SERVER_PORT}/agent/recordings/${id}` };
      }
    } catch {
      /* Companion Core's static server may not be up yet -- keep polling */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function handleCommand(cmd: BrowserCommand): Promise<BrowserResponse> {
  try {
    switch (cmd.action) {
      case "ping":
        return { id: cmd.id, success: true, data: { pong: true } };

      case "browser.getTabs": {
        const tabs = await chrome.tabs.query({});
        const data: TabInfo[] = tabs.map((t) => ({
          id: t.id ?? -1,
          windowId: t.windowId ?? -1,
          title: t.title ?? "",
          url: t.url ?? "",
          active: t.active ?? false,
        }));
        return { id: cmd.id, success: true, data };
      }

      case "browser.getPageInfo": {
        const tab = await getActiveTab();
        if (!isSupportedUrl(tab.url)) {
          return { id: cmd.id, success: false, error: makeError("UNSUPPORTED_PAGE", `Cannot inspect ${tab.url}`) };
        }
        const result = await ensureContentScriptAndSend(tab.id!, { op: "getPageInfo" });
        await chrome.storage.local.set({ currentTab: { title: tab.title, url: tab.url } });
        return toResponse(cmd.id, result);
      }

      case "browser.navigate": {
        const url = cmd.params.url;
        if (!/^https?:\/\//.test(url)) {
          return { id: cmd.id, success: false, error: makeError("INVALID_URL", "Only http:// and https:// URLs are allowed.") };
        }
        const tab = await getActiveTab();
        await chrome.tabs.update(tab.id!, { url });
        return { id: cmd.id, success: true, data: { navigated: true, url } };
      }

      case "browser.click": {
        const tab = await getActiveTab();
        if (!isSupportedUrl(tab.url)) return { id: cmd.id, success: false, error: makeError("UNSUPPORTED_PAGE", `Cannot interact with ${tab.url}`) };
        const result = await ensureContentScriptAndSend(tab.id!, {
          op: "click",
          elementId: cmd.params.elementId,
          recording: recording.recording,
          comment: cmd.params.comment,
        });
        return toResponse(cmd.id, result);
      }

      case "browser.type": {
        const tab = await getActiveTab();
        if (!isSupportedUrl(tab.url)) return { id: cmd.id, success: false, error: makeError("UNSUPPORTED_PAGE", `Cannot interact with ${tab.url}`) };
        const result = await ensureContentScriptAndSend(tab.id!, {
          op: "type",
          elementId: cmd.params.elementId,
          text: cmd.params.text,
          recording: recording.recording,
          comment: cmd.params.comment,
        });
        return toResponse(cmd.id, result);
      }

      case "browser.scroll": {
        const tab = await getActiveTab();
        if (!isSupportedUrl(tab.url)) return { id: cmd.id, success: false, error: makeError("UNSUPPORTED_PAGE", `Cannot interact with ${tab.url}`) };
        const result = await ensureContentScriptAndSend(tab.id!, {
          op: "scroll",
          direction: cmd.params.direction,
          amount: cmd.params.amount ?? 600,
          recording: recording.recording,
          comment: cmd.params.comment,
        });
        return toResponse(cmd.id, result);
      }

      case "browser.pressKey": {
        const tab = await getActiveTab();
        if (!isSupportedUrl(tab.url)) return { id: cmd.id, success: false, error: makeError("UNSUPPORTED_PAGE", `Cannot interact with ${tab.url}`) };
        const result = await ensureContentScriptAndSend(tab.id!, {
          op: "pressKey",
          key: cmd.params.key,
          recording: recording.recording,
          comment: cmd.params.comment,
        });
        return toResponse(cmd.id, result);
      }

      case "browser.screenshot": {
        const tab = await getActiveTab();
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
        const base64 = dataUrl.split(",")[1] ?? "";
        return { id: cmd.id, success: true, data: { mimeType: "image/jpeg", base64 } };
      }

      case "recording.start": {
        const result = await startRecording();
        return result.ok
          ? { id: cmd.id, success: true, data: recording }
          : { id: cmd.id, success: false, error: makeError(result.code, result.error) };
      }

      case "recording.stop": {
        const result = await stopRecording();
        return result.ok
          ? { id: cmd.id, success: true, data: recording }
          : { id: cmd.id, success: false, error: makeError(result.code, result.error) };
      }

      case "recording.status":
        return { id: cmd.id, success: true, data: recording };

      default: {
        const unknownCmd = cmd as { id: string; action: string };
        return { id: unknownCmd.id, success: false, error: makeError("UNKNOWN_ACTION", `Unknown action: ${unknownCmd.action}`) };
      }
    }
  } catch (err: any) {
    const code = err?.code ?? "INTERNAL_ERROR";
    return { id: cmd.id, success: false, error: makeError(code, err?.message ?? String(err)) };
  }
}

function toResponse(id: string, pageResult: { ok: boolean; data?: unknown; code?: string; message?: string }): BrowserResponse {
  if (!pageResult) return { id, success: false, error: makeError("INTERNAL_ERROR", "No response from content script") };
  if (pageResult.ok) return { id, success: true, data: pageResult.data };
  return { id, success: false, error: makeError((pageResult.code as any) ?? "INTERNAL_ERROR", pageResult.message ?? "Unknown content script error") };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === "RECORDING_EVENTS") {
    port?.postMessage({ type: "event", event: "recording.events", events: request.events, done: request.done });
    return false;
  }
  if (request?.type === "POPUP_START_RECORDING") {
    startRecording().then((result) => sendResponse(result));
    return true;
  }
  if (request?.type === "POPUP_STOP_RECORDING") {
    const stoppedAt = Date.now();
    stopRecording().then(async (result) => {
      if (!result.ok) {
        sendResponse(result);
        return;
      }
      const saved = await waitForSavedRecording(stoppedAt);
      if (saved) await chrome.tabs.create({ url: saved.url });
      sendResponse({ ...result, ...saved });
    });
    return true;
  }
  if (request?.type === "REQUEST_DOWNLOAD_VIDEO") {
    // Fire-and-forget: Companion Core captures the page independently via
    // Playwright, so the extension isn't involved once this is sent.
    port?.postMessage({ type: "event", event: "download.video", id: request.id, url: request.url });
    return false;
  }
  if (request?.type === "DEMOLY_HANDSHAKE_TOKEN") {
    exchangeDemolyHandshake(request.handshakeToken, request.apiBase).catch((err) => log(`demoly handshake failed: ${err}`));
    return false;
  }
  if (request?.type === "POPUP_GET_STATE") {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({
        companionConnected: port !== null,
        recording,
        currentTab: tabs[0] ? { title: tabs[0].title, url: tabs[0].url } : null,
      });
    })();
    return true;
  }
  return false;
});

connect();
