#!/usr/bin/env node
// Chrome Native Messaging host. Spawned by Chrome when the extension calls
// chrome.runtime.connectNative(). Lives exactly as long as that port does.
//
// stdout carries ONLY Chrome Native Messaging framed protocol bytes.
// All logging goes to stderr + a log file.
import * as net from "net";
import * as fs from "fs";
import type { BrowserResponse } from "@browser-agent/protocol";
import { makeError } from "@browser-agent/protocol";
import { socketPath, nativeHostLogPath, appSupportDir } from "@browser-agent/protocol/dist/paths";

function log(line: string): void {
  const msg = `[NATIVE] ${new Date().toISOString()} ${line}\n`;
  try {
    fs.mkdirSync(appSupportDir(), { recursive: true });
    fs.appendFileSync(nativeHostLogPath(), msg);
  } catch {
    // best effort
  }
  process.stderr.write(msg);
}

// ---------------------------------------------------------------------------
// Native Messaging framing: 4-byte native-endian length prefix + UTF-8 JSON.
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
// ---------------------------------------------------------------------------

let inputBuffer = Buffer.alloc(0);

function handleStdinChunk(chunk: Buffer, onMessage: (msg: unknown) => void): void {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  for (;;) {
    if (inputBuffer.length < 4) return;
    const length = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + length) return;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    try {
      onMessage(JSON.parse(payload.toString("utf8")));
    } catch (err) {
      log(`failed to parse message from extension: ${String(err)}`);
    }
  }
}

function writeToChrome(message: unknown): void {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// ---------------------------------------------------------------------------
// Unix socket connection to Companion Core
// ---------------------------------------------------------------------------

let coreSocket: net.Socket | null = null;
let socketBuffer = "";
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function connectToCore(): void {
  const sock = net.createConnection(socketPath());
  coreSocket = sock;

  sock.on("connect", () => {
    log("connected to companion core");
    sock.write(JSON.stringify({ type: "hello", role: "native-host" }) + "\n");
  });

  sock.on("data", (chunk) => {
    socketBuffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = socketBuffer.indexOf("\n")) >= 0) {
      const line = socketBuffer.slice(0, idx);
      socketBuffer = socketBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line) as BrowserResponse;
        writeToChrome(response);
      } catch (err) {
        log(`failed to parse message from core: ${String(err)}`);
      }
    }
  });

  sock.on("error", (err) => {
    log(`core socket error: ${(err as Error).message}`);
  });

  sock.on("close", () => {
    coreSocket = null;
    if (!shuttingDown) scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToCore();
  }, 3000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log("native host started");
connectToCore();

process.stdin.on("data", (chunk) => {
  handleStdinChunk(chunk, (message) => {
    const request = message as { id: string };
    if (coreSocket && !coreSocket.destroyed) {
      coreSocket.write(JSON.stringify(message) + "\n");
    } else {
      const response: BrowserResponse = {
        id: request.id,
        success: false,
        error: makeError("COMPANION_NOT_RUNNING", "Companion Core is not running."),
      };
      writeToChrome(response);
    }
  });
});

process.stdin.on("end", () => {
  log("stdin closed by Chrome (extension disconnected); exiting");
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  coreSocket?.destroy();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${String(err)}`);
});
