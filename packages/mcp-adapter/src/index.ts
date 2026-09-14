#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ClientName } from "@browser-agent/protocol";
import { appSupportDir } from "@browser-agent/protocol/dist/paths";
import { CoreClient } from "./core-client";

function parseClient(): ClientName {
  const arg = process.argv.find((a) => a.startsWith("--client="));
  const value = arg?.split("=")[1];
  return value === "claude" || value === "codex" ? value : "unknown";
}

const core = new CoreClient(parseClient());

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(error?: { code: string; message: string }): ToolResult {
  const e = error ?? { code: "INTERNAL_ERROR", message: "Unknown error" };
  return { content: [{ type: "text", text: `Error [${e.code}]: ${e.message}` }], isError: true };
}

async function run(action: Parameters<CoreClient["call"]>[0], params: unknown): Promise<ToolResult> {
  const res = await core.call(action, params);
  if (!res.success) return err(res.error);
  return ok(res.data);
}

const server = new McpServer({ name: "wingman", version: "0.1.0" });

server.tool(
  "browser_get_tabs",
  "List all open Chrome tabs with their id, window id, title, URL and whether they are the active tab.",
  {},
  async () => run("browser.getTabs", {})
);

server.tool(
  "browser_get_page_info",
  "Inspect the active Chrome page and return current interactive elements with temporary element IDs. Call this before clicking or typing and call it again after navigation or when a stale element error occurs.",
  {},
  async () => run("browser.getPageInfo", {})
);

server.tool(
  "browser_navigate",
  "Navigate the active Chrome tab to a URL. Only http/https URLs are allowed.",
  { url: z.string().describe("The http(s) URL to navigate to") },
  async ({ url }) => run("browser.navigate", { url })
);

const commentField = z
  .string()
  .optional()
  .describe("Why you're doing this, e.g. 'submitting the update'. Shown with a timestamp next to the recording, if one is active.");

server.tool(
  "browser_click",
  "Click an element using an ID returned by browser_get_page_info.",
  {
    elementId: z.string().describe("Element id such as el_3, from the latest browser_get_page_info result"),
    comment: commentField,
  },
  async ({ elementId, comment }) => run("browser.click", { elementId, comment })
);

server.tool(
  "browser_type",
  "Type text into an input, textarea or contenteditable element using an ID returned by browser_get_page_info.",
  {
    elementId: z.string().describe("Element id such as el_3, from the latest browser_get_page_info result"),
    text: z.string().describe("Text to type into the element"),
    comment: commentField,
  },
  async ({ elementId, text, comment }) => run("browser.type", { elementId, text, comment })
);

server.tool(
  "browser_scroll",
  "Scroll the active page up or down.",
  {
    direction: z.enum(["up", "down"]).describe("Scroll direction"),
    amount: z.number().int().positive().optional().describe("Pixels to scroll, default 600"),
    comment: commentField,
  },
  async ({ direction, amount, comment }) => run("browser.scroll", { direction, amount, comment })
);

server.tool(
  "browser_press_key",
  "Press a single named key (Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace) in the active page.",
  {
    key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"]),
    comment: commentField,
  },
  async ({ key, comment }) => run("browser.pressKey", { key, comment })
);

server.tool(
  "browser_screenshot",
  "Capture a screenshot of the visible area of the active Chrome tab.",
  {},
  async () => {
    const res = await core.call("browser.screenshot", {}, 20_000);
    if (!res.success) return err(res.error);
    const data = res.data as { mimeType: string; base64: string };

    // Not every MCP client host renders inline "image" content blocks (e.g.
    // Codex desktop calls the tool and gets real bytes back but never shows
    // them), so also drop a real file on disk clients can open directly.
    const dir = path.join(appSupportDir(), "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `screenshot-${Date.now()}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(data.base64, "base64"));

    return {
      content: [
        { type: "image", data: data.base64, mimeType: data.mimeType },
        { type: "text", text: `Saved to ${filePath}` },
      ],
    };
  }
);

server.tool(
  "recording_start",
  "Start recording the active Chrome tab as an interactive session replay (DOM + interaction events, not a video). Subsequent browser_click/browser_type/browser_scroll/browser_press_key calls will animate a real cursor glide and element highlight so the replay clearly shows what was done.",
  {},
  async () => run("recording.start", {})
);

server.tool(
  "recording_stop",
  "Stop the active recording and save it to disk as a self-contained .html replay file (open it in any browser to watch it).",
  {},
  async () => {
    const res = await core.call("recording.stop", {});
    if (!res.success) return err(res.error);

    // The extension stops immediately, but Companion Core still has to
    // finish writing the buffered events out to the .html replay file; poll
    // status briefly rather than making the caller guess when it's ready.
    let filePath: string | undefined;
    for (let i = 0; i < 20; i++) {
      const status = await core.call("recording.status", {});
      filePath = (status.data as { path?: string } | undefined)?.path;
      if (filePath) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    return ok(filePath ? { ...(res.data as object), path: filePath } : res.data);
  }
);

server.tool(
  "recording_status",
  "Get current recording state: whether it's active, and once stopped, the saved .html replay file path.",
  {},
  async () => run("recording.status", {})
);

server.tool(
  "demoly_list_workspaces",
  "List the Demoly workspaces (organizations) available to the connected Demoly account. Requires the user to have logged into app.demoly.dev once with Wingman installed.",
  {},
  async () => run("demoly.listWorkspaces", {})
);

server.tool(
  "demoly_set_workspace",
  "Set the active Demoly workspace used as the default for the 'Upload to Demoly' panel on recording replays.",
  { organizationId: z.string().describe("Workspace id from demoly_list_workspaces") },
  async ({ organizationId }) => run("demoly.setWorkspace", { organizationId })
);

server.tool(
  "demoly_list_projects",
  "List Demoly projects in the currently active workspace.",
  {},
  async () => run("demoly.listProjects", {})
);

server.tool(
  "demoly_set_project",
  "Set the default Demoly project used for the 'Upload to Demoly' panel on recording replays. Pass null for Unfiled.",
  { projectId: z.string().nullable().describe("Project id from demoly_list_projects, or null for Unfiled") },
  async ({ projectId }) => run("demoly.setProject", { projectId })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[MCP] fatal: ${String(err)}\n`);
  process.exit(1);
});
