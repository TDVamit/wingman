const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const outdir = path.join(__dirname, "dist");
fs.mkdirSync(outdir, { recursive: true });

esbuild.buildSync({
  entryPoints: {
    background: path.join(__dirname, "src/background.ts"),
    "content-script": path.join(__dirname, "src/content-script.ts"),
    "demoly-handshake": path.join(__dirname, "src/demoly-handshake.ts"),
    "replay-detect": path.join(__dirname, "src/replay-detect.ts"),
    popup: path.join(__dirname, "src/popup.ts"),
  },
  bundle: true,
  outdir,
  format: "esm",
  target: "chrome110",
  logLevel: "info",
});

// popup.html/background need popup.js and content-script.js as classic
// scripts / not modules for the background is fine as module; popup as
// classic script (no `type=module` in popup.html), so build it as iife.
esbuild.buildSync({
  entryPoints: { popup: path.join(__dirname, "src/popup.ts") },
  bundle: true,
  outdir,
  format: "iife",
  target: "chrome110",
  logLevel: "silent",
});

esbuild.buildSync({
  entryPoints: {
    "content-script": path.join(__dirname, "src/content-script.ts"),
    "demoly-handshake": path.join(__dirname, "src/demoly-handshake.ts"),
    "replay-detect": path.join(__dirname, "src/replay-detect.ts"),
  },
  bundle: true,
  outdir,
  format: "iife",
  target: "chrome110",
  logLevel: "silent",
});

fs.copyFileSync(path.join(__dirname, "manifest.json"), path.join(outdir, "manifest.json"));
fs.copyFileSync(path.join(__dirname, "popup.html"), path.join(outdir, "popup.html"));

fs.mkdirSync(path.join(outdir, "icons"), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, "icons"))) {
  if (f === "logo-source.png") continue;
  fs.copyFileSync(path.join(__dirname, "icons", f), path.join(outdir, "icons", f));
}

console.log("[extension] build complete ->", outdir);
