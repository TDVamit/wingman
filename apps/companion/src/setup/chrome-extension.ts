// Helpers for the manual-but-guided part of extension setup: Chrome does
// not allow silently installing an unpacked extension, so we get the user
// as close as possible (open chrome://extensions, reveal the folder to
// load) and then detect the resulting connection ourselves.
import { execFile } from "child_process";
import * as fs from "fs";
import { extensionDistPath } from "../paths";

const CHROME_APP_PATH = "/Applications/Google Chrome.app";

export function detectChrome(): boolean {
  return fs.existsSync(CHROME_APP_PATH);
}

export function openChromeExtensionsPage(): void {
  execFile("open", ["-a", "Google Chrome", "chrome://extensions"]);
}

export function revealExtensionBuildDir(): void {
  execFile("open", ["-R", extensionDistPath()]);
  // -R reveals the *file*; open the folder itself too so Finder lands there.
  execFile("open", [extensionDistPath()]);
}

export function getExtensionDistPath(): string {
  return extensionDistPath();
}
