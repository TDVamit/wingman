import { contextBridge, ipcRenderer } from "electron";
import type { BrowserAction } from "@browser-agent/protocol";

contextBridge.exposeInMainWorld("browserAgent", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  openExtensionsPage: () => ipcRenderer.invoke("open-extensions-page"),
  revealExtensionDir: () => ipcRenderer.invoke("reveal-extension-dir"),
  openLogs: () => ipcRenderer.invoke("open-logs"),
  revealFile: (filePath: string) => ipcRenderer.invoke("reveal-file", filePath),
  connectClaude: () => ipcRenderer.invoke("connect-claude"),
  disconnectClaude: () => ipcRenderer.invoke("disconnect-claude"),
  connectCodex: () => ipcRenderer.invoke("connect-codex"),
  disconnectCodex: () => ipcRenderer.invoke("disconnect-codex"),
  sendCommand: (action: BrowserAction, params: unknown) => ipcRenderer.invoke("send-command", action, params),
  onStatus: (cb: (status: unknown) => void) => ipcRenderer.on("status", (_e, s) => cb(s)),
  onActivity: (cb: (event: unknown) => void) => ipcRenderer.on("activity", (_e, ev) => cb(ev)),
});
