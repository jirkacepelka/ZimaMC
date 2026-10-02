import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "../http.js";
import { HttpError, type ServerConfig } from "../store.js";
import { downloadTo } from "./download.js";

/** What was installed in a server folder, so a restart doesn't download it again. */
interface Installed {
  type: string;
  version: string;
  build?: string;
  /** Arguments after the JVM flags, e.g. ["-jar", "server.jar"]. */
  args: string[];
}

const MARKER = ".zimamc-install.json";

export interface InstallContext {
  dir: string;
  java: string;
  onProgress?: (pct: number) => void;
  /** Lines for the server console, so the user sees what is happening. */
  log?: (line: string) => void;
}

async function readInstalled(dir: string): Promise<Installed | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, MARKER), "utf8")) as Installed;
  } catch {
    return null;
  }
}

const jarExists = (dir: string, args: string[]) =>
  args.every((a, i) => (args[i - 1] === "-jar" ? fs.existsSync(path.join(dir, a)) : a.startsWith("@") ? fs.existsSync(path.join(dir, a.slice(1))) : true));

/**
 * Make sure the server software for the server's type and version is in its
 * folder and return how to launch it. Paper and Folia are updated to their
 * newest build of that Minecraft version, like the Docker image does.
 */
export async function installServer(s: Pick<ServerConfig, "type" | "version">, ctx: InstallContext): Promise<string[]> {
  const prev = await readInstalled(ctx.dir);
  const same = prev && prev.type === s.type && prev.version === s.version && jarExists(ctx.dir, prev.args);
  if (same && s.type !== "PAPER" && s.type !== "FOLIA") return prev.args;

  let result: Installed;
  try {
    switch (s.type) {
      case "PAPER":
      case "FOLIA":
        result = await installPaper(s.type === "PAPER" ? "paper" : "folia", s.version, ctx, same ? prev.build : undefined);
        break;
      case "FABRIC":
        result = await installFabric(s.version, ctx);
        break;
      case "FORGE":
        result = await installForge(s.version, ctx);
        break;
      default:
        result = await installVanilla(s.version, ctx);
    }
  } catch (e) {
    // Offline: keep using what is already there.
    if (same) {
      ctx.log?.(`[ZimaMC] Could not check for updates, starting the installed ${s.type} ${s.version}.`);
      return prev.args;
    }
    throw e;
  }
  await fsp.writeFile(path.join(ctx.dir, MARKER), JSON.stringify(result, null, 2));
  return result.args;
}

// ---- Paper and Folia ----

interface FillBuild {
  id: number;
  downloads: Record<string, { name: string; url: string; checksums?: { sha256?: string } }>;
}

