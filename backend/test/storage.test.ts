import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BYTES_PER_CHUNK, chunksForRadius, chunksPerSecond, cpuBenchmark, diskBenchmark } from "../src/benchmark.js";
import { DATA_DIR, toHostPath } from "../src/config.js";
import { demux } from "../src/docker.js";
import { parseChunkyProgress } from "../src/minecraft.js";
import { listLocations, prepareBase, startMove, type CopyJob } from "../src/storage.js";
import { HttpError } from "../src/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-disk-"));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as HttpError).code;
  }
  return null;
};

describe("storage", () => {
  afterEach(() => {
    delete process.env.STORAGE_ROOTS;
  });

  it("offers the data folder first and a ZimaMC folder on each other disk", async () => {
    const a = tmp();
    const b = tmp();
    process.env.STORAGE_ROOTS = `${a},${b}`;
    const locs = await listLocations();
    expect(locs[0]).toMatchObject({ path: DATA_DIR, default: true });
    expect(locs.map((l) => l.path)).toEqual(expect.arrayContaining([path.join(a, "ZimaMC"), path.join(b, "ZimaMC")]));
    expect(locs.every((l) => l.totalBytes >= l.freeBytes)).toBe(true);
  });

  it("lists bases in use even if no disk offers them", async () => {
    const custom = path.join(tmp(), "ZimaMC");
    expect((await listLocations([custom])).some((l) => l.path === custom)).toBe(true);
  });

  it("checks folders the user typed", async () => {
    const a = tmp();
    expect(await prepareBase(a)).toBe(path.join(a, "ZimaMC"));
    expect(fs.existsSync(path.join(a, "ZimaMC"))).toBe(true);
    expect(await prepareBase(path.join(a, "ZimaMC"))).toBe(path.join(a, "ZimaMC"));
    expect(await prepareBase(DATA_DIR)).toBe(DATA_DIR);
    expect(await code(prepareBase("relative/path"))).toBe("invalid_path");
    const file = path.join(a, "file.txt");
    fs.writeFileSync(file, "x");
    expect(await code(prepareBase(path.join(file, "inside")))).toBe("storage_not_writable");
  });

  it("moves a folder: copies, switches over, deletes the original", async () => {
    const from = path.join(tmp(), "srv");
    fs.mkdirSync(path.join(from, "world", "region"), { recursive: true });
    fs.writeFileSync(path.join(from, "world", "region", "r.0.0.mca"), Buffer.alloc(5000, 1));
    fs.writeFileSync(path.join(from, "server.properties"), "motd=hi");
    const to = path.join(tmp(), "ZimaMC", "servers", "srv");
    const job: CopyJob = { state: "copying", copied: 0, total: 0 };
    let switched = false;
    const { done } = await startMove(from, to, job, () => {
      switched = true;
    });
    await done;
    expect(job).toMatchObject({ state: "done", copied: 5007, total: 5007 });
    expect(switched).toBe(true);
    expect(fs.readFileSync(path.join(to, "server.properties"), "utf8")).toBe("motd=hi");
    expect(fs.existsSync(from)).toBe(false);
  });

  it("keeps the original when the switch fails, and refuses a non-empty target", async () => {
    const from = path.join(tmp(), "srv");
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, "a.txt"), "a");
    const to = path.join(tmp(), "dest");
    const job: CopyJob = { state: "copying", copied: 0, total: 0 };
    const { done } = await startMove(from, to, job, () => {
      throw new HttpError(500, "boom");
    });
    await done;
    expect(job).toMatchObject({ state: "failed", error: "boom" });
    expect(fs.existsSync(path.join(from, "a.txt"))).toBe(true);
    expect(fs.existsSync(to)).toBe(false);

    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, "other.txt"), "x");
    expect(await code(startMove(from, to, { state: "copying", copied: 0, total: 0 }, () => {}))).toBe("target_exists");
  });

  it("maps the data folder to the host path and leaves other disks alone", () => {
    expect(toHostPath(path.join(DATA_DIR, "servers", "a"))).toBe(path.join(DATA_DIR, "servers", "a"));
    expect(toHostPath("/media/Games/ZimaMC/servers/a")).toBe("/media/Games/ZimaMC/servers/a");
  });
});

describe("Chunky estimate", () => {
  it("counts chunks of a square radius", () => {
    expect(chunksForRadius(1000)).toBe(15625);
    expect(chunksForRadius(5000)).toBe(390625);
    // 1000 blocks: about 180 MB.
    expect(Math.round((chunksForRadius(1000) * BYTES_PER_CHUNK) / 1e6)).toBe(192);
  });

  it("scales with cores, CPU speed and server type", () => {
    const base = chunksPerSecond("PAPER", 2, 8, 9_000_000);
    expect(chunksPerSecond("PAPER", 4, 8, 9_000_000)).toBeCloseTo(base * 2);
    // Never more cores than the machine has.
    expect(chunksPerSecond("PAPER", 16, 4, 9_000_000)).toBeCloseTo(base * 2);
    expect(chunksPerSecond("PAPER", 2, 8, 18_000_000)).toBeCloseTo(base * 2);
    expect(chunksPerSecond("FABRIC", 2, 8, 9_000_000)).toBeLessThan(base);
  });

  it("benchmarks the CPU in a worker and the disk with a small file", async () => {
    expect(await cpuBenchmark(100)).toBeGreaterThan(0);
    const dir = tmp();
    expect(await diskBenchmark(dir, 2)).toBeGreaterThan(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("Chunky progress", () => {
  it("reads the newest status line from the log", () => {
    const log = [
      "[12:00:01 INFO]: [Chunky] Task running for minecraft:overworld. Processed: 1,000 chunks (0.26%), ETA: 1:02:03, Rate: 104.2 cps, Current: 112, -304",
      "[12:00:11 INFO]: [Chunky] Task running for minecraft:overworld. Processed: 2,000 chunks (0.51%), ETA: 1:01:00, Rate: 99.5 cps, Current: 128, -304",
    ].join("\n");
    expect(parseChunkyProgress(log)).toEqual({ state: "running", world: "minecraft:overworld", chunks: 2000, percent: 0.51, eta: "1:01:00", rate: 99.5 });
    expect(parseChunkyProgress(log + "\n[Chunky] Task finished for minecraft:overworld. Processed: 390,625 chunks (100.00%), Total time: 1:05:20")).toMatchObject({
      state: "finished",
      percent: 100,
      chunks: 390625,
    });
    expect(parseChunkyProgress("[Server thread/INFO]: [Chunky] Task stopped for world.")).toMatchObject({ state: "paused", world: "world" });
    expect(parseChunkyProgress("Done (3.2s)! For help, type \"help\"")).toBeNull();
  });
});

describe("docker logs", () => {
  it("splits multiplexed frames", () => {
    const frame = (s: string) => Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0, 0, Buffer.byteLength(s)]), Buffer.from(s)]);
    expect(demux(Buffer.concat([frame("hello\n"), frame("world\n")]))).toBe("hello\nworld\n");
    expect(demux(Buffer.from("plain text"))).toBe("plain text");
  });
});
