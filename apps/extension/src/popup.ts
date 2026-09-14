function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let isRecording = false;
let stickyHintUntil = 0;

function shortUrl(url: string | undefined): string {
  if (!url) return "-";
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

async function refresh(): Promise<void> {
  chrome.runtime.sendMessage({ type: "POPUP_GET_STATE" }, (state) => {
    if (!state) return;
    const companionOk = !!state.companionConnected;
    const companionBadge = el("companion");
    companionBadge.innerHTML = '<span class="dot"></span>' + (companionOk ? "Connected" : "Not connected");
    companionBadge.className = "badge " + (companionOk ? "ok" : "bad");

    el("page").textContent = shortUrl(state.currentTab?.url);
    el("page").title = state.currentTab?.url ?? "";

    isRecording = !!state.recording?.recording;
    const btn = el("btn-record") as HTMLButtonElement;
    btn.classList.toggle("is-recording", isRecording);
    btn.disabled = !companionOk;
    el("btn-record-label").textContent = isRecording ? "Stop Recording" : "Start Recording";
    if (Date.now() > stickyHintUntil) {
      el("recording-hint").textContent = !companionOk
        ? "Open the Wingman app to connect."
        : isRecording
        ? "Recording this tab's clicks, typing and navigation."
        : "Captures clicks & typing as a replay, not a video.";
    }
  });
}

function onRecordClick(): void {
  const errorEl = el("error");
  errorEl.textContent = "";
  errorEl.classList.remove("visible");
  const btn = el("btn-record") as HTMLButtonElement;
  btn.disabled = true;
  const wasRecording = isRecording;
  const type = isRecording ? "POPUP_STOP_RECORDING" : "POPUP_START_RECORDING";
  chrome.runtime.sendMessage({ type }, (result) => {
    if (!result?.ok) {
      errorEl.textContent = result?.error ?? "Unknown error";
      errorEl.classList.add("visible");
      refresh();
      return;
    }
    if (wasRecording) {
      stickyHintUntil = Date.now() + 4000;
      el("recording-hint").textContent = result.url ? "Saved, opened the replay in a new tab." : "Saved, but it took too long to confirm. Check the companion app.";
    }
    refresh();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();
  el("btn-record").addEventListener("click", onRecordClick);
});
