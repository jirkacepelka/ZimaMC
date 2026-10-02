// Builds the desktop app into dist/: the backend and the Electron main process as two
// bundles, the web interface, and the icons. electron-builder then packs dist/ into the installer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeIcons } from "./icons.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktop, "..");
const dist = path.join(desktop, "dist");
const ui = path.join(root, "frontend", "dist");

if (!fs.existsSync(path.join(ui, "index.html"))) throw new Error("Build the web interface first: npm run build (in the repository root)");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "warning" };

// 1. The backend with all its dependencies. The SSH add-ons of dockerode are optional and unused.
await build({
  ...common,
  entryPoints: [path.join(root, "backend/src/server.ts")],
  outfile: path.join(dist, "backend.cjs"),
  external: ["cpu-features", "*.node"],
  define: { "import.meta.url": "__importMetaUrl" },
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});

// 2. The Electron main process (with electron-updater); it loads the backend at run time.
await build({
  ...common,
  entryPoints: [path.join(desktop, "src/main.ts")],
  outfile: path.join(dist, "main.cjs"),
  external: ["electron", "./backend.cjs"],
});

// 3. Web interface and icons.
fs.cpSync(ui, path.join(dist, "ui"), { recursive: true });
writeIcons(path.join(root, "frontend/public/icon.svg"), path.join(desktop, "build"));
for (const f of ["icon.png", "tray.png"]) fs.copyFileSync(path.join(desktop, "build", f), path.join(dist, f));

// 4. The version comes from the repository.
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(path.join(desktop, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}
console.log(`Built the desktop app ${version} in ${path.relative(root, dist)}`);
