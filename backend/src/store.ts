import fs from "node:fs";
import path from "node:path";
import { STORE_FILE } from "./config.js";

export type ServerType = "PAPER" | "VANILLA" | "FABRIC" | "FORGE";

export interface InstalledProject {
  projectId: string;
  versionId: string;
  title: string;
  fileName: string;
  iconUrl?: string;
}

export interface ServerConfig {
  id: string;
  name: string;
  type: ServerType;
  /** Concrete Minecraft version, e.g. "1.21.8". Never "LATEST" once created. */
  version: string;
  /** Java heap in MB. The container gets a bit more for JVM overhead. */
  memoryMB: number;
  cpus: number;
  port: number;
  /** Simple gameplay settings, applied as server.properties on each start. */
  properties: {
    motd: string;
    maxPlayers: number;
    difficulty: "peaceful" | "easy" | "normal" | "hard";
    gamemode: "survival" | "creative" | "adventure" | "spectator";
    pvp: boolean;
    onlineMode: boolean;
    whitelist: boolean;
    viewDistance: number;
  };
  /** Expert overrides. */
  advanced: {
    javaImageTag?: string;
    jvmFlags?: string;
    extraEnv?: Record<string, string>;
  };
  autoStart: boolean;
  projects: InstalledProject[];
  backup: { everyHours: number; keep: number; lastAt?: string };
  domain?: { zoneId: string; zoneName: string; name: string; aRecordId?: string; srvRecordId?: string };
  tunnel?: { tunnelId: string; address?: string };
  createdAt: string;
}

export interface Settings {
  language: string;
  showAdvanced: boolean;
  auth?: { salt: string; hash: string };
  limits: { memoryMB: number; cpus: number };
  network: { lanIp?: string; publicIp?: string; upnp: boolean };
  cloudflare?: { token: string };
  playit?: { secretKey: string; agentId?: string };
}

export interface StoreData {
  settings: Settings;
  servers: ServerConfig[];
}

function defaults(): StoreData {
  return {
    settings: {
      language: "en",
      showAdvanced: false,
      limits: { memoryMB: 0, cpus: 0 },
      network: { upnp: true },
    },
    servers: [],
  };
}

/** Tiny JSON-file store. Writes are atomic (write to temp file, then rename). */
export class Store {
  data: StoreData;
  constructor(private file = STORE_FILE) {
    this.data = defaults();
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoreData>;
      this.data = {
        settings: { ...this.data.settings, ...loaded.settings },
        servers: loaded.servers ?? [],
      };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings() {
    return this.data.settings;
  }

  get servers() {
    return this.data.servers;
  }

  server(id: string) {
    return this.data.servers.find((s) => s.id === id);
  }

  updateServer(id: string, fn: (s: ServerConfig) => void) {
    const s = this.server(id);
    if (!s) throw new HttpError(404, "server_not_found");
    fn(s);
    this.save();
    return s;
  }
}

/** Error with an HTTP status and a stable code the frontend translates. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public params?: Record<string, unknown>,
  ) {
    super(code);
  }
}
