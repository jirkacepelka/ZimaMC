import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ServerType, Store } from "./store.js";

/**
 * A short, silent benchmark for the Chunky time estimate. The CPU part runs
 * layered value noise (what terrain generation spends its time on) in a worker
 * thread, so the web server stays responsive. The disk part writes a small file.
 */

const CPU_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const start = Date.now();
let n = 0, acc = 0;
while (Date.now() - start < workerData.ms) {
  for (let i = 0; i < 1000; i++) {
    let f = 1, amp = 1;
    for (let o = 0; o < 4; o++) { acc += noise((n + i) * 0.013 * f, i * 0.017 * f) * amp; f *= 2; amp *= 0.5; }
  }
  n += 1000;
}
parentPort.postMessage({ perSecond: (n * 1000) / (Date.now() - start), acc });
`;

/** Noise samples per second on one core. */
export function cpuBenchmark(ms = 800): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(CPU_WORKER, { eval: true, workerData: { ms } });
    w.once("message", (m: { perSecond: number }) => resolve(m.perSecond));
    w.once("error", reject);
    w.once("exit", (code) => code !== 0 && reject(new Error(`benchmark worker exited with ${code}`)));
  });
}

/** Sequential write speed in MB/s of the folder (or its closest existing parent). */
export async function diskBenchmark(dir: string, mb = 32): Promise<number> {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `.zimamc-bench-${process.pid}`);
  const block = Buffer.alloc(1024 * 1024, 7);
  const t0 = performance.now();
  const fh = await fsp.open(file, "w");
  try {
    for (let i = 0; i < mb; i++) await fh.write(block);
    await fh.sync();
  } finally {
    await fh.close();
    await fsp.rm(file, { force: true });
  }
  return mb / Math.max(0.001, (performance.now() - t0) / 1000);
}

/**
 * Calibration. REF_SCORE is what cpuBenchmark gives on a typical current desktop
 * or NAS core (measured on a cloud vCPU). On such a core, Chunky generates about
 * PER_CORE chunks per second per core with Paper, which uses several threads for
 * world generation; Fabric and Forge are slower. Figures from Chunky users report
 * roughly 100–250 chunks/s on 4–8 cores for Paper 1.21.
 */
export const REF_SCORE = 9_000_000;
const PER_CORE: Record<ServerType, number> = { PAPER: 30, FOLIA: 34, FABRIC: 14, FORGE: 12, VANILLA: 12 };

/** A fully generated 1.18+ region (1024 chunks) is 10–12 MB, plus entities and points of interest. */
export const BYTES_PER_CHUNK = 12 * 1024;

/** Chunks in a square of the given radius in blocks, like Chunky's default shape. */
export const chunksForRadius = (radius: number) => Math.ceil((2 * radius) / 16) ** 2;

export function chunksPerSecond(type: ServerType, cpus: number, hostCpus: number, cpuScore: number) {
  const cores = Math.max(1, Math.min(cpus, hostCpus));
  const speed = Math.min(3, Math.max(0.2, cpuScore / REF_SCORE));
  return Math.max(1, cores * PER_CORE[type] * speed * 0.85);
}

/** Runs each benchmark once and remembers the result; the CPU score survives restarts. */
export class Benchmarks {
  private cpu?: Promise<number>;
  private disks = new Map<string, Promise<number>>();
  private diskDone = new Map<string, number>();

  constructor(private store: Store) {}

  get cpuScore() {
    return this.store.settings.benchmark?.cpuScore;
  }

  /** Start whatever has not run yet. Never throws. */
  start(diskDir?: string) {
    if (!this.cpuScore && !this.cpu) {
      this.cpu = cpuBenchmark()
        .then((cpuScore) => {
          this.store.settings.benchmark = { cpuScore: Math.round(cpuScore), at: new Date().toISOString() };
          this.store.save();
          return cpuScore;
        })
        .catch((e) => {
          console.error("[benchmark]", e);
          this.cpu = undefined;
          return 0;
        });
    }
    if (diskDir && !this.disks.has(diskDir)) {
      this.disks.set(
        diskDir,
        diskBenchmark(diskDir)
          .then((v) => (this.diskDone.set(diskDir, v), v))
          .catch(() => (this.diskDone.set(diskDir, 0), 0)),
      );
    }
  }

  /** Results, or undefined while something is still running. */
  results(diskDir: string) {
    this.start(diskDir);
    const disk = this.diskDone.get(diskDir);
    if (!this.cpuScore || disk === undefined) return undefined;
    return { cpuScore: this.cpuScore, diskMBps: disk };
  }
}
