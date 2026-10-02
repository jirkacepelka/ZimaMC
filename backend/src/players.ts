import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Runtime } from "./runtime.js";
import { chownForServer, serverDir } from "./files.js";
import { fetchJson } from "./http.js";
import { isValidPlayerName, parsePlayerList } from "./minecraft.js";
import { ping } from "./ping.js";
import { HttpError, type ServerConfig } from "./store.js";

export type PlayerList = "whitelist" | "ops" | "banned";

const FILES: Record<PlayerList, string> = {
  whitelist: "whitelist.json",
  ops: "ops.json",
  banned: "banned-players.json",
};

interface Entry {
  uuid: string;
  name: string;
  [k: string]: unknown;
}

async function readList(s: ServerConfig, list: PlayerList): Promise<Entry[]> {
  try {
    return JSON.parse(await fsp.readFile(path.join(serverDir(s.id), FILES[list]), "utf8"));
  } catch {
    return [];
  }
}

async function writeList(s: ServerConfig, list: PlayerList, entries: Entry[]) {
  const p = path.join(serverDir(s.id), FILES[list]);
  await fsp.writeFile(p, JSON.stringify(entries, null, 2));
  await chownForServer(p);
}

/** Minecraft UUID with dashes, e.g. from Mojang's API which returns it without. */
export function dashUuid(id: string) {
  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

async function lookupUuid(name: string) {
  const r = await fetchJson<{ id: string; name: string }>(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
    {},
    "player_not_found",
  ).catch(() => null);
  if (!r?.id) throw new HttpError(404, "player_not_found", { name });
  return { uuid: dashUuid(r.id), name: r.name };
}

export class Players {
  constructor(private runtime: Runtime) {}

  /**
   * Who is online, for frequent polling. Uses the server-list ping, which
   * doesn't write to the server log (RCON logs every connection).
   */
  async quickOnline(s: ServerConfig) {
    try {
      const r = await ping("127.0.0.1", s.port);
      return { online: r.online, max: r.max || s.properties.maxPlayers, names: r.names };
    } catch {
      return { online: 0, max: s.properties.maxPlayers, names: [] as string[] };
    }
  }

  /** Exact list of online players (via the "list" command). Used when the Players page opens. */
  async online(s: ServerConfig) {
    if (!(await this.runtime.isRunning(s.id))) return { online: 0, max: s.properties.maxPlayers, names: [] as string[] };
    try {
      return parsePlayerList(await this.runtime.rcon(s.id, "list")) ?? { online: 0, max: s.properties.maxPlayers, names: [] };
    } catch {
      return { online: 0, max: s.properties.maxPlayers, names: [] };
    }
  }

  async lists(s: ServerConfig) {
    const [whitelist, ops, banned] = await Promise.all([readList(s, "whitelist"), readList(s, "ops"), readList(s, "banned")]);
    const names = (l: Entry[]) => l.map((e) => e.name);
    return { whitelist: names(whitelist), ops: names(ops), banned: names(banned) };
  }

  /**
   * Add or remove a player on a list. When the server runs we use its own
   * commands so the change applies immediately; otherwise we edit the JSON files.
   */
  async change(s: ServerConfig, list: PlayerList, name: string, add: boolean) {
    if (!isValidPlayerName(name)) throw new HttpError(400, "invalid_player_name");
    if (await this.runtime.isRunning(s.id)) {
      const cmd = {
        whitelist: add ? `whitelist add ${name}` : `whitelist remove ${name}`,
        ops: add ? `op ${name}` : `deop ${name}`,
        banned: add ? `ban ${name}` : `pardon ${name}`,
      }[list];
      return this.runtime.rcon(s.id, cmd);
    }
    const entries = await readList(s, list);
    const rest = entries.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
    if (add) {
      const p = s.properties.onlineMode ? await lookupUuid(name) : { uuid: offlineUuid(name), name };
      const extra: Record<PlayerList, Record<string, unknown>> = {
        whitelist: {},
        ops: { level: 4, bypassesPlayerLimit: false },
        banned: { created: new Date().toISOString().replace("T", " ").replace(/\..+/, " +0000"), source: "ZimaMC", expires: "forever", reason: "Banned by an operator." },
      };
      rest.push({ ...p, ...extra[list] });
    }
    await writeList(s, list, rest);
    return "";
  }

  async kick(s: ServerConfig, name: string) {
    if (!isValidPlayerName(name)) throw new HttpError(400, "invalid_player_name");
    return this.runtime.rcon(s.id, `kick ${name}`);
  }
}

/** UUID an offline-mode server assigns: v3 UUID of "OfflinePlayer:<name>". */
export function offlineUuid(name: string) {
  const md5 = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return dashUuid(md5.toString("hex"));
}
