import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { DATA_DIR } from "../src/config.js";
import { DockerManager } from "../src/docker.js";
import type { ServerConfig } from "../src/store.js";
import { makeZip } from "./zip.js";

/** Docker stand-in: tracks which servers "run" without touching a daemon. */
class FakeDocker extends DockerManager {
  running = new Set<string>();
  override async info() {
    return { MemTotal: 16 * 1024 ** 3, NCPU: 4, ServerVersion: "fake" };
  }
  override async isRunning(id: string) {
    return this.running.has(id);
  }
  override async status(id: string) {
    return this.running.has(id) ? ("online" as const) : ("offline" as const);
  }
  override async start(s: ServerConfig) {
    this.running.add(s.id);
  }
  override async stop(id: string) {
    this.running.delete(id);
  }
  override async remove() {}
  override async setCpus(id: string, cpus: number) {
    this.cpus.set(id, cpus);
  }
  cpus = new Map<string, number>();
  override async stats() {
    return null;
  }
  sent: string[] = [];
  override async rcon(_id: string, cmd: string) {
    this.sent.push(cmd);
    return cmd === "list" ? "There are 0 of a max of 5 players online:" : "";
  }
}

const docker = new FakeDocker();
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";

beforeAll(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("papermc.io")) return new Response(JSON.stringify({ versions: ["1.20.6", "1.21.8", "1.21.4"] }));
      return new Response("blocked", { status: 503 });
    }),
  );
  built = await buildApp({ docker, staticDir: "/nonexistent" });
  ({ app } = built);
});

afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const req = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url, payload: payload as never, headers: cookie ? { cookie } : {} });

