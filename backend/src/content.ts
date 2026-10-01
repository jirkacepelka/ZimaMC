import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { serverDir } from "./files.js";
import { readJarEntry } from "./jar.js";
import { contentKind } from "./minecraft.js";
import type { ServerConfig } from "./store.js";

export interface CommandInfo {
  name: string;
  description?: string;
  usage?: string;
  aliases?: string[];
  permission?: string;
}

export interface ContentInfo {
  fileName: string;
  /** Name the plugin or mod calls itself. */
  name: string;
  /** Files and folders (relative to the server folder) with its settings. */
  configPaths: string[];
  commands: CommandInfo[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Read the commands a plugin declares in its plugin.yml (plugins can also register commands in code; those are not listed). */
export function parsePluginYml(text: string): { name?: string; commands: CommandInfo[] } {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return { commands: [] };
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  const commands: CommandInfo[] = [];
  const cmds = d.commands;
  if (cmds && typeof cmds === "object" && !Array.isArray(cmds)) {
    for (const [name, raw] of Object.entries(cmds as Record<string, unknown>)) {
      const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const aliases = (Array.isArray(c.aliases) ? c.aliases : typeof c.aliases === "string" ? [c.aliases] : []).map(String);
      commands.push({
        name,
        description: str(c.description),
        usage: str(c.usage)?.replace(/<command>/g, name),
        aliases: aliases.length ? aliases : undefined,
        permission: str(c.permission),
      });
    }
  }
  return { name: str(d.name), commands };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Find where a plugin or mod keeps its settings, and which commands it declares. */
export async function inspectContent(s: ServerConfig, fileName: string): Promise<ContentInfo | null> {
  const kind = contentKind(s.type);
  if (!kind || fileName !== path.basename(fileName) || !fileName.endsWith(".jar")) return null;
  const root = serverDir(s.id);
  const jar = path.join(root, kind.dir, fileName);
  if (!(await exists(jar))) return null;

  const info: ContentInfo = { fileName, name: fileName.replace(/\.jar$/, ""), configPaths: [], commands: [] };

  if (kind.dir === "plugins") {
    const yml = (await readJarEntry(jar, "plugin.yml")) ?? (await readJarEntry(jar, "paper-plugin.yml"));
    const parsed = yml ? parsePluginYml(yml) : { commands: [] as CommandInfo[] };
    if (parsed.name) info.name = parsed.name;
    info.commands = parsed.commands;
    // Plugins keep their settings in plugins/<Name>/, usually spelled like their name.
    const dirs = await fsp.readdir(path.join(root, "plugins"), { withFileTypes: true }).catch(() => []);
    const want = new Set([norm(info.name), norm(fileName.replace(/\.jar$/, "").replace(/[-_ ]?v?\d[\d.]*.*$/, ""))]);
    for (const d of dirs) if (d.isDirectory() && want.has(norm(d.name))) info.configPaths.push(`plugins/${d.name}`);
    return info;
  }

  // Mods: the id comes from fabric.mod.json or (neo)forge mods.toml; settings go to config/.
  const ids = new Set<string>();
  const fabric = await readJarEntry(jar, "fabric.mod.json");
  if (fabric) {
    try {
      const j = JSON.parse(fabric) as { id?: string; name?: string };
      if (j.id) ids.add(j.id);
      if (j.name) info.name = j.name;
    } catch {
      /* ignore */
    }
  }
  for (const f of ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"]) {
    const toml = await readJarEntry(jar, f);
    if (!toml) continue;
    for (const m of toml.matchAll(/^\s*modId\s*=\s*"([^"]+)"/gm)) ids.add(m[1]);
    const dn = toml.match(/^\s*displayName\s*=\s*"([^"]+)"/m);
    if (dn) info.name = dn[1];
  }
  const entries = await fsp.readdir(path.join(root, "config"), { withFileTypes: true }).catch(() => []);
  const wanted = [...ids].map(norm).filter((x) => x.length >= 3);
  for (const e of entries) {
    const n = norm(e.isDirectory() ? e.name : e.name.replace(/\.[^.]+$/, ""));
    if (wanted.some((w) => n === w || n.startsWith(w) || w.startsWith(n) && n.length >= 4)) info.configPaths.push(`config/${e.name}`);
  }
  return info;
}

export interface LiveCommand {
  usage: string;
  description?: string;
}

/** Parse the output of the "help" command: "/cmd: description" (Bukkit) or "/cmd <args>" (Brigadier). */
export function parseHelp(out: string): LiveCommand[] {
  const res: LiveCommand[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^\/(\S.*?)(?::\s+(.+))?$/);
    if (m) res.push({ usage: "/" + m[1], description: m[2] });
  }
  return res;
}

/** Ask the running server for its command list. Paper pages its help, so walk the pages until nothing new appears. */
export async function liveCommands(s: ServerConfig, rcon: (cmd: string) => Promise<string>): Promise<LiveCommand[]> {
  const seen = new Map<string, LiveCommand>();
  const paged = s.type === "PAPER" || s.type === "FOLIA";
  for (let page = 1; page <= (paged ? 30 : 1); page++) {
    const found = parseHelp(await rcon(paged ? `help ${page}` : "help"));
    const before = seen.size;
    for (const c of found) if (!seen.has(c.usage)) seen.set(c.usage, c);
    if (seen.size === before) break;
  }
  return [...seen.values()].sort((a, b) => a.usage.localeCompare(b.usage));
}

/** Inspect every plugin or mod jar on the server. */
export async function inspectAll(s: ServerConfig): Promise<ContentInfo[]> {
  const kind = contentKind(s.type);
  if (!kind) return [];
  const files = await fsp.readdir(path.join(serverDir(s.id), kind.dir)).catch(() => [] as string[]);
  const out: ContentInfo[] = [];
  for (const f of files.filter((x) => x.endsWith(".jar")).sort()) {
    const i = await inspectContent(s, f);
    if (i) out.push(i);
  }
  return out;
}
