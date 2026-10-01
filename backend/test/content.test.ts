import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseHelp, parsePluginYml } from "../src/content.js";
import { readJarEntry } from "../src/jar.js";
import { makeZip } from "./zip.js";

const PLUGIN_YML = `name: Essentials
main: com.example.Main
commands:
  home:
    description: Go to your home
    usage: /<command> [name]
    aliases: [h, homes]
    permission: essentials.home
  sethome:
    description: Set a home
`;

describe("jar reading", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-jar-"));
  const jar = path.join(dir, "x.jar");
  fs.writeFileSync(jar, makeZip({ "META-INF/MANIFEST.MF": "a", "plugin.yml": PLUGIN_YML }));

  it("reads a file from a jar", async () => {
    expect(await readJarEntry(jar, "plugin.yml")).toBe(PLUGIN_YML);
    expect(await readJarEntry(jar, "nope.yml")).toBeNull();
  });

  it("returns null for something that is not a zip", async () => {
    const bad = path.join(dir, "bad.jar");
    fs.writeFileSync(bad, "not a zip");
    expect(await readJarEntry(bad, "plugin.yml")).toBeNull();
    expect(await readJarEntry(path.join(dir, "missing.jar"), "plugin.yml")).toBeNull();
  });
});

describe("plugin.yml", () => {
  it("lists declared commands", () => {
    const r = parsePluginYml(PLUGIN_YML);
    expect(r.name).toBe("Essentials");
    expect(r.commands).toEqual([
      { name: "home", description: "Go to your home", usage: "/home [name]", aliases: ["h", "homes"], permission: "essentials.home" },
      { name: "sethome", description: "Set a home", usage: undefined, aliases: undefined, permission: undefined },
    ]);
  });

  it("copes with broken or empty files", () => {
    expect(parsePluginYml("a: [").commands).toEqual([]);
    expect(parsePluginYml("").commands).toEqual([]);
  });
});

describe("help output", () => {
  it("parses Bukkit and Brigadier lines", () => {
    const r = parseHelp("Help: Index (1/3)\n/ban: Prevents a player from joining\n/advancement (grant|revoke) <targets>\nUse /help [n] to get page n");
    expect(r).toEqual([
      { usage: "/ban", description: "Prevents a player from joining" },
      { usage: "/advancement (grant|revoke) <targets>", description: undefined },
    ]);
  });
});
