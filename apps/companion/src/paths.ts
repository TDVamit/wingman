// Resolves absolute paths to the other workspace packages this app needs to
// invoke (native-host, mcp-adapter) and to the built extension, in both dev
// (running from the monorepo) and packaged (.app with resources) contexts.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app } from "electron";

function resourcesRoot(): string {
  if (app.isPackaged) return process.resourcesPath;
  // apps/companion/dist/paths.js -> repo root
  return path.resolve(__dirname, "..", "..", "..");
}

function packagesRoot(): string {
  return app.isPackaged ? path.join(resourcesRoot(), "packages") : path.join(resourcesRoot(), "packages");
}

export function nativeHostScriptPath(): string {
  return path.join(packagesRoot(), "native-host", "dist", "index.js");
}

export function mcpAdapterScriptPath(): string {
  return path.join(packagesRoot(), "mcp-adapter", "dist", "index.js");
}

export function extensionDistPath(): string {
  return app.isPackaged
    ? path.join(resourcesRoot(), "extension")
    : path.resolve(resourcesRoot(), "apps", "extension", "dist");
}

/**
 * Chrome, Claude Desktop, and Codex all spawn child processes with a
 * minimal launchd-style PATH, so a bare "node" command fails silently when
 * node comes from nvm/homebrew (not on that PATH). Resolve a real absolute
 * binary instead of trusting PATH at spawn time.
 */
export function nodeExecutablePath(): string {
  const candidates = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "node"));
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");

  const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
  if (fs.existsSync(nvmDir)) {
    for (const version of fs.readdirSync(nvmDir).sort().reverse()) {
      candidates.push(path.join(nvmDir, version, "bin", "node"));
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node"; // last resort: hope env PATH works
}
