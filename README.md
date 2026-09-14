# Wingman

A proof-of-concept that lets both **Claude Desktop** and **Codex CLI** control
the *same* real Chrome browser session through one shared local process,
using an MCP server on one side and Chrome's Native Messaging API on the
other. There are two independent AI clients, but only one browser session
and one connection to Chrome — the companion app is the single source of
truth in the middle.

```
Claude Desktop  ─┐                                   ┌─ chrome.runtime.connectNative
                  ├─ MCP (stdio) ──▶ Companion Core ──┤
Codex CLI       ─┘   mcp-adapter      (Electron,       └─ Native Messaging (stdio)
                      subprocess       Unix socket                │
                                       core.sock)                 ▼
                                                          Chrome Extension (MV3)
                                                          background + content script
                                                                   │
                                                                   ▼
                                                             the actual web page
```

- **Chrome extension** (`apps/extension`) — MV3 service worker + content
  script. Owns the real DOM: tab queries, navigation, click/type/scroll/key,
  screenshots, and a labeled-element accessibility snapshot.
- **Companion Core** (`packages/companion-core`) — the process all clients
  and the extension connect to. One Unix domain socket
  (`~/Library/Application Support/BrowserAgent/core.sock`), newline-delimited
  JSON. Tracks connection state, recording state, and an activity log.
- **Native Host** (`packages/native-host`) — thin stdio↔socket bridge Chrome
  spawns per Native Messaging connection.
- **MCP Adapter** (`packages/mcp-adapter`) — thin stdio↔socket bridge Claude
  Desktop / Codex spawn per MCP connection. Exposes the browser_* /
  recording_* tools.
- **Companion app** (`apps/companion`) — Electron GUI + all one-time setup:
  registers the Native Messaging host manifest, and can add/remove this
  server from Claude Desktop's and Codex's MCP config with one click,
  preserving every other server already configured there.

## Requirements

- macOS (this POC's setup code — Native Messaging manifest location,
  Claude/Codex config paths — is macOS-specific)
- Node.js 18+ (an nvm or Homebrew install is fine; see "PATH note" below)
- Google Chrome
- Claude Desktop and/or Codex CLI installed, to test the integrations
- `ffmpeg` on `PATH` (`brew install ffmpeg`) — only needed for the replay
  page's "Download video" feature
- Playwright's bundled Chromium — only needed for "Download video" (see Build)

## Build

```
npm install
npx playwright install chromium   # only needed for "Download video"
npm run build          # builds protocol, native-host, mcp-adapter,
                        # companion-core, extension, companion, in order
```

Individual pieces: `npm run build:extension`, `npm run build:companion`.

## Run the companion (dev)

```
npm run dev:companion   # builds everything, then launches the Electron GUI
```

## Package the companion (macOS .app)

```
npm run package:companion
```

Produces `release/Browser Agent Companion-darwin-<arch>/Browser Agent Companion.app`.
It's an unsigned, unnotarized POC build (`asar: false` — the companion spawns
native-host/mcp-adapter as plain `node script.js` subprocesses, which can't
read out of an asar archive, so they ship as real files under
`Contents/Resources/packages/`). Launch with `open`, or Finder will warn
about an unidentified developer (right-click → Open once to bypass Gatekeeper).

## Load the extension into Chrome

1. `npm run build:extension` (or `npm run build`)
2. Chrome → `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select `apps/extension/dist`
4. The extension ID should show as `maeongoknbjmjhiodjomkldpgbpfkfak` — this
   is pinned by the public key already baked into `apps/extension/manifest.json`'s
   `"key"` field, so the Native Messaging manifest's `allowed_origins` never
   needs manual editing after a reload. The matching private key
   (`apps/extension/dev-keys/`) isn't tracked in git; you only need it if you
   want to produce a signed `.crx`, not for local "Load unpacked" dev.
5. Start the companion (dev or packaged). The extension's background worker
   auto-connects via `chrome.runtime.connectNative`.

## Connect Claude Desktop

Open the companion GUI → **Connect Claude**. This writes a `browser-agent`
entry into Claude Desktop's `claude_desktop_config.json`, backing up the
original as `.browser-agent.backup` and doing a read-merge-write so any
other MCP servers you already had configured are left untouched. **Fully
quit and reopen Claude Desktop** to pick up the new server (MCP servers are
only read at startup). **Disconnect** in the GUI removes only the
`browser-agent` entry and restores everything else.

## Connect Codex CLI

Open the companion GUI → **Connect Codex**. This shells out to the official
`codex mcp add` CLI (and `codex mcp remove` on disconnect), so Codex's own
config format and any other servers you have registered are preserved
without the companion touching that file directly.

## Try it — five test prompts

With the companion running, the extension loaded, and at least one client
connected, try these in Claude Desktop or Codex:

1. "What tabs do I have open in Chrome right now?"
2. "Go to http://localhost:8934/plain.html and tell me what's on the page." (serve `test-page/` locally first, e.g. `python3 -m http.server 8934` from that directory — `file://` pages are rejected, see Known limitations)
3. "Type 'Ada Lovelace' into the Name field and click Submit."
4. "Take a screenshot of the current tab."
5. "Start a recording, scroll to the bottom of the page, then stop the recording and tell me its status."

