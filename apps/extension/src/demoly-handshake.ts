// Mirrors Demoly's own content/handshake.js broadcast protocol: their web
// app announces a login handshake via a page-wide (untargeted) postMessage,
// which is picked up by *any* listening content script, not just Demoly's
// own extension. This lets Wingman capture the same handshake and mint its
// own Demoly token pair, independent of whether Demoly's extension is
// installed (see background.ts's exchangeDemolyHandshake).
(() => {
  window.postMessage({ type: "DEMOLY_EXTENSION_INSTALLED", version: "1.0.0" }, "*");

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const { type, handshakeToken, apiBase } = event.data as { type?: string; handshakeToken?: string; apiBase?: string };
    if (type === "DEMOLY_CONNECT" && handshakeToken) {
      chrome.runtime.sendMessage({ type: "DEMOLY_HANDSHAKE_TOKEN", handshakeToken, apiBase });
    }
  });
})();