describe("API", () => {
  it("requires first-run setup, then login", async () => {
    expect((await req("GET", "/api/status")).json()).toMatchObject({ setUp: false, loggedIn: false });
    expect((await req("GET", "/api/servers")).statusCode).toBe(401);

    expect((await req("POST", "/api/setup", { password: "123" })).json().error).toBe("password_too_short");
    const r = await req("POST", "/api/setup", { password: "creeper123", language: "cs" });
    expect(r.statusCode).toBe(200);
    cookie = String(r.headers["set-cookie"]).split(";")[0];

    expect((await req("POST", "/api/setup", { password: "other123" })).statusCode).toBe(409);
    const sys = (await req("GET", "/api/system")).json();
    expect(sys.settings.limits).toEqual({ memoryMB: 12288, cpus: 3 });
    expect(sys.settings.auth).toBeUndefined();
  });

  it("rejects a wrong password and rate limits guessing", async () => {
    const saved = cookie;
    cookie = "";
    for (let i = 0; i < 5; i++) expect((await req("POST", "/api/login", { password: "nope" })).statusCode).toBe(401);
    expect((await req("POST", "/api/login", { password: "creeper123" })).statusCode).toBe(429);
    cookie = saved;
  });

  it("creates a server with the newest version and starts it", async () => {
    const r = await req("POST", "/api/servers", { name: "Survival", type: "PAPER", size: "medium", maxPlayers: 12 });
    expect(r.statusCode).toBe(200);
    const { server, startError } = r.json();
    expect(startError).toBeUndefined();
    expect(server).toMatchObject({ name: "Survival", version: "1.21.8", memoryMB: 4096, port: expect.any(Number) });
    expect(server.properties.maxPlayers).toBe(12);
    await new Promise((r) => setTimeout(r, 20));
    expect(docker.running.has(server.id)).toBe(true);
  });

  it("lets servers add up to more than the global limit, but not one above it", async () => {
    // Limit is 12288 MB. The first server needs 5120 MB, an 8 GB heap needs 10240 MB: together more than the limit.
    const r = await req("POST", "/api/servers", { name: "Big", type: "VANILLA", version: "1.21.8", size: "large" });
    const body = r.json();
    expect(body.startError).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(docker.running.has(body.server.id)).toBe(true);
    // Each keeps its own CPU limit even though 2 + 2 is more than the 3-CPU budget.
    expect([...docker.cpus.values()]).toEqual([2, 2]);

    // A single server above the whole budget is still refused.
    const huge = await req("POST", "/api/servers", { name: "Huge", type: "VANILLA", version: "1.21.8", memoryMB: 12000, start: false });
    expect(huge.json().error).toBe("limit_memory");
  });

  it("takes the player limit from the user", async () => {
    expect((await req("POST", "/api/servers", { name: "Z", type: "PAPER", version: "1.21.8", maxPlayers: 0, start: false })).json().error).toBe("invalid_max_players");
    const r = await req("POST", "/api/servers", { name: "Z", type: "PAPER", version: "1.21.8", maxPlayers: 7, start: false });
    expect(r.json().server.properties.maxPlayers).toBe(7);
    await req("DELETE", `/api/servers/${r.json().server.id}`);
  });

  it("rejects duplicate ports and bad input", async () => {
    const list = (await req("GET", "/api/servers")).json().servers;
    const r = await req("POST", "/api/servers", { name: "X", type: "PAPER", version: "1.21.8", port: list[0].port, start: false });
    expect(r.json().error).toBe("port_in_use");
    expect((await req("POST", "/api/servers", { name: "", type: "PAPER" })).json().error).toBe("name_required");
    expect((await req("POST", "/api/servers", { name: "Y", type: "BEDROCK" })).json().error).toBe("invalid_type");
  });

  it("edits files inside the server folder only", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    expect((await req("PUT", `/api/servers/${id}/files/content`, { path: "hello.txt", content: "hi" })).statusCode).toBe(200);
    expect((await req("GET", `/api/servers/${id}/files/content?path=hello.txt`)).json().content).toBe("hi");
    expect((await req("GET", `/api/servers/${id}/files/content?path=../../zimamc.json`)).json().error).toBe("invalid_path");
    const names = (await req("GET", `/api/servers/${id}/files`)).json().entries.map((e: { name: string }) => e.name);
    expect(names).toContain("hello.txt");
  });

  it("finds a plugin's settings folder and its commands", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    const dir = path.join(DATA_DIR, "servers", id, "plugins");
    fs.mkdirSync(path.join(dir, "Essentials"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Essentials-2.20.jar"), makeZip({ "plugin.yml": "name: Essentials\ncommands:\n  home:\n    description: Go home\n" }));
    const items = (await req("GET", `/api/servers/${id}/content`)).json().items;
    expect(items).toEqual([expect.objectContaining({ fileName: "Essentials-2.20.jar", name: "Essentials", configPaths: ["plugins/Essentials"] })]);
    const cmds = (await req("GET", `/api/servers/${id}/commands`)).json();
    expect(cmds.plugins).toEqual([{ name: "Essentials", commands: [expect.objectContaining({ name: "home", description: "Go home" })] }]);
  });

  it("backs up and restores a stopped server", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    await req("PUT", `/api/servers/${id}/files/content`, { path: "hello.txt", content: "before" });
    const { file } = (await req("POST", `/api/servers/${id}/backups`)).json();
    expect(file).not.toMatch(/\.tar\.gz$/);
    await req("PUT", `/api/servers/${id}/files/content`, { path: "hello.txt", content: "after" });

    expect((await req("POST", `/api/servers/${id}/backups/restore`, { file })).json().error).toBe("stop_server_first");
    await req("POST", `/api/servers/${id}/stop`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await req("POST", `/api/servers/${id}/backups/restore`, { file })).statusCode).toBe(200);
    expect((await req("GET", `/api/servers/${id}/files/content?path=hello.txt`)).json().content).toBe("before");
    expect((await req("POST", `/api/servers/${id}/backups/restore`, { file: "../x.tar.gz" })).json().error).toBe("invalid_path");
    // Playing on the restored world must not change the backup.
    await req("PUT", `/api/servers/${id}/files/content`, { path: "hello.txt", content: "changed again" });
    expect(fs.readFileSync(path.join(DATA_DIR, "backups", id, file, "hello.txt"), "utf8")).toBe("before");
  });

  it("stores unchanged files only once in incremental backups", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    const region = path.join(DATA_DIR, "servers", id, "world", "region");
    fs.mkdirSync(region, { recursive: true });
    fs.writeFileSync(path.join(region, "r.0.0.mca"), Buffer.alloc(200_000, 3));
    // Downloaded server files are never backed up.
    fs.mkdirSync(path.join(DATA_DIR, "servers", id, "libraries"), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "servers", id, "libraries", "big.jar"), "x");

    const a = (await req("POST", `/api/servers/${id}/backups`)).json().file;
    const b = (await req("POST", `/api/servers/${id}/backups`)).json().file;
    const list = (await req("GET", `/api/servers/${id}/backups`)).json();
    const ba = list.backups.find((x: { file: string }) => x.file === a);
    const bb = list.backups.find((x: { file: string }) => x.file === b);
    expect(bb).toMatchObject({ kind: "incremental", added: 0 });
    expect(bb.size).toBe(ba.size);
    const ino = (f: string) => fs.statSync(path.join(DATA_DIR, "backups", id, f, "world", "region", "r.0.0.mca")).ino;
    expect(ino(a)).toBe(ino(b));
    expect(fs.existsSync(path.join(DATA_DIR, "backups", id, b, "libraries"))).toBe(false);
    // Real space: the region file counts once.
    expect(list.diskBytes).toBeLessThan(ba.size * 2);

    // A changed file is copied, the rest stays shared.
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(region, "r.0.0.mca"), Buffer.alloc(200_001, 4));
    const c = (await req("POST", `/api/servers/${id}/backups`)).json().file;
    const bc = (await req("GET", `/api/servers/${id}/backups`)).json().backups.find((x: { file: string }) => x.file === c);
    expect(bc.added).toBeGreaterThanOrEqual(200_001);
    expect(ino(c)).not.toBe(ino(b));

    // Deleting an older backup keeps the newer ones whole.
    await req("DELETE", `/api/servers/${id}/backups?file=${a}`);
    expect(fs.statSync(path.join(DATA_DIR, "backups", id, b, "world", "region", "r.0.0.mca")).size).toBe(200_000);

    // Download as .tar.gz.
    const dl = await app.inject({ method: "GET", url: `/api/servers/${id}/backups/download?file=${b}`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toContain(`${b}.tar.gz`);
    expect(dl.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("lets the user pick full backups or none", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    await req("PATCH", `/api/servers/${id}`, { backup: { mode: "full" } });
    expect((await req("POST", `/api/servers/${id}/backups`)).json().file).toMatch(/\.tar\.gz$/);
    const kinds = (await req("GET", `/api/servers/${id}/backups`)).json().backups.map((b: { kind: string }) => b.kind);
    expect(kinds).toContain("full");
    expect(kinds).toContain("incremental");
    await req("PATCH", `/api/servers/${id}`, { backup: { mode: "incremental" } });

    const r = (await req("POST", "/api/servers", { name: "NoBackups", type: "VANILLA", version: "1.21.8", backup: { everyHours: 0 }, start: false })).json();
    expect(r.server.backup).toMatchObject({ everyHours: 0, mode: "incremental" });
    await req("DELETE", `/api/servers/${r.server.id}`);
  });

  it("manages players on a stopped server through its files", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    await req("PATCH", `/api/servers/${id}`, { properties: { onlineMode: false } });
    expect((await req("POST", `/api/servers/${id}/players`, { list: "ops", name: "Steve", add: true })).statusCode).toBe(200);
    expect((await req("GET", `/api/servers/${id}/players`)).json().ops).toEqual(["Steve"]);
    expect((await req("POST", `/api/servers/${id}/players`, { list: "ops", name: "x y", add: true })).json().error).toBe(
      "invalid_player_name",
    );
  });

  it("publishes the port of a web map plugin and lets users add their own ports", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    await req("POST", `/api/servers/${id}/files/mkdir`, { path: "plugins" });
    await req("PUT", `/api/servers/${id}/files/content`, { path: "plugins/squaremap-paper-1.3.jar", content: "jar" });
    await req("POST", `/api/servers/${id}/stop`);
    await new Promise((r) => setTimeout(r, 20));
    await req("POST", `/api/servers/${id}/start`);
    await new Promise((r) => setTimeout(r, 50));
    const s = (await req("GET", `/api/servers/${id}`)).json().server;
    expect(s.services).toEqual([expect.objectContaining({ containerPort: 8080, protocol: "tcp", service: "squaremap", kind: "web", url: expect.stringMatching(/^http:\/\/.+:\d+$/) })]);

    // A hand-added port can't reuse a port another server or service has.
    const mapPort = s.services[0].hostPort;
    expect((await req("PUT", `/api/servers/${id}/ports`, { ports: [{ containerPort: 9000, hostPort: mapPort, protocol: "tcp" }] })).json().error).toBe("port_in_use");
    expect((await req("PUT", `/api/servers/${id}/ports`, { ports: [{ containerPort: 9000, hostPort: 80 }] })).json().error).toBe("invalid_port");
    expect((await req("PUT", `/api/servers/${id}/ports`, { ports: [{ containerPort: 9000, hostPort: 9000, protocol: "udp", label: "Test" }] })).statusCode).toBe(200);
    const after = (await req("GET", `/api/servers/${id}`)).json().server.extraPorts;
    expect(after.map((p: { service?: string; hostPort: number }) => p.service ?? p.hostPort)).toEqual(["squaremap", 9000]);

    // Removing the plugin removes its port on the next start; hand-added ports stay.
    await req("DELETE", `/api/servers/${id}/files?path=plugins/squaremap-paper-1.3.jar`);
    await req("POST", `/api/servers/${id}/stop`);
    await new Promise((r) => setTimeout(r, 20));
    await req("POST", `/api/servers/${id}/start`);
    await new Promise((r) => setTimeout(r, 50));
    expect((await req("GET", `/api/servers/${id}`)).json().server.extraPorts).toEqual([expect.objectContaining({ hostPort: 9000, protocol: "udp" })]);
  });

  it("keeps a server on another disk and moves it back", async () => {
    const disk = fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-disk-"));
    const r = await req("POST", "/api/servers", { name: "Disk", type: "PAPER", version: "1.21.8", maxPlayers: 5, storage: disk, start: false });
    expect(r.statusCode).toBe(200);
    const s = r.json().server;
    expect(s.storagePath).toBe(path.join(disk, "ZimaMC"));
    await req("PUT", `/api/servers/${s.id}/files/content`, { path: "hello.txt", content: "on the disk" });
    expect(fs.readFileSync(path.join(disk, "ZimaMC", "servers", s.id, "hello.txt"), "utf8")).toBe("on the disk");

    const storage = (await req("GET", "/api/storage")).json();
    expect(storage.locations.map((l: { path: string }) => l.path)).toContain(path.join(disk, "ZimaMC"));

    // Moving needs a stopped server.
    await req("POST", `/api/servers/${s.id}/start`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await req("POST", `/api/servers/${s.id}/move`, { storage: DATA_DIR })).json().error).toBe("server_must_be_stopped");
    await req("POST", `/api/servers/${s.id}/stop`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await req("POST", `/api/servers/${s.id}/move`, { storage: DATA_DIR })).statusCode).toBe(200);
    for (let i = 0; i < 50 && (await req("GET", `/api/servers/${s.id}`)).json().server.move?.state === "copying"; i++) await new Promise((r) => setTimeout(r, 20));
    const moved = (await req("GET", `/api/servers/${s.id}`)).json().server;
    expect(moved).toMatchObject({ storagePath: DATA_DIR, move: { state: "done" } });
    expect((await req("GET", `/api/servers/${s.id}/files/content?path=hello.txt`)).json().content).toBe("on the disk");
    expect(fs.existsSync(path.join(disk, "ZimaMC", "servers", s.id))).toBe(false);
    await req("DELETE", `/api/servers/${s.id}`);
  });

  it("moves backups to another disk", async () => {
    const disk = fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-disk-"));
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    const { file } = (await req("POST", `/api/servers/${id}/backups`)).json();
    expect((await req("PUT", "/api/storage/backups", { storage: disk })).statusCode).toBe(200);
    for (let i = 0; i < 50 && (await req("GET", "/api/storage")).json().backupsMove?.state === "copying"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await req("GET", "/api/storage")).json()).toMatchObject({ backups: path.join(disk, "ZimaMC"), backupsMove: { state: "done" } });
    expect(fs.existsSync(path.join(disk, "ZimaMC", "backups", id, file))).toBe(true);
    expect((await req("GET", `/api/servers/${id}/backups`)).json().backups.map((b: { file: string }) => b.file)).toContain(file);
    // And back, so the other tests find their backups where they expect them.
    await req("PUT", "/api/storage/backups", { storage: DATA_DIR });
    for (let i = 0; i < 50 && (await req("GET", "/api/storage")).json().backupsMove?.state === "copying"; i++) await new Promise((r) => setTimeout(r, 20));
  });

  it("offers Chunky only with plugins or mods, and still creates the server if it can't be installed", async () => {
    expect((await req("POST", "/api/servers", { name: "V", type: "VANILLA", version: "1.21.8", pregen: { radius: 1000 }, start: false })).json().error).toBe("no_plugins_for_vanilla");
    expect((await req("POST", "/api/servers", { name: "P", type: "PAPER", version: "1.21.8", pregen: { radius: 5 }, start: false })).json().error).toBe("invalid_radius");
    // Modrinth is unreachable in tests.
    const r = (await req("POST", "/api/servers", { name: "P", type: "PAPER", version: "1.21.8", pregen: { radius: 1000 }, start: false })).json();
    expect(r.pregenError).toBeDefined();
    expect(r.server.pregen).toBeUndefined();
    await req("DELETE", `/api/servers/${r.server.id}`);
  });

  it("starts the pre-generation once the server is online", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    built.store.updateServer(id, (x) => (x.pregen = { radius: 2500, state: "pending" }));
    await req("POST", `/api/servers/${id}/start`);
    await new Promise((r) => setTimeout(r, 20));
    docker.sent = [];
    await built.servers.refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(docker.sent).toEqual(expect.arrayContaining(["chunky radius 2500", "chunky start"]));
    expect(built.store.server(id)?.pregen?.state).toBe("running");
    // Only once.
    docker.sent = [];
    await built.servers.refresh();
    expect(docker.sent.filter((c) => c.startsWith("chunky"))).toEqual([]);
  });

  it("continues the pre-generation after a restart unless the user paused it", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    const restart = async () => {
      docker.running.delete(id);
      await built.servers.refresh();
      docker.running.add(id);
      docker.sent = [];
      await built.servers.refresh();
      await built.servers.refresh();
      return docker.sent.filter((c) => c.startsWith("chunky"));
    };
    built.store.updateServer(id, (x) => (x.pregen = { radius: 2500, state: "running" }));
    expect(await restart()).toEqual(["chunky continue"]);

    await req("POST", `/api/servers/${id}/command`, { command: "/chunky pause" });
    expect(built.store.server(id)?.pregen?.paused).toBe(true);
    expect(await restart()).toEqual([]);

    await req("POST", `/api/servers/${id}/command`, { command: "chunky continue" });
    expect(built.store.server(id)?.pregen?.paused).toBe(false);
    expect(await restart()).toEqual(["chunky continue"]);

    built.store.updateServer(id, (x) => x.pregen && (x.pregen.state = "done"));
    expect(await restart()).toEqual([]);
    built.store.updateServer(id, (x) => delete x.pregen);
  });

  it("estimates Chunky after a silent benchmark", async () => {
    await req("POST", "/api/benchmark", {});
    let est = (await req("GET", "/api/pregen/estimate?type=PAPER&cpus=2")).json();
    for (let i = 0; i < 100 && !est.ready; i++) {
      await new Promise((r) => setTimeout(r, 50));
      est = (await req("GET", "/api/pregen/estimate?type=PAPER&cpus=2")).json();
    }
    expect(est).toMatchObject({ ready: true, chunksPerSecond: expect.any(Number), bytesPerChunk: expect.any(Number), freeBytes: expect.any(Number) });
    expect(est.chunksPerSecond).toBeGreaterThan(0);
  });

  it("knows when Chunky is installed, for the console cheat sheet", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    fs.writeFileSync(path.join(DATA_DIR, "servers", id, "plugins", "Chunky-Bukkit-1.4.40.jar"), makeZip({ "plugin.yml": "name: Chunky\ncommands:\n  chunky:\n    description: Pre-generates chunks\n" }));
    expect((await req("GET", `/api/servers/${id}/commands`)).json().known).toEqual(["chunky"]);
  });

  it("deletes a server and its files", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    expect((await req("DELETE", `/api/servers/${id}`)).statusCode).toBe(200);
    expect(fs.existsSync(`${DATA_DIR}/servers/${id}`)).toBe(false);
    expect((await req("GET", `/api/servers/${id}`)).statusCode).toBe(404);
  });
});