Because both clients talk to the same Companion Core, you can run prompt 2
from Codex and prompt 3 from Claude Desktop back to back — the second client
sees the tab the first one navigated to, because it's the same browser
session, not two independent ones.

## Native Messaging PATH gotcha (and how this repo avoids it)

Chrome, Claude Desktop, and Codex all spawn child processes with a minimal,
launchd-style `PATH` that does **not** include an nvm- or Homebrew-installed
`node`. A bare `#!/usr/bin/env node` shebang, or a config's `"command":
"node"`, silently fails under that PATH — the process exits before writing
even a log line. This repo resolves an absolute `node` binary path once
(`apps/companion/src/paths.ts: nodeExecutablePath()`, checking `PATH`,
`/opt/homebrew/bin/node`, `/usr/local/bin/node`, then nvm's version
directories) and bakes that absolute path into the native-host script's
shebang and into the Claude/Codex MCP `command` field — nothing here should
depend on any client inheriting your shell's `PATH`.

## Demoly integration & video export

Recordings save as a standalone replay `.html` page
(`~/Library/Application Support/BrowserAgent/recordings/`) with an rrweb
player and, if you're logged into [app.demoly.dev](https://app.demoly.dev) in
Chrome with the extension installed, an "Upload to Demoly" panel that pushes
the recording (plus any AI-agent notes recorded during the session) to your
Demoly workspace as a shareable session replay.

The replay page also has a "Download video" action that renders the replay
in a headless browser and encodes it to an mp4 via ffmpeg. Known limitation:
capture is currently capped at ~30fps — headless Chromium throttles its own
frame production at the CDP level on macOS, independent of image quality,
GPU backend, or headed vs. headless (confirmed by benchmarking; see git
history/commit messages in `packages/companion-core/src/index.ts` for
details). Getting past that ceiling would require real OS-level screen
recording instead.

## Known limitations (POC scope)

- macOS only.
- "Download video" (see Demoly integration above) is capped at ~30fps —
  a headless Chromium frame-production limit on macOS, not fixable by
  tuning capture settings.
- `file://` pages are rejected (`UNSUPPORTED_PAGE`) — Chrome's Native
  Messaging pipeline is what's being exercised, and content scripts require
  `http(s)` origins to run reliably; serve local test content over HTTP.
- Unsigned/unnotarized packaged app — fine for local POC use, not for
  distribution.
- Single browser window/profile assumed; no multi-profile Chrome handling.

## Troubleshooting

- **Extension keeps reconnecting to the native host in a loop**: the native
  host process is dying immediately after spawn — almost always the PATH
  issue above. Check `~/Library/Application Support/BrowserAgent/` (or
  wherever `native-host.log` is configured) for a log entry; if there's
  none at all, the shebang never resolved to a real node binary.
- **Claude/Codex show the server as configured but tools never respond**:
  fully quit (not just close the window) and relaunch the client — MCP
  servers are read once at startup.
- **`EXTENSION_DISCONNECTED` from a tool call**: the Chrome extension isn't
  currently connected to Companion Core — check that Chrome is open with
  the unpacked extension loaded and its service worker hasn't been evicted
  (open `chrome://extensions` → the extension's "service worker" link to
  wake it).

## POC Test Results

All tests below were run against real Chrome, a real Claude Desktop and
Codex CLI install, and the real Companion Core over its actual Unix socket
— no mocked transport layer.

| # | Acceptance item | Result |
|---|---|---|
| 1 | Extension loads unpacked in Chrome, ID stable via dev-keys | PASS |
| 2 | Extension ↔ native host ↔ Companion Core connects (Native Messaging round trip) | PASS |
| 3 | `browser_get_tabs` returns real tab list | PASS |
| 4 | `browser_get_page_info` returns real URL/title/text/labeled elements | PASS |
| 5 | `browser_navigate` navigates the real tab | PASS |
| 6 | `browser_click` clicks a real element by ID | PASS |
| 7 | `browser_type` types into plain and React-controlled inputs (verified React `onChange` fires, not just DOM value set) | PASS |
| 8 | `browser_scroll` scrolls the real page | PASS |
| 9 | `browser_press_key` sends a real key event | PASS |
| 10 | `browser_screenshot` returns a valid JPEG under the Native Messaging size limit | PASS |
| 11 | `recording_start` / `recording_stop` / `recording_status` traverse the full stack and report correct state, including double-start/stop error cases | PASS |
| 12 | Invalid/unsupported URL schemes rejected with correct error codes (`INVALID_URL`, `UNSUPPORTED_PAGE`) | PASS |
| 13 | Connect/Disconnect Claude Desktop preserves pre-existing MCP servers in its config (add + preserve + remove + preserve) | PASS |
| 14 | Connect/Disconnect Codex preserves pre-existing MCP servers via the official `codex mcp add/remove` CLI | PASS |
| 15 | Claude Desktop and Codex share one live browser session (one client navigates, the other reads the resulting page) | PASS |
| 16 | Companion packages into a standalone macOS `.app` that launches and re-registers Native Messaging from its packaged path | PASS |
| 17 | Chrome-restart resilience (extension reconnects after Chrome restarts, no companion restart needed) | NOT TESTED — companion-restart resilience was verified incidentally; test manually by restarting Chrome only and confirming the extension reconnects without touching the companion |

