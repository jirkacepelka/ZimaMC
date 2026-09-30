import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../src/config.js";
import { serverDir } from "../src/files.js";
import { defaultProperties } from "../src/minecraft.js";
import { install, uninstall } from "../src/modrinth.js";
import type { ServerConfig } from "../src/store.js";

const jar = (name: string) => Buffer.from(`fake jar ${name}`);
const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");

const versions: Record<string, unknown[]> = {
  essentials: [
    { id: "v-beta", project_id: "essentials", version_type: "beta", files: [], dependencies: [] },
    {
      id: "v2",
      project_id: "essentials",
      version_number: "2.21.0",
      version_type: "release",
      files: [{ url: "https://cdn.modrinth.com/e.jar", filename: "EssentialsX-2.21.0.jar", primary: true, hashes: { sha1: sha1(jar("e")) } }],
      dependencies: [{ project_id: "vault", dependency_type: "required" }, { project_id: "opt", dependency_type: "optional" }],
    },
  ],
  vault: [
    {
      id: "v9",
      project_id: "vault",
      version_type: "release",
      files: [{ url: "https://cdn.modrinth.com/v.jar", filename: "Vault.jar", primary: true, hashes: { sha1: sha1(jar("v")) } }],
      dependencies: [],
    },
  ],
  broken: [
    {
      id: "b1",
      project_id: "broken",
      version_type: "release",
      files: [{ url: "https://cdn.modrinth.com/b.jar", filename: "Broken.jar", primary: true, hashes: { sha1: "0".repeat(40) } }],
      dependencies: [],
    },
  ],
};

const requested: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    requested.push(url);
    const u = new URL(url);
    if (u.host === "cdn.modrinth.com") return new Response(jar(u.pathname[1]));
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && m[2]) return Response.json(versions[m[1]] ?? []);
    if (m) return Response.json({ id: m[1], title: m[1].toUpperCase(), icon_url: null });
    return new Response("", { status: 404 });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const s: ServerConfig = {
  id: "mr1",
  name: "t",
  type: "PAPER",
  version: "1.21.8",
  memoryMB: 2048,
  cpus: 1,
  port: 25565,
  properties: defaultProperties("t", 5),
  advanced: {},
  autoStart: false,
  projects: [],
  backup: { everyHours: 0, keep: 1 },
  createdAt: "",
};

describe("Modrinth install", () => {
  it("installs the newest stable build and its required dependencies", async () => {
    const installed = await install(s, "essentials");
    expect(installed.map((p) => [p.projectId, p.versionId, p.fileName])).toEqual([
      ["essentials", "v2", "EssentialsX-2.21.0.jar"],
      ["vault", "v9", "Vault.jar"],
    ]);
    expect(fs.readFileSync(path.join(serverDir(s.id), "plugins/EssentialsX-2.21.0.jar"), "utf8")).toBe("fake jar e");
    // Filters by loader and game version.
    const q = new URL(requested.find((r) => r.includes("/essentials/version"))!).searchParams;
    expect(JSON.parse(q.get("loaders")!)).toContain("paper");
    expect(JSON.parse(q.get("game_versions")!)).toEqual(["1.21.8"]);
  });

  it("rejects a download whose checksum doesn't match", async () => {
    await expect(install(s, "broken")).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(fs.existsSync(path.join(serverDir(s.id), "plugins/Broken.jar"))).toBe(false);
  });

  it("uninstalls by deleting the jar", async () => {
    s.projects = await install({ ...s, projects: [] }, "vault");
    await uninstall(s, "vault");
    expect(fs.existsSync(path.join(serverDir(s.id), "plugins/Vault.jar"))).toBe(false);
  });

  it("refuses plugins on vanilla", async () => {
    await expect(install({ ...s, type: "VANILLA" }, "essentials")).rejects.toMatchObject({ code: "no_plugins_for_vanilla" });
  });
});
