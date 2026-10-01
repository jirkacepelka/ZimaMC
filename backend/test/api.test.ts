import fs from "node:fs";
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

  it("deletes a server and its files", async () => {
    const id = (await req("GET", "/api/servers")).json().servers[0].id;
    expect((await req("DELETE", `/api/servers/${id}`)).statusCode).toBe(200);
    expect(fs.existsSync(`${DATA_DIR}/servers/${id}`)).toBe(false);
    expect((await req("GET", `/api/servers/${id}`)).statusCode).toBe(404);
  });
});
