import Docker from "dockerode";
import { PassThrough, type Readable } from "node:stream";
import { CONTAINER_PREFIX, HOST_DATA_DIR, MC_IMAGE } from "./config.js";
import { containerEnv, imageTag } from "./minecraft.js";
import { containerMemoryMB } from "./resources.js";
import type { ServerConfig } from "./store.js";

export type ServerStatus = "offline" | "downloading" | "starting" | "online" | "stopping" | "crashed";

export interface ServerStats {
  cpuPercent: number;
  memoryMB: number;
  memoryLimitMB: number;
}

export const containerName = (id: string) => `${CONTAINER_PREFIX}srv-${id}`;

export class DockerManager {
  docker: Docker;
  /** Image pulls in progress, by server id, with a 0-100 progress estimate. */
  pulling = new Map<string, number>();
  stopping = new Set<string>();

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
  }

  async info() {
    return this.docker.info() as Promise<{ MemTotal: number; NCPU: number; ServerVersion: string }>;
  }

  async hasImage(ref: string) {
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** Pull an image, reporting rough progress (share of layers finished). */
  async pull(ref: string, onProgress?: (pct: number) => void) {
    const stream = await this.docker.pull(ref);
    const layers = new Map<string, boolean>();
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (ev: { id?: string; status?: string }) => {
          if (!ev.id || !ev.status) return;
          if (/Pulling fs layer|Waiting|Downloading|Extracting/.test(ev.status)) layers.set(ev.id, layers.get(ev.id) ?? false);
          if (/Pull complete|Already exists/.test(ev.status)) layers.set(ev.id, true);
          const done = [...layers.values()].filter(Boolean).length;
          if (layers.size) onProgress?.(Math.round((done / layers.size) * 100));
        },
      );
    });
  }

  container(id: string) {
    return this.docker.getContainer(containerName(id));
  }

  async inspect(id: string) {
    try {
      return await this.container(id).inspect();
    } catch {
      return null;
    }
  }

  async status(id: string): Promise<ServerStatus> {
    if (this.pulling.has(id)) return "downloading";
    const info = await this.inspect(id);
    if (!info) return "offline";
    const st = info.State;
    if (st.Running) {
      if (this.stopping.has(id)) return "stopping";
      const health = st.Health?.Status;
      return health === "healthy" ? "online" : "starting";
    }
    if (st.ExitCode && st.ExitCode !== 0 && st.ExitCode !== 143 && !this.stopping.has(id)) return "crashed";
    return "offline";
  }

  async isRunning(id: string) {
    const info = await this.inspect(id);
    return Boolean(info?.State.Running);
  }

  /** (Re)create the server container from its current configuration and start it. */
  async start(s: ServerConfig) {
    const image = `${MC_IMAGE}:${imageTag(s)}`;
    if (!(await this.hasImage(image))) {
      this.pulling.set(s.id, 0);
      try {
        await this.pull(image, (p) => this.pulling.set(s.id, p));
      } finally {
        this.pulling.delete(s.id);
      }
    }
    await this.remove(s.id);
    const memBytes = containerMemoryMB(s.memoryMB) * 1024 * 1024;
    const c = await this.docker.createContainer({
      name: containerName(s.id),
      Image: image,
      Env: Object.entries(containerEnv(s)).map(([k, v]) => `${k}=${v}`),
      Labels: { "zimamc.server": s.id, "zimamc.name": s.name },
      ExposedPorts: Object.fromEntries([["25565/tcp", {}], ...(s.extraPorts ?? []).map((p) => [`${p.containerPort}/${p.protocol}`, {}])]),
      Tty: false,
      OpenStdin: true,
      HostConfig: {
        Binds: [`${HOST_DATA_DIR}/servers/${s.id}:/data`],
        PortBindings: Object.fromEntries([
          ["25565/tcp", [{ HostPort: String(s.port) }]],
          ...(s.extraPorts ?? []).map((p) => [`${p.containerPort}/${p.protocol}`, [{ HostPort: String(p.hostPort) }]]),
        ]),
        Memory: memBytes,
        MemorySwap: memBytes,
        NanoCpus: Math.round(s.cpus * 1e9),
        // Retry a crash a few times, then stay down so the UI can show "crashed".
        // Starting after a reboot is handled by ZimaMC itself (autoStart).
        RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    await c.start();
  }

  /** Change a running container's CPU cap without restarting it. */
  async setCpus(id: string, cpus: number) {
    const info = await this.inspect(id);
    const nano = Math.round(cpus * 1e9);
    if (!info?.State.Running || info.HostConfig.NanoCpus === nano) return;
    await this.container(id).update({ NanoCpus: nano });
  }

  async stop(id: string) {
    this.stopping.add(id);
    try {
      // itzg's image saves the world and shuts down cleanly on SIGTERM.
      await this.container(id).stop({ t: 90 });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 304 && (e as { statusCode?: number }).statusCode !== 404) throw e;
    } finally {
      this.stopping.delete(id);
    }
  }

  async kill(id: string) {
    try {
      await this.container(id).kill();
    } catch {
      /* already stopped */
    }
  }

  async remove(id: string) {
    try {
      await this.container(id).remove({ force: true });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  }

  async stats(id: string): Promise<ServerStats | null> {
    try {
      const st = (await this.container(id).stats({ stream: false })) as unknown as {
        cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
        precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
        memory_stats: { usage?: number; limit?: number; stats?: { cache?: number; inactive_file?: number } };
      };
      const cpuDelta = st.cpu_stats.cpu_usage.total_usage - st.precpu_stats.cpu_usage.total_usage;
      const sysDelta = st.cpu_stats.system_cpu_usage - st.precpu_stats.system_cpu_usage;
      const ncpu = st.cpu_stats.online_cpus ?? 1;
      const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0;
      const cache = st.memory_stats.stats?.inactive_file ?? st.memory_stats.stats?.cache ?? 0;
      const used = Math.max(0, (st.memory_stats.usage ?? 0) - cache);
      return {
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memoryMB: Math.round(used / 1024 / 1024),
        memoryLimitMB: Math.round((st.memory_stats.limit ?? 0) / 1024 / 1024),
      };
    } catch {
      return null;
    }
  }

  /** Run a command in the server container and return its output. */
  async exec(id: string, cmd: string[]): Promise<string> {
    const ex = await this.container(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await ex.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    this.docker.modem.demuxStream(stream, out, out);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
      setTimeout(resolve, 15_000);
    });
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Send a console command through RCON (the image ships a preconfigured rcon-cli). */
  async rcon(id: string, command: string) {
    const out = await this.exec(id, ["rcon-cli", command]);
    // Strip Minecraft colour codes.
    return out.replace(/§[0-9a-fk-or]/gi, "").trim();
  }

  /** Stream the container's log (stdout + stderr) as text. */
  async logs(id: string, tail: number): Promise<Readable> {
    const raw = (await this.container(id).logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail,
    })) as unknown as Readable;
    const out = new PassThrough();
    this.docker.modem.demuxStream(raw, out, out);
    raw.on("end", () => out.end());
    raw.on("error", (e) => out.destroy(e));
    out.on("close", () => (raw as Readable & { destroy?: () => void }).destroy?.());
    return out;
  }

  /** Every container ZimaMC created, including ones whose server no longer exists. */
  async listManaged() {
    return this.docker.listContainers({ all: true, filters: { label: ["zimamc.server"] } });
  }
}
