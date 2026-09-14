// Auto-injected (see manifest.json content_scripts) on Wingman's own replay
// pages (served from the local static server) and Demoly's hosted replay
// pages -- both render an rrweb-player, which always mounts a
// `.replayer-wrapper` element. That's the only signal we rely on: it works
// identically regardless of whose player instance is on the page, so this
// script needs no knowledge of either product's internals.
export {};

if (!(window as any).__wingmanReplayDetectInjected) {
  (window as any).__wingmanReplayDetectInjected = true;

  let host: HTMLElement | null = null;

  function showButton(): void {
    if (host) return;
    host = document.createElement("div");
    host.style.all = "initial";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        #btn {
          position: fixed; left: 18px; bottom: 18px; z-index: 2147483647;
          display: flex; align-items: center; gap: 6px; cursor: pointer;
          background: #101828; color: #fff; border: none; border-radius: 999px;
          padding: 9px 16px; font: 600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 4px 16px rgba(16,24,40,0.35); user-select: none;
        }
        #btn:hover { filter: brightness(1.15); }
        #btn:disabled { opacity: 0.7; cursor: default; }
      </style>
      <button id="btn">Download video</button>
    `;
    const btn = shadow.getElementById("btn") as HTMLButtonElement;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Started, check the Wingman Companion app";
      chrome.runtime.sendMessage({ type: "REQUEST_DOWNLOAD_VIDEO", id: crypto.randomUUID(), url: location.href });
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "Download video";
      }, 4000);
    });
    document.documentElement.appendChild(host);
  }

  // The player mounts asynchronously after this script runs, so poll briefly
  // instead of assuming it's already there.
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (document.querySelector(".replayer-wrapper")) {
      showButton();
      clearInterval(timer);
    } else if (attempts >= 20) {
      clearInterval(timer);
    }
  }, 500);
}