async function latestPaperBuild(project: string, version: string) {
  try {
    const b = await fetchJson<FillBuild>(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds/latest`);
    const d = b.downloads["server:default"] ?? Object.values(b.downloads)[0];
    if (d) return { build: String(b.id), url: d.url, sha256: d.checksums?.sha256 };
  } catch {
    /* try the old API */
  }
  const r = await fetchJson<{ builds: { build: number; downloads: { application: { name: string; sha256: string } } }[] }>(
    `https://api.papermc.io/v2/projects/${project}/versions/${version}/builds`,
  );
  const b = r.builds.at(-1);
  if (!b) throw new HttpError(502, "version_unavailable", { version });
  const app = b.downloads.application;
  return {
    build: String(b.build),
    url: `https://api.papermc.io/v2/projects/${project}/versions/${version}/builds/${b.build}/downloads/${app.name}`,
    sha256: app.sha256,
  };
}

async function installPaper(project: string, version: string, ctx: InstallContext, installedBuild?: string): Promise<Installed> {
  const latest = await latestPaperBuild(project, version);
  const args = ["-jar", "server.jar"];
  if (installedBuild === latest.build) return { type: project.toUpperCase(), version, build: latest.build, args };
  ctx.log?.(`[ZimaMC] Downloading ${project === "paper" ? "Paper" : "Folia"} ${version} (build ${latest.build})…`);
  await downloadTo(latest.url, path.join(ctx.dir, "server.jar"), {
    onProgress: ctx.onProgress,
    hash: latest.sha256 ? { algorithm: "sha256", hex: latest.sha256 } : undefined,
  });
  return { type: project.toUpperCase(), version, build: latest.build, args };
}

// ---- Vanilla ----

async function installVanilla(version: string, ctx: InstallContext): Promise<Installed> {
  const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new HttpError(400, "version_unavailable", { version });
  const meta = await fetchJson<{ downloads: { server?: { url: string; sha1: string } } }>(entry.url);
  if (!meta.downloads.server) throw new HttpError(400, "version_unavailable", { version });
  ctx.log?.(`[ZimaMC] Downloading Minecraft ${version}…`);
  await downloadTo(meta.downloads.server.url, path.join(ctx.dir, "server.jar"), {
    onProgress: ctx.onProgress,
    hash: { algorithm: "sha1", hex: meta.downloads.server.sha1 },
  });
  return { type: "VANILLA", version, args: ["-jar", "server.jar"] };
}

// ---- Fabric ----

async function installFabric(version: string, ctx: InstallContext): Promise<Installed> {
  const loaders = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
  const loader = (loaders.find((l) => l.loader.stable) ?? loaders[0])?.loader.version;
  if (!loader) throw new HttpError(400, "version_unavailable", { version });
  const installers = await fetchJson<{ version: string; stable: boolean }[]>("https://meta.fabricmc.net/v2/versions/installer");
  const installer = (installers.find((i) => i.stable) ?? installers[0])?.version;
  if (!installer) throw new HttpError(502, "version_unavailable", { version });
  ctx.log?.(`[ZimaMC] Downloading Fabric ${loader} for Minecraft ${version}…`);
  // The server launcher downloads Minecraft and the libraries itself on the first start.
  await downloadTo(`https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`, path.join(ctx.dir, "fabric-server.jar"), {
    onProgress: ctx.onProgress,
  });
  return { type: "FABRIC", version, build: loader, args: ["-jar", "fabric-server.jar"] };
}

// ---- Forge ----

async function installForge(version: string, ctx: InstallContext): Promise<Installed> {
  const promos = await fetchJson<{ promos: Record<string, string> }>("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json");
  const forge = promos.promos[`${version}-recommended`] ?? promos.promos[`${version}-latest`];
  if (!forge) throw new HttpError(400, "version_unavailable", { version });
  const full = `${version}-${forge}`;
  const installer = path.join(ctx.dir, `forge-${full}-installer.jar`);
  ctx.log?.(`[ZimaMC] Downloading Forge ${forge} for Minecraft ${version}…`);
  await downloadTo(`https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`, installer, {
    onProgress: (p) => ctx.onProgress?.(Math.round(p / 2)),
  });
  ctx.log?.("[ZimaMC] Installing Forge, this takes a minute…");
  ctx.onProgress?.(50);
  await run(ctx.java, ["-jar", installer, "--installServer"], ctx.dir, ctx.log);
  await fsp.rm(installer, { force: true });
  await fsp.rm(`${installer}.log`, { force: true });
  ctx.onProgress?.(100);

  // Forge 1.17+ starts through an argument file; older versions are a runnable jar.
  const argsFile = path.join("libraries", "net", "minecraftforge", "forge", full, process.platform === "win32" ? "win_args.txt" : "unix_args.txt");
  if (fs.existsSync(path.join(ctx.dir, argsFile))) return { type: "FORGE", version, build: forge, args: [`@${argsFile}`] };
  for (const jar of [`forge-${full}.jar`, `forge-${full}-universal.jar`, `forge-${full}-shim.jar`]) {
    if (fs.existsSync(path.join(ctx.dir, jar))) return { type: "FORGE", version, build: forge, args: ["-jar", jar] };
  }
  throw new HttpError(502, "forge_install_failed");
}

function run(cmd: string, args: string[], cwd: string, log?: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (c: Buffer) => {
      buf += c.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) log?.(l);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new HttpError(502, "forge_install_failed"))));
  });
}
