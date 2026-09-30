import { fetchJson } from "./http.js";
import { compareVersions } from "./minecraft.js";
import type { ServerType } from "./store.js";

const TTL = 60 * 60 * 1000;
const cache = new Map<string, { at: number; versions: string[] }>();

async function cached(key: string, load: () => Promise<string[]>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.versions;
  const versions = await load();
  cache.set(key, { at: Date.now(), versions });
  return versions;
}

const isRelease = (v: string) => /^\d+\.\d+(\.\d+)?$/.test(v);
const sortDesc = (vs: string[]) => [...new Set(vs.filter(isRelease))].sort((a, b) => compareVersions(b, a));

async function mojangReleases() {
  const m = await fetchJson<{ versions: { id: string; type: string }[] }>(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );
  return sortDesc(m.versions.filter((v) => v.type === "release").map((v) => v.id));
}

/** Release versions available for a server type, newest first. */
export async function listVersions(type: ServerType): Promise<string[]> {
  switch (type) {
    case "PAPER":
      return cached("paper", async () => {
        const p = await fetchJson<{ versions: string[] }>("https://api.papermc.io/v2/projects/paper");
        return sortDesc(p.versions);
      });
    case "FABRIC":
      return cached("fabric", async () => {
        const f = await fetchJson<{ version: string; stable: boolean }[]>("https://meta.fabricmc.net/v2/versions/game");
        return sortDesc(f.filter((v) => v.stable).map((v) => v.version));
      });
    case "FORGE":
      return cached("forge", async () => {
        const f = await fetchJson<{ promos: Record<string, string> }>(
          "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
        );
        return sortDesc(Object.keys(f.promos).map((k) => k.replace(/-(latest|recommended)$/, "")));
      });
    default:
      return cached("vanilla", mojangReleases);
  }
}
