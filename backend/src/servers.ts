import crypto from "node:crypto";
import fsp from "node:fs/promises";
import dgram from "node:dgram";
import net from "node:net";
import path from "node:path";
import { BACKUPS_DIR, DATA_DIR } from "./config.js";
import type { DockerManager, ServerStats, ServerStatus } from "./docker.js";
import { dirSize, ensureDir, serverDir } from "./files.js";
import { SERVER_TYPES, contentKind, defaultProperties } from "./minecraft.js";
import { applyDomain, deleteRecord, fqdn } from "./network/cloudflare.js";
import { lanIp, publicIp } from "./network/ip.js";
import type { Playit } from "./network/playit.js";
import { closePort, openPort } from "./network/upnp.js";
import type { Players } from "./players.js";
import { assertServerLimits, containerMemoryMB, effectiveCpus, reserved } from "./resources.js";
import { detectServices, serviceById } from "./services.js";
import { HttpError, type ExtraPort, type ServerConfig, type ServerType, type Store } from "./store.js";
import { listVersions } from "./versions.js";

export const SIZE_PRESETS = {
  small: { memoryMB: 2048 },
  medium: { memoryMB: 4096 },
  large: { memoryMB: 8192 },
} as const;

export interface CreateServerInput {
  name: string;
  type: ServerType;
  version?: string;
  size?: keyof typeof SIZE_PRESETS;
  /** Chosen by the user; 20 (the Minecraft default) when a client leaves it out. */
  maxPlayers?: number;
  memoryMB?: number;
  cpus?: number;
  port?: number;
  start?: boolean;
}

function portFree(port: number, protocol: "tcp" | "udp" = "tcp") {
  return new Promise<boolean>((resolve) => {
    if (protocol === "udp") {
      const sock = dgram.createSocket("udp4");
      sock.once("error", () => resolve(false));
      sock.bind(port, "0.0.0.0", () => sock.close(() => resolve(true)));
      return;
    }
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "0.0.0.0", () => srv.close(() => resolve(true)));
  });
}

/** Ports and protocols already given out to servers, as "tcp:25565". */
function takenPorts(servers: ServerConfig[], except?: { id: string; keep: ExtraPort[] }) {
  const taken = new Set<string>();
  for (const s of servers) {
    taken.add(`tcp:${s.port}`);
    const extras = except && s.id === except.id ? except.keep : (s.extraPorts ?? []);
    for (const p of extras) taken.add(`${p.protocol}:${p.hostPort}`);
  }
  return taken;
}

interface Live {
  status: ServerStatus;
  stats: ServerStats | null;
  players: { online: number; max: number; names: string[] };
}

export class Servers {
  /** Latest status and usage of each server, refreshed in the background. */
  live = new Map<string, Live>();
  private busy = new Set<string>();
  private lastPublicIp?: string;

  constructor(
    private store: Store,
    private docker: DockerManager,
    private players: Players,
    private playit: Playit,
  ) {}

  get(id: string) {
    const s = this.store.server(id);
    if (!s) throw new HttpError(404, "server_not_found");
    return s;
  }

  private cpuDefault() {
    const lim = this.store.settings.limits.cpus;
    return Math.max(1, Math.min(2, lim || 2));
  }

  async nextPort(exclude?: string) {
    const used = takenPorts(this.store.servers.filter((s) => s.id !== exclude));
    for (let p = 25565; p < 25665; p++) if (!used.has(`tcp:${p}`) && (await portFree(p))) return p;
    throw new HttpError(409, "no_free_port");
  }

  async create(input: CreateServerInput) {
    const name = String(input.name ?? "").trim().slice(0, 40);
    if (!name) throw new HttpError(400, "name_required");
    if (!SERVER_TYPES.includes(input.type)) throw new HttpError(400, "invalid_type");
    const preset = SIZE_PRESETS[input.size ?? "small"] ?? SIZE_PRESETS.small;
    const maxPlayers = Math.round(Number(input.maxPlayers ?? 20));
    if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 500) throw new HttpError(400, "invalid_max_players");
    const memoryMB = Math.round(input.memoryMB ?? preset.memoryMB);
    const cpus = Number(input.cpus ?? this.cpuDefault());
    assertServerLimits(this.store.settings, memoryMB, cpus);

