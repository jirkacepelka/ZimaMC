import os from "node:os";
import fs from "node:fs";
import { HttpError, type ServerConfig, type Settings } from "./store.js";

/** Memory the container gets on top of the Java heap (metaspace, threads, native libs). */
export function containerMemoryMB(heapMB: number) {
  return heapMB + Math.max(512, Math.round(heapMB * 0.25));
}

function readCgroupMemoryLimit(): number | undefined {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return Math.floor(n / 1024 / 1024);
    } catch {
      /* not available */
    }
  }
  return undefined;
}

export interface HostInfo {
  memoryMB: number;
  cpus: number;
}

export function hostInfo(dockerInfo?: { MemTotal?: number; NCPU?: number }): HostInfo {
  // Docker's view of the host is the most accurate when running in a container.
  const memoryMB = dockerInfo?.MemTotal
    ? Math.floor(dockerInfo.MemTotal / 1024 / 1024)
    : Math.min(Math.floor(os.totalmem() / 1024 / 1024), readCgroupMemoryLimit() ?? Infinity);
  const cpus = dockerInfo?.NCPU ?? os.availableParallelism();
  return { memoryMB, cpus };
}

/** Suggested global limit on first run: leave a quarter of the machine for ZimaOS and other apps. */
export function defaultLimits(host: HostInfo) {
  return {
    memoryMB: Math.max(1024, Math.floor((host.memoryMB * 0.75) / 256) * 256),
    cpus: Math.max(1, Math.floor(host.cpus * 0.75 * 2) / 2),
  };
}

export function reserved(servers: ServerConfig[]) {
  return servers.reduce(
    (acc, s) => ({ memoryMB: acc.memoryMB + containerMemoryMB(s.memoryMB), cpus: acc.cpus + s.cpus }),
    { memoryMB: 0, cpus: 0 },
  );
}

/**
 * The global limit is a budget, not a reservation: servers rarely all use their
 * full share at the same time, so the limits of the running servers may add up to
 * more than the budget. Only a single server may not ask for more than the whole
 * budget, which is checked when it is created or edited (see assertServerLimits).
 */

/**
 * CPU caps for running servers. Each keeps its own limit, but never more than
 * the global CPU limit. Docker applies this live.
 */
export function effectiveCpus(running: Pick<ServerConfig, "id" | "cpus">[], globalCpus: number) {
  return new Map(running.map((s) => [s.id, globalCpus > 0 ? Math.min(s.cpus, globalCpus) : s.cpus]));
}

/** Validate a single server's own limits against the global cap and sane bounds. */
export function assertServerLimits(settings: Settings, memoryMB: number, cpus: number) {
  if (!Number.isFinite(memoryMB) || memoryMB < 512) throw new HttpError(400, "memory_too_low");
  if (!Number.isFinite(cpus) || cpus < 0.25) throw new HttpError(400, "cpu_too_low");
  const lim = settings.limits;
  if (lim.memoryMB > 0 && containerMemoryMB(memoryMB) > lim.memoryMB) {
    throw new HttpError(400, "limit_memory", { need: containerMemoryMB(memoryMB), free: lim.memoryMB });
  }
  if (lim.cpus > 0 && cpus > lim.cpus) throw new HttpError(400, "limit_cpu", { need: cpus, free: lim.cpus });
}
