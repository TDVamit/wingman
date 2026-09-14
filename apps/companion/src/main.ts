import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import { CompanionCore } from "@browser-agent/companion-core";
import type { BrowserAction, CoreStatus } from "@browser-agent/protocol";
import { coreLogPath, appSupportDir } from "@browser-agent/protocol/dist/paths";
import { installNativeMessagingHost, isNativeMessagingHostInstalled } from "./setup/native-messaging";
import { detectChrome, openChromeExtensionsPage, revealExtensionBuildDir, getExtensionDistPath } from "./setup/chrome-extension";
import { detectClaude, isClaudeConfigured, configureClaude, removeClaudeConfiguration } from "./setup/claude-integration";
import { detectCodex, isCodexConfigured, configureCodex, removeCodexConfiguration } from "./setup/codex-integration";

const core = new CompanionCore();
let win: BrowserWindow | null = null;

function log(line: string): void {
  const msg = `[CORE] ${new Date().toISOString()} ${line}\n`;
  try {
    fs.mkdirSync(appSupportDir(), { recursive: true });
    fs.appendFileSync(coreLogPath(), msg);
  } catch {
    /* best effort */
  }
  // eslint-disable-next-line no-console
  console.log(msg.trim());
}

function fullStatus() {
  const coreStatus: CoreStatus = core.getStatus();
  return {
    core: coreStatus,
    chrome: { detected: detectChrome() },
    nativeMessaging: { installed: isNativeMessagingHostInstalled() },
    claude: { detected: detectClaude(), configured: isClaudeConfigured() },
    codex: { ...detectCodex(), configured: isCodexConfigured() },
    extensionDistPath: getExtensionDistPath(),
  };
}

function pushStatus(): void {
  win?.webContents.send("status", fullStatus());
}

function createWindow(): void {
  nativeTheme.themeSource = "light";
  win = new BrowserWindow({
    width: 480,
    height: 680,
    resizable: true,
    backgroundColor: "#f4f7fc",
    icon: path.join(__dirname, "..", "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));
}

app.whenReady().then(() => {
  // BrowserWindow's `icon` option only affects Windows/Linux; running
  // unpackaged via `electron .` on macOS shows Electron's default dock icon
  // unless set explicitly here (the packaged .app instead gets its icon
  // from `icon.icns` via @electron/packager, set in package.js).
  if (process.platform === "darwin") {
    app.dock?.setIcon(path.join(__dirname, "..", "icons", "icon.png"));
  }

  core.start();
  core.on("status", pushStatus);
  core.on("activity", (event) => win?.webContents.send("activity", event));

  try {
    const result = installNativeMessagingHost();
    log(`native messaging host registered at ${result.path}`);
  } catch (err) {
    log(`failed to register native messaging host: ${String(err)}`);
  }

  createWindow();
  pushStatus();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  core.stop();
  if (process.platform !== "darwin") app.quit();
});

// -------------------------------------------------------------------------
// IPC surface consumed by ui/renderer.js via preload.ts
// -------------------------------------------------------------------------

ipcMain.handle("get-status", () => fullStatus());

ipcMain.handle("open-extensions-page", () => {
  openChromeExtensionsPage();
});

ipcMain.handle("reveal-extension-dir", () => {
  revealExtensionBuildDir();
});

ipcMain.handle("open-logs", () => {
  shell.openPath(appSupportDir());
});

ipcMain.handle("reveal-file", (_e, filePath: string) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("connect-claude", () => {
  const res = configureClaude();
  log("[CLAUDE-SETUP] configured browser-agent MCP server");
  pushStatus();
  return res;
});

ipcMain.handle("disconnect-claude", () => {
  const res = removeClaudeConfiguration();
  log("[CLAUDE-SETUP] removed browser-agent MCP server");
  pushStatus();
  return res;
});

ipcMain.handle("connect-codex", () => {
  try {
    const res = configureCodex();
    log("[CODEX-SETUP] configured browser-agent MCP server");
    pushStatus();
    return { ok: true, ...res };
  } catch (err) {
    log(`[CODEX-SETUP] failed: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("disconnect-codex", () => {
  const res = removeCodexConfiguration();
  log("[CODEX-SETUP] removed browser-agent MCP server");
  pushStatus();
  return { ok: true, ...res };
});

ipcMain.handle("send-command", async (_evt, action: BrowserAction, params: unknown) => {
  return core.sendCommand(action, params, "gui");
});
