/* global browserAgent */

function chip(el, ok, textOk, textBad) {
  el.textContent = ok ? textOk : textBad;
  el.className = "status-chip " + (ok ? "ok" : "bad");
}

function render(status) {
  const extOk = status.core.extensionConnected;
  chip(document.getElementById("ext-status"), extOk, "Connected", "Not connected");
  document.getElementById("ext-hint").innerHTML = extOk
    ? "Wingman can see and control this browser."
    : `Not installed yet. Click Install, enable Developer Mode, then Load Unpacked from:<br><code>${status.extensionDistPath}</code>`;
  document.getElementById("btn-install-ext").textContent = extOk ? "Reinstall" : "Install";

  const claudeConfigured = status.claude.configured;
  chip(document.getElementById("claude-integration"), claudeConfigured, "Connected", status.claude.detected ? "Not connected" : "Not installed");
  const btnConnectClaude = document.getElementById("btn-connect-claude");
  btnConnectClaude.textContent = claudeConfigured ? "Retry" : "Connect";
  btnConnectClaude.classList.toggle("secondary", claudeConfigured);
  btnConnectClaude.disabled = !status.claude.detected;
  document.getElementById("btn-disconnect-claude").style.display = claudeConfigured ? "" : "none";
  const claudeHint = status.claude.detected ? "Detected on this Mac." : "Claude Desktop isn't installed.";
  document.getElementById("claude-hint").innerHTML = claudeConfigured
    ? `${claudeHint} <span class="footnote">Restart Claude Desktop to pick up changes.</span>`
    : claudeHint;

  const codexConfigured = status.codex.configured;
  chip(document.getElementById("codex-integration"), codexConfigured, "Connected", status.codex.installed ? "Not connected" : "Not installed");
  const btnConnectCodex = document.getElementById("btn-connect-codex");
  btnConnectCodex.textContent = codexConfigured ? "Retry" : "Connect";
  btnConnectCodex.classList.toggle("secondary", codexConfigured);
  btnConnectCodex.disabled = !status.codex.installed;
  document.getElementById("btn-disconnect-codex").style.display = codexConfigured ? "" : "none";
  const codexHint = status.codex.installed ? `Detected (${status.codex.kind || "CLI"}).` : "Codex isn't installed.";
  document.getElementById("codex-hint").innerHTML = codexConfigured
    ? `${codexHint} <span class="footnote">Restart Codex to pick up changes.</span>`
    : codexHint;

  const connectedCount = [extOk, status.claude.configured, status.codex.configured].filter(Boolean).length;
  document.getElementById("conn-count").textContent = `${connectedCount}/3 connected`;

  const allGood = extOk && (status.claude.configured || status.codex.configured);
  const dot = document.getElementById("global-dot");
  const text = document.getElementById("global-text");
  if (allGood) {
    dot.className = "dot ok";
    text.textContent = "Ready";
  } else if (extOk) {
    dot.className = "dot warn";
    text.textContent = "No agent connected";
  } else {
    dot.className = "dot bad";
    text.textContent = "Setup needed";
  }
}

async function refresh() {
  const status = await browserAgent.getStatus();
  render(status);
}

document.getElementById("btn-install-ext").addEventListener("click", () => {
  browserAgent.openExtensionsPage();
  browserAgent.revealExtensionDir();
});

document.getElementById("btn-connect-claude").addEventListener("click", async () => {
  await browserAgent.connectClaude();
  refresh();
});
document.getElementById("btn-disconnect-claude").addEventListener("click", async () => {
  await browserAgent.disconnectClaude();
  refresh();
});
document.getElementById("btn-connect-codex").addEventListener("click", async () => {
  await browserAgent.connectCodex();
  refresh();
});
document.getElementById("btn-disconnect-codex").addEventListener("click", async () => {
  await browserAgent.disconnectCodex();
  refresh();
});
document.getElementById("btn-open-logs").addEventListener("click", () => browserAgent.openLogs());

function renderActivity(event) {
  if (event.action !== "download.video") return;
  const key = event.id || "default";
  const panel = document.getElementById("activity-panel");
  const list = document.getElementById("activity-list");
  panel.style.display = "";

  let row = document.getElementById(`activity-row-${key}`);
  if (!row) {
    row = document.createElement("div");
    row.className = "activity-row";
    row.id = `activity-row-${key}`;
    row.innerHTML = `
      <div class="progress-track" style="display: none"><div class="progress-fill"></div></div>
      <p class="activity-line"></p>
      <button class="link activity-open" style="display: none">Show in Finder</button>
    `;
    list.prepend(row);
  }

  const progress = row.querySelector(".progress-track");
  const progressFill = row.querySelector(".progress-fill");
  const line = row.querySelector(".activity-line");
  const openBtn = row.querySelector(".activity-open");

  const progressMatch = event.status === "success" && event.detail && event.detail.match(/^Capturing replay video: (\d+)%$/);
  const isFilePath = event.status === "success" && event.detail && event.detail.startsWith("/");

  progress.style.display = progressMatch ? "" : "none";
  if (progressMatch) progressFill.style.width = `${progressMatch[1]}%`;

  line.textContent = event.status === "error" ? `Video download failed: ${event.detail}` : isFilePath ? `Saved to ${event.detail}` : event.detail || "";
  openBtn.style.display = isFilePath ? "" : "none";
  openBtn.onclick = isFilePath ? () => browserAgent.revealFile(event.detail) : null;
}

browserAgent.onStatus(render);
browserAgent.onActivity((event) => {
  renderActivity(event);
  refresh();
});

refresh();
setInterval(refresh, 4000);
