// Packages the companion into a macOS .app with @electron/packager, then
// copies in the sibling workspace packages (native-host, mcp-adapter) and
// the built extension as plain on-disk resources. Those two are spawned as
// real `node script.js` child processes (not loaded through Electron/asar),
// so they need real files with the same relative layout as in dev, not an
// asar archive a plain node binary can't read.
const path = require("path");
const fs = require("fs");
const packager = require("@electron/packager");

const repoRoot = path.resolve(__dirname, "..", "..");

// Dev-only tooling that's never `require()`d at runtime by the companion,
// native-host, or mcp-adapter. Skipping these keeps the packaged app from
// bundling a redundant copy of Electron/TypeScript/esbuild.
const NODE_MODULES_SKIP = new Set(["electron", "@electron", "typescript", "esbuild", ".bin", "companion"]);

// Deliberately outside apps/companion: node_modules/@browser-agent/companion
// symlinks back to this very directory, so an output dir nested inside it
// would recurse into itself when we dereference-copy node_modules below.
const outDir = path.join(repoRoot, "release");

async function main() {
  const appPaths = await packager({
    dir: __dirname,
    out: outDir,
    overwrite: true,
    asar: false,
    platform: "darwin",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    name: "Wingman Companion",
    icon: path.join(__dirname, "icons", "icon.icns"),
    ignore: [/^\/src\//],
  });

  const appPath = appPaths[0];
  const resourcesDir = path.join(appPath, "Wingman Companion.app", "Contents", "Resources");

  fs.cpSync(path.join(repoRoot, "node_modules"), path.join(resourcesDir, "node_modules"), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const name = path.basename(src);
      return !NODE_MODULES_SKIP.has(name);
    },
  });

  fs.cpSync(path.join(repoRoot, "packages"), path.join(resourcesDir, "packages"), {
    recursive: true,
    filter: (src) => !/[\\/](src|node_modules)([\\/]|$)/.test(src) && !src.endsWith(".tsbuildinfo"),
  });

  fs.cpSync(path.join(repoRoot, "apps", "extension", "dist"), path.join(resourcesDir, "extension"), {
    recursive: true,
  });

  console.log(`Packaged: ${appPath}/Wingman Companion.app`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
