// Builds the single-file desktop app: ZimaMC.exe on Windows (a plain binary on other systems).
// It bundles the backend, embeds the web interface and injects both into a copy of node.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as tar from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-app");
const exe = path.join(out, process.platform === "win32" ? "ZimaMC.exe" : "ZimaMC");
const ui = path.join(root, "frontend", "dist");

if (!fs.existsSync(path.join(ui, "index.html"))) throw new Error("Build the frontend first: npm run build");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. One CommonJS file with all dependencies. The SSH add-ons of dockerode are optional and unused.
await build({
  entryPoints: [path.join(root, "backend/src/index.ts")],
  outfile: path.join(out, "app.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["cpu-features", "*.node"],
  define: { "import.meta.url": "__importMetaUrl" },
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

// 2. The web interface travels inside the app as an archive.
await tar.c({ gzip: true, file: path.join(out, "ui.tgz"), cwd: ui }, fs.readdirSync(ui));

// 3. Single executable application: a copy of node with the bundle and the archive injected.
fs.writeFileSync(
  path.join(out, "sea-config.json"),
  JSON.stringify({ main: "app.cjs", output: "app.blob", disableExperimentalSEAWarning: true, assets: { "ui.tgz": "ui.tgz" } }),
);
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: out, stdio: "inherit" });
fs.copyFileSync(process.execPath, exe);
if (process.platform !== "win32") fs.chmodSync(exe, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe]);
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(
  process.execPath,
  [postject, exe, "NODE_SEA_BLOB", path.join(out, "app.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])],
  { stdio: "inherit" },
);
console.log(`Built ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(0)} MB)`);
