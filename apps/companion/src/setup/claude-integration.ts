// Automatically configures Claude Desktop's MCP servers list, preserving
// every other entry. Never touches the config wholesale.
//
// Config location & schema per current Claude Desktop docs (Settings ->
// Developer -> Edit Config): a top-level "mcpServers" object, each entry
// shaped { command, args? }.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BROWSER_AGENT_MCP_NAME } from "@browser-agent/protocol";
import { mcpAdapterScriptPath, nodeExecutablePath } from "../paths";

const CLAUDE_APP_PATH = "/Applications/Claude.app";

function configPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

function backupPath(): string {
  return configPath() + ".browser-agent.backup";
}

function readConfig(): Record<string, any> {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeConfigAtomic(config: Record<string, any>): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  // Validate before committing.
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, p);
}

export function detectClaude(): boolean {
  return fs.existsSync(CLAUDE_APP_PATH);
}

export function isClaudeConfigured(): boolean {
  const config = readConfig();
  const entry = config.mcpServers?.[BROWSER_AGENT_MCP_NAME];
  return !!entry && entry.args?.[0] === mcpAdapterScriptPath();
}

export function configureClaude(): { restartRequired: boolean } {
  const config = readConfig();
  if (fs.existsSync(configPath())) fs.copyFileSync(configPath(), backupPath());

  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[BROWSER_AGENT_MCP_NAME] = {
    command: nodeExecutablePath(),
    args: [mcpAdapterScriptPath(), "--client=claude"],
  };

  writeConfigAtomic(config);
  return { restartRequired: true };
}

export function removeClaudeConfiguration(): { restartRequired: boolean } {
  const config = readConfig();
  if (config.mcpServers && BROWSER_AGENT_MCP_NAME in config.mcpServers) {
    if (fs.existsSync(configPath())) fs.copyFileSync(configPath(), backupPath());
    delete config.mcpServers[BROWSER_AGENT_MCP_NAME];
    writeConfigAtomic(config);
  }
  return { restartRequired: true };
}

export function validateClaudeConfiguration(): boolean {
  try {
    const config = readConfig();
    const entry = config.mcpServers?.[BROWSER_AGENT_MCP_NAME];
    return !!entry && typeof entry.command === "string" && Array.isArray(entry.args);
  } catch {
    return false;
  }
}