    let version = input.version;
    if (!version || version.toUpperCase() === "LATEST") {
      // Pin a concrete version so worlds and plugins don't break on a surprise update.
      const versions = await listVersions(input.type).catch(() => {
        throw new HttpError(502, "versions_unavailable");
      });
      version = versions[0];
    }
    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new HttpError(400, "invalid_version");

    let port = input.port ? Number(input.port) : await this.nextPort();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, "invalid_port");
    if (this.store.servers.some((s) => s.port === port)) throw new HttpError(409, "port_in_use", { port });

    const s: ServerConfig = {
      id: crypto.randomBytes(4).toString("hex"),
      name,
      type: input.type,
      version,
      memoryMB,
      cpus,
      port,
      properties: defaultProperties(name, maxPlayers),
      advanced: {},
      autoStart: true,
      projects: [],
      backup: { everyHours: 24, keep: 7 },
      createdAt: new Date().toISOString(),
    };
    await ensureDir(serverDir(s.id));
    this.store.servers.push(s);
    this.store.save();
    let startError: HttpError | undefined;
    if (input.start !== false) {
      try {
        await this.checkCanStart(s.id);
        this.start(s.id).catch((e) => console.error(`[start] ${s.name}:`, e));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        // The server is created; tell the user why it could not start yet.
        startError = e;
      }
    }
    return { server: s, startError };
  }

  async update(id: string, patch: Partial<ServerConfig>) {
    const s = this.get(id);
    const next: ServerConfig = structuredClone(s);
    if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 40) || s.name;
    if (patch.memoryMB !== undefined) next.memoryMB = Math.round(Number(patch.memoryMB));
    if (patch.cpus !== undefined) next.cpus = Number(patch.cpus);
    if (patch.version !== undefined) {
      if (!/^\d+\.\d+(\.\d+)?$/.test(patch.version)) throw new HttpError(400, "invalid_version");
      next.version = patch.version;
    }
    if (patch.port !== undefined) {
      const port = Number(patch.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, "invalid_port");
      if (this.store.servers.some((x) => x.id !== id && x.port === port)) throw new HttpError(409, "port_in_use", { port });
      next.port = port;
    }
    if (patch.properties) next.properties = { ...s.properties, ...patch.properties };
    if (patch.advanced) next.advanced = { ...s.advanced, ...patch.advanced };
    if (patch.autoStart !== undefined) next.autoStart = Boolean(patch.autoStart);
    if (patch.backup) {
      next.backup = {
        ...s.backup,
        everyHours: Math.max(0, Math.min(168, Number(patch.backup.everyHours ?? s.backup.everyHours))),
        keep: Math.max(1, Math.min(100, Number(patch.backup.keep ?? s.backup.keep))),
      };
    }
    assertServerLimits(this.store.settings, next.memoryMB, next.cpus);
    const portChanged = next.port !== s.port;
    Object.assign(s, next);
    this.store.save();
    if (portChanged) await this.refreshNetwork(s).catch(() => {});
    await this.balanceCpu();
    return { server: s, restartNeeded: await this.docker.isRunning(id) };
  }

  async remove(id: string, deleteFiles: boolean) {
    const s = this.get(id);
    await this.docker.stop(id).catch(() => {});
    await this.docker.remove(id);
    await this.removeDomain(s).catch(() => {});
    if (s.tunnel) await this.playit.deleteTunnel(s.tunnel.tunnelId).catch(() => {});
    await closePort(s.port);
    for (const p of s.extraPorts ?? []) await closePort(p.hostPort, p.protocol === "udp" ? "UDP" : "TCP");
    this.store.data.servers = this.store.servers.filter((x) => x.id !== id);
    this.store.save();
    this.live.delete(id);
    if (deleteFiles) {
      await fsp.rm(serverDir(id), { recursive: true, force: true });
      await fsp.rm(path.join(BACKUPS_DIR, id), { recursive: true, force: true });
    }
  }

  private async runningServers() {
    const out: ServerConfig[] = [];
    for (const s of this.store.servers) if (await this.docker.isRunning(s.id)) out.push(s);
    return out;
  }

  private async exclusive<T>(id: string, fn: () => Promise<T>) {
    if (this.busy.has(id)) throw new HttpError(409, "server_busy");
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }

  /** Throws right away if the server can't start, so the UI can explain why. */
  async checkCanStart(id: string) {
    const s = this.get(id);
    if (this.busy.has(id)) throw new HttpError(409, "server_busy");
    // Servers may add up to more than the global limit, but not one alone (e.g. after the limit was lowered).
    assertServerLimits(this.store.settings, s.memoryMB, s.cpus);
  }

  async start(id: string) {
    const s = this.get(id);
    await this.exclusive(id, async () => {
      assertServerLimits(this.store.settings, s.memoryMB, s.cpus);
      await ensureDir(serverDir(id));
      await this.syncServicePorts(id);
      this.setLive(id, { status: "starting" });
      try {
        await this.docker.start(s);
      } catch (e) {
        this.setLive(id, { status: "offline" });
        if ((e as { statusCode?: number }).statusCode === 500 && /port is already allocated|address already in use/i.test(String(e))) {
          throw new HttpError(409, "port_in_use", { port: s.port });
        }
        throw e;
      }
      if (this.store.settings.network.upnp) this.openRouterPorts(s);
    });
    await this.balanceCpu();
  }

  /** Game port plus ports players' clients use (voice chat, Bedrock). Web maps stay in the home network. */
  private openRouterPorts(s: ServerConfig) {
    openPort(s.port).catch(() => {});
    for (const p of s.extraPorts ?? []) {
      if (serviceById(p.service)?.kind === "game") openPort(p.hostPort, p.protocol === "udp" ? "UDP" : "TCP").catch(() => {});
    }
  }

  private async freeHostPort(preferred: number, protocol: "tcp" | "udp", taken: Set<string>) {
    for (let port = preferred; port < preferred + 200 && port <= 65535; port++) {
      if (!taken.has(`${protocol}:${port}`) && (await portFree(port, protocol))) return port;
    }
    throw new HttpError(409, "no_free_port");
  }

  /**
   * Publish the ports of plugins and mods that run their own service (web maps,
   * voice chat, Geyser). Detected from the jar files, so hand-added ones count too.
   * Returns true when the ports changed (the server needs a restart).
   */
  async syncServicePorts(id: string) {
    const s = this.get(id);
    const kind = contentKind(s.type);
    let files: string[] = [];
    if (kind) files = await fsp.readdir(path.join(serverDir(id), kind.dir)).catch(() => []);
    const found = detectServices([...files.filter((f) => f.endsWith(".jar")), ...s.projects.map((p) => p.title)]);
    const current = s.extraPorts ?? [];
    const keep = current.filter((p) => !p.service || found.some((f) => f.id === p.service));
    const taken = takenPorts(this.store.servers, { id, keep });
    const added: ExtraPort[] = [];
    for (const svc of found) {
      if (keep.some((p) => p.service === svc.id)) continue;
      // Skip if the user already maps this internal port by hand.
      if (keep.some((p) => p.containerPort === svc.containerPort && p.protocol === svc.protocol)) continue;
      const hostPort = await this.freeHostPort(svc.containerPort, svc.protocol, taken);
      taken.add(`${svc.protocol}:${hostPort}`);
      added.push({ containerPort: svc.containerPort, hostPort, protocol: svc.protocol, label: svc.label, service: svc.id });
    }
    const next = [...keep, ...added];
    const changed = next.length !== current.length || added.length > 0;
    if (changed) this.store.updateServer(id, (x) => (x.extraPorts = next));
    return changed;
  }

  /** Replace the ports the user added by hand (Expert settings). Detected ones are kept. */
  async setManualPorts(id: string, ports: Partial<ExtraPort>[]) {
    const s = this.get(id);
    if (!Array.isArray(ports) || ports.length > 20) throw new HttpError(400, "bad_request");
    const auto = (s.extraPorts ?? []).filter((p) => p.service);
    const manual: ExtraPort[] = ports.map((p) => ({
      containerPort: Number(p.containerPort),
      hostPort: Number(p.hostPort ?? p.containerPort),
      protocol: p.protocol === "udp" ? "udp" : "tcp",
      label: String(p.label ?? "").trim().slice(0, 40),
    }));
    const taken = takenPorts(this.store.servers.filter((x) => x.id !== id));
    taken.add(`tcp:${s.port}`);
    for (const p of auto) taken.add(`${p.protocol}:${p.hostPort}`);
    for (const p of manual) {
      const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
      if (!valid(p.containerPort) || !valid(p.hostPort) || p.hostPort < 1024) throw new HttpError(400, "invalid_port");
      if (p.containerPort === 25565 && p.protocol === "tcp") throw new HttpError(400, "invalid_port");
      const key = `${p.protocol}:${p.hostPort}`;
      if (taken.has(key)) throw new HttpError(409, "port_in_use", { port: p.hostPort });
      taken.add(key);
    }
    this.store.updateServer(id, (x) => (x.extraPorts = [...auto, ...manual]));
    return { restartNeeded: await this.docker.isRunning(id) };
  }

  /** Keep all running servers together within the global CPU limit. */
  async balanceCpu() {
    const running = await this.runningServers();
    const caps = effectiveCpus(running, this.store.settings.limits.cpus);
    for (const [id, cpus] of caps) await this.docker.setCpus(id, cpus).catch(() => {});
    return caps;
  }

  async stop(id: string) {
    this.get(id);
    await this.exclusive(id, async () => {
      this.setLive(id, { status: "stopping" });
      await this.docker.stop(id);
      this.setLive(id, { status: "offline", stats: null });
    });
    await this.balanceCpu();
  }

  async restart(id: string) {
    await this.stop(id);
    await this.start(id);
  }

  private setLive(id: string, patch: Partial<Live>) {
    const cur = this.live.get(id) ?? { status: "offline" as ServerStatus, stats: null, players: { online: 0, max: 0, names: [] } };
    this.live.set(id, { ...cur, ...patch });
  }

  /** Refresh status, usage and players of every server. Runs every few seconds. */
  async refresh() {
    await Promise.all(
      this.store.servers.map(async (s) => {
        const status = await this.docker.status(s.id);
        const running = status === "online" || status === "starting" || status === "stopping";
        const stats = running ? await this.docker.stats(s.id) : null;
        const players = status === "online" ? await this.players.quickOnline(s) : { online: 0, max: s.properties.maxPlayers, names: [] };
        this.live.set(s.id, { status, stats, players });
      }),
    );
  }

  view(s: ServerConfig) {
    const live = this.live.get(s.id);
    return {
      ...s,
      status: this.docker.pulling.has(s.id) ? "downloading" : (live?.status ?? "offline"),
      downloadProgress: this.docker.pulling.get(s.id),
      stats: live?.stats ?? null,
      players: live?.players ?? { online: 0, max: s.properties.maxPlayers, names: [] },
      containerMemoryMB: containerMemoryMB(s.memoryMB),
      address: this.address(s),
      services: this.services(s),
    };
  }

  /** Extra ports as the UI shows them: web maps get a link, game services an address. */
  services(s: ServerConfig) {
    const lan = this.store.settings.network.lanIp || lanIp() || "localhost";
    return (s.extraPorts ?? []).map((p) => {
      const svc = serviceById(p.service);
      return {
        ...p,
        kind: svc?.kind ?? "other",
        url: svc?.kind === "web" ? `http://${lan}:${p.hostPort}` : undefined,
        address: `${lan}:${p.hostPort}`,
      };
    });
  }

  address(s: ServerConfig) {
    const lan = this.store.settings.network.lanIp || lanIp();
    const pub = this.store.settings.network.publicIp || this.lastPublicIp;
    const withPort = (h?: string) => (h ? (s.port === 25565 ? h : `${h}:${s.port}`) : undefined);
    return {
      lan: withPort(lan),
      public: withPort(pub),
      domain: s.domain ? fqdn(s.domain.name, s.domain.zoneName) : undefined,
      tunnel: s.tunnel?.address,
    };
  }

  async usage() {
    const running = this.store.servers.filter((s) => {
      const st = this.live.get(s.id)?.status;
      return st === "online" || st === "starting" || st === "stopping";
    });
    const used = [...this.live.values()].reduce(
      (acc, l) => ({ memoryMB: acc.memoryMB + (l.stats?.memoryMB ?? 0), cpuPercent: acc.cpuPercent + (l.stats?.cpuPercent ?? 0) }),
      { memoryMB: 0, cpuPercent: 0 },
    );
    const disk = await dirSizeCached();
    return { limits: this.store.settings.limits, reserved: reserved(running), used, diskBytes: disk };
  }

  // ---- Domain (Cloudflare) ----

  async setDomain(id: string, zoneId: string, zoneName: string, name: string) {
    const s = this.get(id);
    const token = this.store.settings.cloudflare?.token;
    if (!token) throw new HttpError(400, "cloudflare_not_connected");
    const host = fqdn(name, zoneName);
    const taken = this.store.servers.find((x) => x.id !== id && x.domain && fqdn(x.domain.name, x.domain.zoneName) === host);
    if (taken) throw new HttpError(409, "domain_in_use", { name: taken.name });
    const ip = await this.currentPublicIp();
    // Moving to a different name: clean up the old records first.
    if (s.domain && fqdn(s.domain.name, s.domain.zoneName) !== host) await this.removeDomain(s);
    const ids = await applyDomain(token, zoneId, host, ip, s.port, s.domain?.zoneId === zoneId ? s.domain : {});
    this.store.updateServer(id, (x) => (x.domain = { zoneId, zoneName, name, ...ids }));
    return host;
  }

  async removeDomain(s: ServerConfig) {
    const token = this.store.settings.cloudflare?.token;
    if (s.domain && token) {
      if (s.domain.aRecordId) await deleteRecord(token, s.domain.zoneId, s.domain.aRecordId);
      if (s.domain.srvRecordId) await deleteRecord(token, s.domain.zoneId, s.domain.srvRecordId);
    }
    if (this.store.server(s.id)) this.store.updateServer(s.id, (x) => delete x.domain);
  }

  private async currentPublicIp(force = false) {
    const ip = this.store.settings.network.publicIp || (await publicIp(force).catch(() => undefined));
    if (!ip) throw new HttpError(502, "public_ip_unknown");
    this.lastPublicIp = ip;
    return ip;
  }

  /** Re-apply DNS records, e.g. after the port changed. */
  async refreshNetwork(s: ServerConfig) {
    const token = this.store.settings.cloudflare?.token;
    if (token && s.domain) {
      const ip = await this.currentPublicIp();
      const ids = await applyDomain(token, s.domain.zoneId, fqdn(s.domain.name, s.domain.zoneName), ip, s.port, s.domain);
      this.store.updateServer(s.id, (x) => Object.assign(x.domain!, ids));
    }
  }

  /** Dynamic DNS: when the home IP changes, point every domain at the new one. */
  async ddnsTick() {
    let ip: string;
    try {
      ip = await this.currentPublicIp(true);
    } catch {
      return;
    }
    const changed = this.lastDdnsIp !== undefined && this.lastDdnsIp !== ip;
    const first = this.lastDdnsIp === undefined;
    this.lastDdnsIp = ip;
    if (!changed && !first) return;
    for (const s of this.store.servers) {
      if (s.domain) await this.refreshNetwork(s).catch((e) => console.error(`[ddns] ${s.name}:`, e));
    }
  }
  private lastDdnsIp?: string;

  // ---- Tunnel (playit.gg) ----

  async enableTunnel(id: string) {
    const s = this.get(id);
    if (s.tunnel) return s.tunnel;
    const t = await this.playit.createTunnel(`ZimaMC ${s.name}`, s.port);
    this.store.updateServer(id, (x) => (x.tunnel = { tunnelId: t.id }));
    return this.get(id).tunnel!;
  }

  async disableTunnel(id: string) {
    const s = this.get(id);
    if (s.tunnel) await this.playit.deleteTunnel(s.tunnel.tunnelId);
    this.store.updateServer(id, (x) => delete x.tunnel);
  }

  async tunnelTick() {
    for (const s of this.store.servers) {
      if (s.tunnel && !s.tunnel.address) {
        const address = await this.playit.tunnelAddress(s.tunnel.tunnelId).catch(() => undefined);
        if (address) this.store.updateServer(s.id, (x) => (x.tunnel!.address = address));
      }
    }
  }

  /** On boot: start servers marked auto-start that Docker did not already bring back. */
  async autoStart() {
    // Pick up web maps and other add-ons installed before this version or by hand.
    for (const s of this.store.servers) await this.syncServicePorts(s.id).catch(() => false);
    for (const s of this.store.servers) {
      if (s.autoStart && !(await this.docker.isRunning(s.id))) {
        await this.start(s.id).catch((e) => console.error(`[autostart] ${s.name}:`, e));
      }
      if (s.autoStart && this.store.settings.network.upnp) this.openRouterPorts(s);
    }
  }
}

let diskCache: { at: number; bytes: number } | undefined;
async function dirSizeCached() {
  if (diskCache && Date.now() - diskCache.at < 60_000) return diskCache.bytes;
  diskCache = { at: Date.now(), bytes: await dirSize(DATA_DIR) };
  return diskCache.bytes;
}
