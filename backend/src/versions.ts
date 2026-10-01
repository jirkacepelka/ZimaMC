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

/**
 * Paper's version list. The Fill v3 API groups versions by family
 * ({"1.21": ["1.21.8", …]}); the old v2 API returned a flat array.
 */
export function parsePaperVersions(body: unknown): string[] {
  const v = (body as { versions?: unknown })?.versions;
  if (Array.isArray(v)) return sortDesc(v.map(String));
  if (v && typeof v === "object") return sortDesc(Object.values(v).flat().map(String));
  return [];
}

async function paperVersions() {
  const sources = ["https://fill.papermc.io/v3/projects/paper", "https://api.papermc.io/v2/projects/paper"];
  for (const url of sources) {
    try {
      const versions = parsePaperVersions(await fetchJson<unknown>(url));
      if (versions.length) return versions;
    } catch {
      /* try the next source */
    }
  }
  throw new Error("paper versions unavailable");
}

async function loaderVersions(type: ServerType): Promise<string[]> {
  switch (type) {
    case "PAPER":
      return cached("paper", paperVersions);
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

/**
 * Release versions available for a server type, newest first. If the
 * loader's own list can't be loaded, fall back to Mojang's release list so
 * creating a server never gets stuck on one unavailable website.
 */
export async function listVersions(type: ServerType): Promise<string[]> {
  try {
    return await loaderVersions(type);
  } catch (e) {
    if (type === "VANILLA") throw e;
    return loaderVersions("VANILLA");
  }
}
