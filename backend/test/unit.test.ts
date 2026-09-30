import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { includeInBackup } from "../src/backups.js";
import { safeJoin } from "../src/files.js";
import { compareVersions, containerEnv, defaultProperties, javaTagFor, parsePlayerList } from "../src/minecraft.js";
import { loadersFor, pickVersion, searchUrl } from "../src/modrinth.js";
import { buildRecords, fqdn, isValidSubdomain, tokenTemplateUrl } from "../src/network/cloudflare.js";
import { isCgnat } from "../src/network/ip.js";
import { dashUuid, offlineUuid } from "../src/players.js";
import { assertFitsGlobalLimit, assertServerLimits, containerMemoryMB, defaultLimits, effectiveCpus } from "../src/resources.js";
import { HttpError, type ServerConfig, type Settings } from "../src/store.js";

function server(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "abc",
    name: "Test",
    type: "PAPER",
    version: "1.21.8",
    memoryMB: 2048,
    cpus: 1,
    port: 25565,
    properties: defaultProperties("Test", 10),
    advanced: {},
    autoStart: true,
    projects: [],
    backup: { everyHours: 24, keep: 7 },
    createdAt: "",
    ...over,
  };
}

const settings = (memoryMB: number, cpus: number): Settings => ({
  language: "en",
  showAdvanced: false,
  limits: { memoryMB, cpus },
  network: { upnp: false },
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpError).code;
  }
  return null;
};

describe("resources", () => {
  it("adds JVM overhead to the container limit", () => {
    expect(containerMemoryMB(2048)).toBe(2560);
    expect(containerMemoryMB(8192)).toBe(10240);
  });

  it("suggests 75 % of the host", () => {
    expect(defaultLimits({ memoryMB: 16384, cpus: 4 })).toEqual({ memoryMB: 12288, cpus: 3 });
    expect(defaultLimits({ memoryMB: 1000, cpus: 1 })).toEqual({ memoryMB: 1024, cpus: 1 });
  });

  it("refuses to start a server that would exceed the global limit", () => {
    const running = [server({ id: "a", memoryMB: 4096, cpus: 2 })];
    // 5120 already reserved; another 2560 fits in 8192, a 4096 heap (5120) doesn't.
    expect(code(() => assertFitsGlobalLimit(settings(8192, 4), running, server({ id: "b" })))).toBeNull();
    expect(code(() => assertFitsGlobalLimit(settings(8192, 4), running, server({ id: "b", memoryMB: 4096 })))).toBe("limit_memory");
    // CPU is shared, not reserved: only a single server above the global cap is refused.
    expect(code(() => assertFitsGlobalLimit(settings(0, 2.5), running, server({ id: "b", cpus: 2 })))).toBeNull();
    expect(code(() => assertFitsGlobalLimit(settings(0, 2.5), running, server({ id: "b", cpus: 3 })))).toBe("limit_cpu");
  });

  it("scales CPU caps so running servers share the global limit", () => {
    const caps = effectiveCpus([server({ id: "a", cpus: 2 }), server({ id: "b", cpus: 2 })], 3);
    expect(caps.get("a")).toBe(1.5);
    expect(caps.get("b")).toBe(1.5);
    expect(effectiveCpus([server({ id: "a", cpus: 2 })], 3).get("a")).toBe(2);
    expect(effectiveCpus([server({ id: "a", cpus: 2 }), server({ id: "b", cpus: 4 })], 0).get("b")).toBe(4);
  });

  it("does not count the server being restarted twice", () => {
    const s = server({ memoryMB: 4096 });
    expect(code(() => assertFitsGlobalLimit(settings(5120, 1), [s], s))).toBeNull();
  });

  it("zero means no global limit", () => {
    expect(code(() => assertFitsGlobalLimit(settings(0, 0), [server({ id: "a", memoryMB: 99999 })], server({ id: "b" })))).toBeNull();
  });

  it("validates a single server", () => {
    expect(code(() => assertServerLimits(settings(4096, 2), 256, 1))).toBe("memory_too_low");
    expect(code(() => assertServerLimits(settings(4096, 2), 4096, 1))).toBe("limit_memory");
    expect(code(() => assertServerLimits(settings(4096, 2), 2048, 3))).toBe("limit_cpu");
    expect(code(() => assertServerLimits(settings(4096, 2), 2048, 2))).toBeNull();
  });
});

describe("files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-"));
  fs.mkdirSync(path.join(root, "world"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.symlinkSync(outside, path.join(root, "escape"));

  it("resolves paths inside the root", () => {
    expect(safeJoin(root, "world")).toBe(path.join(root, "world"));
    expect(safeJoin(root, "/world/level.dat")).toBe(path.join(root, "world/level.dat"));
    expect(safeJoin(root, "")).toBe(root);
  });

  it("blocks path traversal and symlinks out of the root", () => {
    expect(code(() => safeJoin(root, "../etc/passwd"))).toBe("invalid_path");
    expect(code(() => safeJoin(root, "world/../../x"))).toBe("invalid_path");
    expect(code(() => safeJoin(root, "..\\..\\x"))).toBe("invalid_path");
    expect(code(() => safeJoin(root, "escape"))).toBe("invalid_path");
    expect(code(() => safeJoin(root + "-sibling", "x"))).toBeNull();
  });
});

