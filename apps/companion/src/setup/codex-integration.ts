// Automatically configures Codex CLI's MCP servers via the official
// `codex mcp add/remove/get` subcommands (verified against `codex mcp
// add --help` on the installed CLI) rather than hand-editing
// ~/.codex/config.toml. This is the "prefer the official mechanism" path
// called out in the spec.
import { execFileSync } from "child_process";
import * as fs from "fs";
import { BROWSER_AGENT_MCP_NAME } from "@browser-agent/protocol";
import { mcpAdapterScriptPath, nodeExecutablePath } from "../paths";

function codexBinary(): string {
  return "codex";
}

export function detectCodex(): { installed: boolean; kind: "Codex CLI" | null } {
  try {
    execFileSync(codexBinary(), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    return { installed: true, kind: "Codex CLI" };
  } catch {
    return { installed: false, kind: null };
  }
}

export function isCodexConfigured(): boolean {
  try {
    const out = execFileSync(codexBinary(), ["mcp", "get", BROWSER_AGENT_MCP_NAME], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.includes(mcpAdapterScriptPath());
  } catch {
    return false;
  }
}

export function configureCodex(): { restartRequired: boolean } {
  execFileSync(
    codexBinary(),
    ["mcp", "add", BROWSER_AGENT_MCP_NAME, "--", nodeExecutablePath(), mcpAdapterScriptPath(), "--client=codex"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return { restartRequired: false };
}

export function removeCodexConfiguration(): { restartRequired: boolean } {
  try {
    execFileSync(codexBinary(), ["mcp", "remove", BROWSER_AGENT_MCP_NAME], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // already removed / never configured — fine.
  }
  return { restartRequired: false };
}

export function validateCodexConfiguration(): boolean {
  return isCodexConfigured();
}

// Kept for documentation/debugging: the raw ~/.codex/config.toml this
// writes to (we never parse/write it directly — `codex mcp` owns it).
export function codexConfigExists(): boolean {
  const home = process.env.HOME ?? "";
  return fs.existsSync(`${home}/.codex/config.toml`);
}
