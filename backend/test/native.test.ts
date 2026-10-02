import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractZip } from "../src/native/archive.js";
import { javaMajorFor } from "../src/native/java.js";
import { escapeValue, mergeProperties, readProperty } from "../src/native/properties.js";
import { spawnSync } from "node:child_process";
import { jvmArgs, NativeRuntime, splitArgs } from "../src/native/runtime.js";
import { serverDir } from "../src/paths.js";
import { defaultProperties } from "../src/minecraft.js";
import type { ServerConfig } from "../src/store.js";
import { makeZip } from "./zip.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-native-"));
const fakeMc = path.join(import.meta.dirname, "fake-mc.mjs");
// A "java" that ignores the JVM flags and runs the fake server with node.
const fakeJava = path.join(tmp, "java");
fs.writeFileSync(fakeJava, `#!/bin/sh\nexec "${process.execPath}" "${fakeMc}" "$@"\n`, { mode: 0o755 });

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

let nextPort = 26_000 + (process.pid % 1000) * 3;
function server(over: Partial<ServerConfig> = {}): ServerConfig {
  const id = `n${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: "Test",
    type: "PAPER",
    version: "1.21.8",
    memoryMB: 1024,
    cpus: 1,
    port: nextPort++,
    properties: { ...defaultProperties("Héllo §a world", 7) },
    advanced: { jvmFlags: '-Dfoo=bar "-Dsp=a b"' },
    autoStart: false,
    projects: [],
    backup: { everyHours: 0, keep: 1 },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const runtime = (runDir = path.join(tmp, "run")) =>
  new NativeRuntime({ java: async () => fakeJava, install: async () => ["-jar", "server.jar"], runDir });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("native runtime", () => {
  const rt = runtime();
  afterAll(() => rt.shutdown());

  it("starts a server, talks RCON, shows its console and stops it", async () => {
    const s = server();
    await rt.start(s);
    expect(["starting", "online"]).toContain(await rt.status(s.id));
    await until(async () => (await rt.status(s.id)) === "online");
    expect(await rt.isRunning(s.id)).toBe(true);

    const dir = serverDir(s.id);
    const props = fs.readFileSync(path.join(dir, "server.properties"), "utf8");
    expect(readProperty(props, "max-players")).toBe("7");
    expect(readProperty(props, "motd")).toBe("Héllo §a world");
    expect(readProperty(props, "server-port")).toBe(String(s.port));
    expect(fs.readFileSync(path.join(dir, "eula.txt"), "utf8")).toContain("eula=true");
    const args = JSON.parse(fs.readFileSync(path.join(dir, "args.json"), "utf8")) as string[];
    expect(args).toEqual(expect.arrayContaining(["-Xmx1024M", "-Dfoo=bar", "-Dsp=a b", "-XX:+UseG1GC", "-jar", "server.jar", "nogui"]));

    expect(await rt.rcon(s.id, "list")).toBe("There are 0 of a max of 7 players online:");
    // A reply longer than one RCON packet arrives whole.
    expect((await rt.rcon(s.id, "help")).length).toBe(10_000);
    expect(await rt.rcon(s.id, "say hi")).toBe("");
    expect(await rt.logTail(s.id, 50)).toContain("Done (0.123s)!");
    expect(await rt.logTail(s.id, 50)).toContain("ran say hi");

    const stream = await rt.logs(s.id, 10);
    const seen: string[] = [];
    stream.on("data", (c: Buffer) => seen.push(c.toString()));
    await rt.rcon(s.id, "say later");
    await until(() => seen.join("").includes("ran say later"));
    stream.destroy();

    const st = await rt.stats(s.id);
    expect(st?.memoryLimitMB).toBeGreaterThan(1024);
    if (process.platform === "linux") expect(st?.memoryMB).toBeGreaterThan(0);

    await rt.stop(s.id);
    expect(await rt.status(s.id)).toBe("offline");
    expect(await rt.isRunning(s.id)).toBe(false);
    await expect(rt.rcon(s.id, "list")).rejects.toMatchObject({ code: "server_offline" });
    await rt.remove(s.id);
  });

  it("refuses a port that is taken", async () => {
    const a = server();
    await rt.start(a);
    await until(async () => (await rt.status(a.id)) === "online");
    await expect(rt.start(server({ port: a.port }))).rejects.toMatchObject({ code: "port_in_use" });
    await rt.remove(a.id);
  });

  it("reports a crash and starts the server again", async () => {
    const s = server();
    await rt.start(s);
    await until(async () => (await rt.status(s.id)) === "online");
    await rt.rcon(s.id, "crash");
    await until(async () => (await rt.status(s.id)) === "crashed");
    expect(await rt.logTail(s.id, 20)).toContain("stopped unexpectedly");
    await until(async () => (await rt.status(s.id)) === "online", 15_000);
    await rt.remove(s.id);
  }, 20_000);

  it("finds a port taken only on IPv6", async (ctx) => {
    const s = server();
    const blocker = net.createServer();
    const ok = await new Promise<boolean>((resolve) => {
      blocker.once("error", () => resolve(false));
      blocker.listen({ port: s.port, host: "::", ipv6Only: true }, () => resolve(true));
    });
    if (!ok) return ctx.skip(); // no IPv6 here
    try {
      await expect(rt.start(s)).rejects.toMatchObject({ code: "port_in_use" });
      expect(rt.problem(s.id)).toEqual({ code: "port_in_use", params: { port: s.port } });
    } finally {
      blocker.close();
    }
  });

  it("explains a port another program took, removes the unfinished world and does not retry", async () => {
    const s = server({ advanced: { extraEnv: { FAKE_MC_MODE: "bind_fail" } } });
    await rt.start(s);
    await until(async () => (await rt.status(s.id)) === "crashed");
    expect(rt.problem(s.id)).toEqual({ code: "port_in_use", params: { port: s.port } });
    const log = await rt.logTail(s.id, 30);
    expect(log).toContain("is used by another program");
    expect(log).toContain("new world was not finished");
    expect(log).not.toContain("Starting it again");
    expect(fs.existsSync(path.join(serverDir(s.id), "world"))).toBe(false);
    await rt.remove(s.id);
  });

  it("never removes a world that existed before", async () => {
    const s = server({ advanced: { extraEnv: { FAKE_MC_MODE: "bind_fail" } } });
    const world = path.join(serverDir(s.id), "world");
    fs.mkdirSync(world, { recursive: true });
    fs.writeFileSync(path.join(world, "level.dat"), "old");
    await rt.start(s);
    await until(async () => (await rt.status(s.id)) === "crashed");
    expect(fs.readFileSync(path.join(world, "level.dat"), "utf8")).toBe("old");
    expect(await rt.logTail(s.id, 30)).not.toContain("new world was not finished");
    await rt.remove(s.id);
  });

  it("stops servers left running by a previous run", async () => {
    const runDir = path.join(tmp, "run-old");
    const old = runtime(runDir);
    const s = server();
    await old.start(s);
    await until(async () => (await old.status(s.id)) === "online");
    const { pid } = JSON.parse(fs.readFileSync(path.join(runDir, `${s.id}.json`), "utf8")) as { pid: number };

    // ZimaMC restarts and no longer has the process as its child.
    await runtime(runDir).recover();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive());
    expect(fs.existsSync(path.join(runDir, `${s.id}.json`))).toBe(false);
    await old.remove(s.id);
  });
});

describe("native helpers", () => {
  it("writes server.properties like Java reads it", () => {
    expect(escapeValue("Ahoj světe")).toBe("Ahoj sv\\u011bte");
    expect(escapeValue("a\\b")).toBe("a\\\\b");
    const text = "#Minecraft server properties\nmotd=Old\nspawn-protection=16\n";
    const out = mergeProperties(text, { motd: "Nový", "max-players": "5" });
    expect(out).toBe("#Minecraft server properties\nmotd=Nov\\u00fd\nspawn-protection=16\nmax-players=5\n");
    expect(readProperty(out, "motd")).toBe("Nový");
  });

  // Java refuses to start on a single unknown -XX option, so try the flags on a real Java when there is one.
  it.skipIf(spawnSync("java", ["-version"]).status !== 0)("starts a real Java with the server's flags", () => {
    const args = jvmArgs({ memoryMB: 1024, type: "PAPER", advanced: {} });
    const r = spawnSync("java", [...args, "-version"], { encoding: "utf8" });
    expect(r.stderr).not.toMatch(/Unrecognized|Could not create/);
    expect(r.status).toBe(0);
  });

  it("splits Expert JVM flags", () => {
    expect(splitArgs(' -Xss1M  "-Dname=a b" -Dx=1 ')).toEqual(["-Xss1M", "-Dname=a b", "-Dx=1"]);
  });

  it("picks the Java version", () => {
    expect(javaMajorFor({ version: "1.21.8", advanced: {} })).toBe(21);
    expect(javaMajorFor({ version: "1.16.5", advanced: {} })).toBe(8);
    expect(javaMajorFor({ version: "1.16.5", advanced: { javaImageTag: "java17-graalvm" } })).toBe(17);
  });

  it("unpacks a zip without its top folder and refuses paths outside", async () => {
    const zip = path.join(tmp, "j.zip");
    fs.writeFileSync(zip, makeZip({ "jdk-21/bin/java.txt": "hi", "jdk-21/lib/a/b.txt": "deep" }));
    const dest = path.join(tmp, "unzipped");
    await extractZip(zip, dest);
    expect(fs.readFileSync(path.join(dest, "bin", "java.txt"), "utf8")).toBe("hi");
    expect(fs.readFileSync(path.join(dest, "lib", "a", "b.txt"), "utf8")).toBe("deep");
    fs.writeFileSync(zip, makeZip({ "x/../../evil.txt": "no" }));
    await expect(extractZip(zip, path.join(tmp, "unzipped2"))).rejects.toThrow(/unsafe/);
  });
});
