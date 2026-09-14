// Filesystem locations shared by companion-core, native-host and mcp-adapter.
// All three must agree exactly on the socket path, so it lives here once.
import * as os from "os";
import * as path from "path";
import { APP_DIR_NAME, SOCKET_FILE_NAME } from "./index";

export function appSupportDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
}

export function socketPath(): string {
  return path.join(appSupportDir(), SOCKET_FILE_NAME);
}

export function nativeHostLogPath(): string {
  return path.join(appSupportDir(), "native-host.log");
}

export function coreLogPath(): string {
  return path.join(appSupportDir(), "core.log");
}

export function mcpAdapterLogPath(): string {
  return path.join(appSupportDir(), "mcp-adapter.log");
}