describe("minecraft", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("1.21.10", "1.21.9")).toBeGreaterThan(0);
    expect(compareVersions("1.20", "1.20.0")).toBe(0);
  });

  it("picks the right Java", () => {
    expect(javaTagFor("1.21.8")).toBe("java21");
    expect(javaTagFor("1.20.5")).toBe("java21");
    expect(javaTagFor("1.20.4")).toBe("java17");
    expect(javaTagFor("1.17.1")).toBe("java17");
    expect(javaTagFor("1.16.5")).toBe("java8");
  });

  it("maps settings to the container environment", () => {
    const env = containerEnv(
      server({ advanced: { jvmFlags: "-XX:+UseZGC", extraEnv: { SPAWN_PROTECTION: "0", "bad key": "x" } } }),
    );
    expect(env).toMatchObject({
      EULA: "TRUE",
      TYPE: "PAPER",
      VERSION: "1.21.8",
      MEMORY: "2048M",
      MAX_PLAYERS: "10",
      USE_AIKAR_FLAGS: "true",
      JVM_OPTS: "-XX:+UseZGC",
      SPAWN_PROTECTION: "0",
    });
    expect(env["bad key"]).toBeUndefined();
  });

  it("parses the player list", () => {
    expect(parsePlayerList("There are 2 of a max of 20 players online: Steve, Alex")).toEqual({
      online: 2,
      max: 20,
      names: ["Steve", "Alex"],
    });
    expect(parsePlayerList("There are 0 of a max of 10 players online:")).toEqual({ online: 0, max: 10, names: [] });
  });

  it("computes offline-mode UUIDs like the server does", () => {
    expect(offlineUuid("Notch")).toBe("b50ad385-829d-3141-a216-7e7d7539ba7f");
    expect(dashUuid("069a79f444e94726a5befca90e38aaf5")).toBe("069a79f4-44e9-4726-a5be-fca90e38aaf5");
  });
});

describe("modrinth", () => {
  it("builds a search filtered by loader and game version", () => {
    const url = new URL(searchUrl({ type: "PAPER", version: "1.21.8" }, "essentials"));
    const facets = JSON.parse(url.searchParams.get("facets")!);
    expect(facets[0]).toEqual(["categories:paper", "categories:spigot", "categories:bukkit"]);
    expect(facets[1]).toEqual(["versions:1.21.8"]);
    expect(url.searchParams.get("index")).toBe("relevance");
    expect(loadersFor({ type: "VANILLA" })).toEqual([]);
  });

  it("prefers stable releases", () => {
    const v = (id: string, t: "release" | "beta") => ({ id, version_type: t }) as never;
    expect(pickVersion([v("b", "beta"), v("r", "release")])).toMatchObject({ id: "r" });
    expect(pickVersion([v("b", "beta")])).toMatchObject({ id: "b" });
  });
});

describe("cloudflare", () => {
  it("builds full host names", () => {
    expect(fqdn("mc", "example.com")).toBe("mc.example.com");
    expect(fqdn("@", "example.com")).toBe("example.com");
    expect(fqdn("mc.example.com", "example.com")).toBe("mc.example.com");
    expect(isValidSubdomain("mc")).toBe(true);
    expect(isValidSubdomain("my-server.eu")).toBe(true);
    expect(isValidSubdomain("bad_name")).toBe(false);
    expect(isValidSubdomain("-x")).toBe(false);
  });

  it("adds an SRV record only when the port is not the default", () => {
    expect(buildRecords("mc.example.com", "1.2.3.4", 25565).srv).toBeNull();
    const { a, srv } = buildRecords("mc.example.com", "1.2.3.4", 25570);
    expect(a).toMatchObject({ type: "A", name: "mc.example.com", content: "1.2.3.4", proxied: false });
    expect(srv).toMatchObject({ type: "SRV", name: "_minecraft._tcp.mc.example.com", data: { port: 25570, target: "mc.example.com" } });
  });

  it("links to a prefilled token page", () => {
    const u = new URL(tokenTemplateUrl());
    expect(u.host).toBe("dash.cloudflare.com");
    expect(JSON.parse(u.searchParams.get("permissionGroupKeys")!)).toEqual([
      { key: "zone", type: "read" },
      { key: "dns", type: "edit" },
    ]);
  });
});

describe("network & backups", () => {
  it("detects carrier-grade NAT", () => {
    expect(isCgnat("100.64.1.1")).toBe(true);
    expect(isCgnat("100.128.0.1")).toBe(false);
    expect(isCgnat("85.160.12.44")).toBe(false);
  });

  it("skips re-downloadable files in backups", () => {
    expect(includeInBackup("world/level.dat")).toBe(true);
    expect(includeInBackup("plugins/EssentialsX.jar")).toBe(true);
    expect(includeInBackup("paper-1.21.8.jar")).toBe(false);
    expect(includeInBackup("libraries/x.jar")).toBe(false);
    expect(includeInBackup("./logs/latest.log")).toBe(false);
  });
});
