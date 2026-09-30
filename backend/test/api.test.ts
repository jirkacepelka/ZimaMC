import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { DATA_DIR } from "../src/config.js";
import { DockerManager } from "../src/docker.js";
import type { ServerConfig } from "../src/store.js";

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
  override async rcon(_id: string, cmd: string) {
    return cmd === "list" ? "There are 0 of a max of 5 players online:" : "";
  }
}

const docker = new FakeDocker();
let app: Awaited<ReturnType<typeof buildApp>>["app"];
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
  ({ app } = await buildApp({ docker, staticDir: "/nonexistent" }));
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
    const r = await req("POST", "/api/servers", { name: "Survival", type: "PAPER", size: "medium" });
    expect(r.statusCode).toBe(200);
    const { server, startError } = r.json();
    expect(startError).toBeUndefined();
    expect(server).toMatchObject({ name: "Survival", version: "1.21.8", memoryMB: 4096, port: expect.any(Number) });
    expect(server.properties.maxPlayers).toBe(15);
    await new Promise((r) => setTimeout(r, 20));
    expect(docker.running.has(server.id)).toBe(true);
  });

  it("enforces the global memory limit across servers", async () => {
    // 12288 MB limit, first server reserves 5120 MB; an 8 GB heap needs 10240 MB.
    const r = await req("POST", "/api/servers", { name: "Big", type: "VANILLA", version: "1.21.8", size: "large" });
    const body = r.json();
    expect(body.startError).toMatchObject({ error: "limit_memory" });
    expect(docker.running.has(body.server.id)).toBe(false);
    expect((await req("POST", `/api/servers/${body.server.id}/start`)).json().error).toBe("limit_memory");

    // Lowering its memory makes it fit.
    await req("PATCH", `/api/servers/${body.server.id}`, { memoryMB: 4096 });
    expect((await req("POST", `/api/servers/${body.server.id}/start`)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    // Two servers with 2 CPUs each share the 3-CPU global limit.
    expect([...docker.cpus.values()]).toEqual([1.5, 1.5]);
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

  it("backs up and restores a stopped server", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    await req("PUT", `/api/servers/${id}/files/content`, { path: "hello.txt", content: "before" });
    const { file } = (await req("POST", `/api/servers/${id}/backups`)).json();
    expect(file).toMatch(/\.tar\.gz$/);
    await req("PUT", `/api/servers/${id}/files/content`, { path: "hello.txt", content: "after" });

    expect((await req("POST", `/api/servers/${id}/backups/restore`, { file })).json().error).toBe("stop_server_first");
    await req("POST", `/api/servers/${id}/stop`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await req("POST", `/api/servers/${id}/backups/restore`, { file })).statusCode).toBe(200);
    expect((await req("GET", `/api/servers/${id}/files/content?path=hello.txt`)).json().content).toBe("before");
    expect((await req("POST", `/api/servers/${id}/backups/restore`, { file: "../x.tar.gz" })).json().error).toBe("invalid_path");
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

  it("deletes a server and its files", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    expect((await req("DELETE", `/api/servers/${id}`)).statusCode).toBe(200);
    expect(fs.existsSync(`${DATA_DIR}/servers/${id}`)).toBe(false);
    expect((await req("GET", `/api/servers/${id}`)).statusCode).toBe(404);
  });
});
