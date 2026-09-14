// Lightweight client used by the MCP adapter to talk to Companion Core over
// its Unix domain socket. One connection is reused for the adapter's whole
// lifetime; it reconnects lazily if dropped.
import * as net from "net";
import { randomUUID } from "crypto";
import { type BrowserAction, type ClientName } from "@browser-agent/protocol";
import { socketPath } from "@browser-agent/protocol/dist/paths";

export class CoreClientNotRunningError extends Error {}

interface Pending {
  resolve: (v: { success: boolean; data?: unknown; error?: { code: string; message: string } }) => void;
  timer: NodeJS.Timeout;
}

export class CoreClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private connecting: Promise<net.Socket> | null = null;

  constructor(private readonly client: ClientName) {}

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath());
      const onError = (err: Error) => {
        this.connecting = null;
        reject(new CoreClientNotRunningError(err.message));
      };
      sock.once("error", onError);
      sock.once("connect", () => {
        sock.off("error", onError);
        sock.write(JSON.stringify({ type: "hello", role: "mcp", client: this.client }) + "\n");
        this.socket = sock;
        this.connecting = null;

        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("close", () => {
          this.socket = null;
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve({ success: false, error: { code: "COMPANION_NOT_RUNNING", message: "Lost connection to Companion Core." } });
          }
          this.pending.clear();
        });
        sock.on("error", () => {
          /* handled via close */
        });

        resolve(sock);
      });
    });

    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve({ success: msg.success, data: msg.data, error: msg.error });
    }
  }

  async call(
    action: BrowserAction,
    params: unknown,
    timeoutMs = 12_000
  ): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
    let sock: net.Socket;
    try {
      sock = await this.connect();
    } catch (err) {
      return {
        success: false,
        error: { code: "COMPANION_NOT_RUNNING", message: "Companion Core is not running. Open the Browser Agent Companion app." },
      };
    }

    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, error: { code: "REQUEST_TIMEOUT", message: "Timed out waiting for Companion Core." } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      sock.write(JSON.stringify({ type: "command", id, action, params }) + "\n");
    });
  }
}
