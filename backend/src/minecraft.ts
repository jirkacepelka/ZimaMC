import { MC_GID, MC_UID } from "./config.js";
import type { ServerConfig, ServerType } from "./store.js";

export const SERVER_TYPES: ServerType[] = ["PAPER", "FOLIA", "VANILLA", "FABRIC", "FORGE"];

/** Plugins go to plugins/, mods to mods/. Vanilla has neither. */
export function contentKind(type: ServerType): { dir: "plugins" | "mods"; loader: string; projectType: "plugin" | "mod" } | null {
  switch (type) {
    case "PAPER":
      return { dir: "plugins", loader: "paper", projectType: "plugin" };
    case "FOLIA":
      return { dir: "plugins", loader: "folia", projectType: "plugin" };
    case "FABRIC":
      return { dir: "mods", loader: "fabric", projectType: "mod" };
    case "FORGE":
      return { dir: "mods", loader: "forge", projectType: "mod" };
    default:
      return null;
  }
}

/** Compare Minecraft release versions like "1.20.4" numerically. */
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Pick the Java version the given Minecraft version needs. */
export function javaTagFor(version: string) {
  // Since 2026 versions are numbered by year (26.1, 26.2, …) and need Java 25.
  if (compareVersions(version, "26") >= 0) return "java25";
  if (compareVersions(version, "1.20.5") >= 0) return "java21";
  if (compareVersions(version, "1.17") >= 0) return "java17";
  return "java8";
}

export function imageTag(s: ServerConfig) {
  return s.advanced.javaImageTag || javaTagFor(s.version);
}

/** Map a server's settings to the environment of the itzg/minecraft-server image. */
export function containerEnv(s: ServerConfig): Record<string, string> {
  const p = s.properties;
  const env: Record<string, string> = {
    EULA: "TRUE",
    TYPE: s.type,
    VERSION: s.version,
    MEMORY: `${s.memoryMB}M`,
    UID: String(MC_UID),
    GID: String(MC_GID),
    TZ: process.env.TZ ?? "UTC",
    ENABLE_RCON: "true",
    MOTD: p.motd,
    MAX_PLAYERS: String(p.maxPlayers),
    DIFFICULTY: p.difficulty,
    MODE: p.gamemode,
    PVP: String(p.pvp),
    ONLINE_MODE: String(p.onlineMode),
    ENABLE_WHITELIST: String(p.whitelist),
    VIEW_DISTANCE: String(p.viewDistance),
    STOP_SERVER_ANNOUNCE_DELAY: "5",
  };
  if (s.type === "PAPER" || s.type === "FOLIA") env.USE_AIKAR_FLAGS = "true";
  if (s.advanced.jvmFlags?.trim()) env.JVM_OPTS = s.advanced.jvmFlags.trim();
  for (const [k, v] of Object.entries(s.advanced.extraEnv ?? {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = String(v);
  }
  return env;
}

export function defaultProperties(name: string, maxPlayers: number): ServerConfig["properties"] {
  return {
    motd: name,
    maxPlayers,
    difficulty: "normal",
    gamemode: "survival",
    pvp: true,
    onlineMode: true,
    whitelist: false,
    viewDistance: 10,
  };
}

/** Parse the reply of the "list" command: "There are 2 of a max of 20 players online: Steve, Alex". */
export function parsePlayerList(out: string) {
  const m = out.match(/There are (\d+) (?:of a max of|out of maximum|\/) ?(\d+) players online:?\s*(.*)/i);
  if (!m) return null;
  const names = m[3]
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), names };
}

/** Player names are 3-16 characters of letters, digits and underscore. */
export function isValidPlayerName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

/**
 * Remove colours from server output: terminal (ANSI) escape codes and
 * Minecraft formatting codes, including hex colours written as §x§r§r§g§g§b§b.
 */
export function plainText(s: string) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/§x(§[0-9a-f]){6}/gi, "")
    .replace(/§[0-9a-fk-orx]/gi, "")
    .trim();
}

export interface ChunkyProgress {
  state: "running" | "finished" | "paused" | "cancelled";
  world?: string;
  chunks?: number;
  percent?: number;
  eta?: string;
  rate?: number;
}

/**
 * Find the newest Chunky status line in the server log, e.g.
 * "[Chunky] Task running for minecraft:overworld. Processed: 5,000 chunks (1.28%), ETA: 0:12:03, Rate: 39.3 cps, Current: 112, -304"
 * "[Chunky] Task finished for minecraft:overworld. Processed: 390,625 chunks (100.00%), Total time: 1:05:20"
 */
export function parseChunkyProgress(log: string): ChunkyProgress | null {
  const lines = plainText(log).split("\n").reverse();
  const num = (s?: string) => (s === undefined ? undefined : Number(s.replace(/[,\s]/g, "")));
  for (const l of lines) {
    const m = l.match(/Task (running|finished|paused|stopped|cancelled) for ([^\s.]+(?:\.[^\s.]+)*?)\.(?: Processed: ([\d,.\s]+) chunks \(([\d.,]+)%\))?(?:.*?ETA: ([\d:]+))?(?:.*?Rate: ([\d.,]+) cps)?/i);
    if (m) {
      const state = m[1].toLowerCase() === "stopped" ? "paused" : (m[1].toLowerCase() as ChunkyProgress["state"]);
      return {
        state,
        world: m[2],
        chunks: num(m[3]),
        percent: m[4] ? Number(m[4].replace(",", ".")) : state === "finished" ? 100 : undefined,
        eta: m[5],
        rate: m[6] ? Number(m[6].replace(",", "")) : undefined,
      };
    }
    if (/\[Chunky\].*(Task cancelled|Cancelled task|cancelled)/i.test(l)) return { state: "cancelled" };
    if (/\[Chunky\].*(Task paused|Paused task|paused)/i.test(l)) return { state: "paused" };
  }
  return null;
}
