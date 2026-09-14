// Registers/unregisters the Chrome Native Messaging host manifest so the
// extension's chrome.runtime.connectNative() call succeeds, with no manual
// terminal step for the user.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NATIVE_HOST_NAME, EXTENSION_ID } from "@browser-agent/protocol";
import { nativeHostScriptPath, nodeExecutablePath } from "../paths";

function chromeNativeMessagingDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
}

function manifestPath(): string {
  return path.join(chromeNativeMessagingDir(), `${NATIVE_HOST_NAME}.json`);
}

/**
 * Chrome invokes the manifest's "path" directly (it must be executable).
 * We ship the native host as a shebang'd JS file, so we chmod +x it,
 * rewrite its shebang to an absolute node path (Chrome spawns native
 * messaging hosts with a minimal launchd-style PATH, so a bare
 * `#!/usr/bin/env node` shebang fails silently when node comes from
 * nvm/homebrew), and point "path" straight at it rather than wrapping in a
 * shell script.
 */
export function installNativeMessagingHost(): { installed: boolean; path: string } {
  const scriptPath = nativeHostScriptPath();

  const nodeBinary = nodeExecutablePath();
  const source = fs.readFileSync(scriptPath, "utf8");
  const fixedShebang = `#!${nodeBinary}\n`;
  const rewritten = fixedShebang + source.slice(source.indexOf("\n") + 1);
  if (source !== rewritten) fs.writeFileSync(scriptPath, rewritten);

  fs.chmodSync(scriptPath, 0o755);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Wingman Companion native messaging host",
    path: scriptPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };

  fs.mkdirSync(chromeNativeMessagingDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
  return { installed: true, path: manifestPath() };
}

export function uninstallNativeMessagingHost(): void {
  const p = manifestPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function isNativeMessagingHostInstalled(): boolean {
  const p = manifestPath();
  if (!fs.existsSync(p)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
    return manifest.path === nativeHostScriptPath();
  } catch {
    return false;
  }
}
