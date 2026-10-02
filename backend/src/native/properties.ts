import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "../store.js";

/** Java .properties escaping: backslashes, line breaks and non-ASCII characters as \uXXXX. */
export function escapeValue(v: string) {
  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c > 0x7e || c < 0x20) {
      // Characters outside the BMP become a surrogate pair.
      for (const unit of String.fromCodePoint(c).split("")) out += `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out.replace(/^ /, "\\ ");
}

export function unescapeValue(v: string) {
  return v.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, e: string) => {
    if (e.startsWith("u") && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e;
  });
}

/** Parse server.properties into an ordered list of lines, keeping comments. */
export function parseProperties(text: string) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*([^#!=:\s][^=:]*?)\s*[=:]\s?(.*)$/);
    return m ? { key: m[1], value: unescapeValue(m[2]), raw: line } : { raw: line };
  });
}

/** Set keys in server.properties, keeping every other line as it is. */
export function mergeProperties(text: string, values: Record<string, string>) {
  const lines = parseProperties(text);
  const left = new Map(Object.entries(values));
  const out = lines.map((l) => {
    if ("key" in l && l.key !== undefined && left.has(l.key)) {
      const v = left.get(l.key)!;
      left.delete(l.key);
      return `${l.key}=${escapeValue(v)}`;
    }
    return l.raw;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of left) out.push(`${k}=${escapeValue(v)}`);
  return out.join("\n") + "\n";
}

export function readProperty(text: string, key: string) {
  for (const l of parseProperties(text)) if ("key" in l && l.key === key) return l.value;
  return undefined;
}

/** The server.properties values ZimaMC manages (what the Docker image sets from its environment). */
export function managedProperties(s: ServerConfig, rcon: { port: number; password: string }): Record<string, string> {
  const p = s.properties;
  return {
    "server-port": String(s.port),
    motd: p.motd,
    "max-players": String(p.maxPlayers),
    difficulty: p.difficulty,
    gamemode: p.gamemode,
    pvp: String(p.pvp),
    "online-mode": String(p.onlineMode),
    "white-list": String(p.whitelist),
    "view-distance": String(p.viewDistance),
    "enable-rcon": "true",
    "rcon.port": String(rcon.port),
    "rcon.password": rcon.password,
    "broadcast-rcon-to-ops": "false",
  };
}

/** Write server.properties and accept the EULA (the user agrees to it when creating a server). */
export async function writeServerFiles(dir: string, values: Record<string, string>) {
  const file = path.join(dir, "server.properties");
  const current = await fsp.readFile(file, "utf8").catch(() => "");
  await fsp.writeFile(file, mergeProperties(current, values));
  await fsp.writeFile(path.join(dir, "eula.txt"), "# Accepted in ZimaMC (https://aka.ms/MinecraftEULA)\neula=true\n");
}
