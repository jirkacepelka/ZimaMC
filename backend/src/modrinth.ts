import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { chownForServer, ensureDir, serverDir } from "./files.js";
import { download, fetchJson } from "./http.js";
import { contentKind } from "./minecraft.js";
import { HttpError, type InstalledProject, type ServerConfig } from "./store.js";

const API = "https://api.modrinth.com/v2";

/** Modrinth loaders a server type can run. Paper also runs Spigot and Bukkit plugins. */
export function loadersFor(s: Pick<ServerConfig, "type">): string[] {
  switch (s.type) {
    case "PAPER":
      return ["paper", "spigot", "bukkit"];
    case "FOLIA":
      // Folia runs regions on several threads; most Paper plugins break, so only
      // offer plugins that say they support it.
      return ["folia"];
    case "FABRIC":
      return ["fabric"];
    case "FORGE":
      return ["forge"];
    default:
      return [];
  }
}

export function searchUrl(s: Pick<ServerConfig, "type" | "version">, query: string, offset = 0, limit = 20) {
  const loaders = loadersFor(s);
  const facets = [loaders.map((l) => `categories:${l}`), [`versions:${s.version}`], ["server_side:required", "server_side:optional"]];
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index: query ? "relevance" : "downloads",
    facets: JSON.stringify(facets),
  });
  return `${API}/search?${params}`;
}

export interface SearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url?: string;
  downloads: number;
  author: string;
}

export async function search(s: ServerConfig, query: string, offset = 0) {
  if (!contentKind(s.type)) throw new HttpError(400, "no_plugins_for_vanilla");
  const r = await fetchJson<{ hits: SearchHit[]; total_hits: number }>(searchUrl(s, query, offset), {}, "modrinth_error");
  return {
    total: r.total_hits,
    hits: r.hits.map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      iconUrl: h.icon_url,
      downloads: h.downloads,
      author: h.author,
      installed: s.projects.some((p) => p.projectId === h.project_id),
    })),
  };
}

interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  files: { url: string; filename: string; primary: boolean; hashes: { sha1: string; sha512?: string } }[];
  dependencies: { project_id?: string; version_id?: string; dependency_type: string }[];
}

/** Newest compatible version, preferring stable releases over betas. */
export function pickVersion(versions: MrVersion[]) {
  return versions.find((v) => v.version_type === "release") ?? versions[0];
}

async function compatibleVersions(s: ServerConfig, projectId: string) {
  const params = new URLSearchParams({
    loaders: JSON.stringify(loadersFor(s)),
    game_versions: JSON.stringify([s.version]),
  });
  return fetchJson<MrVersion[]>(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`, {}, "modrinth_error");
}

async function projectInfo(projectId: string) {
  return fetchJson<{ id: string; title: string; icon_url?: string }>(
    `${API}/project/${encodeURIComponent(projectId)}`,
    {},
    "modrinth_error",
  );
}

async function downloadVerified(url: string, dest: string, sha1: string) {
  if (!/^https:\/\/cdn\.modrinth\.com\//.test(url)) throw new HttpError(400, "download_failed", { url });
  const tmp = `${dest}.part`;
  const res = await download(url);
  const hash = crypto.createHash("sha1");
  await pipeline(
    Readable.fromWeb(res.body as never),
    async function* (src) {
      for await (const chunk of src) {
        hash.update(chunk as Buffer);
        yield chunk;
      }
    },
    fs.createWriteStream(tmp),
  );
  if (hash.digest("hex") !== sha1) {
    await fsp.rm(tmp, { force: true });
    throw new HttpError(502, "checksum_mismatch");
  }
  await fsp.rename(tmp, dest);
  await chownForServer(dest);
}

const safeFileName = (n: string) => path.basename(n).replace(/[^\w.\-+ ]/g, "_");

/**
 * Install a project and its required dependencies. Returns every project
 * that was installed or updated so the caller can save them.
 */
export async function install(s: ServerConfig, projectId: string, seen = new Set<string>()): Promise<InstalledProject[]> {
  const kind = contentKind(s.type);
  if (!kind) throw new HttpError(400, "no_plugins_for_vanilla");
  if (seen.has(projectId)) return [];
  seen.add(projectId);

  const versions = await compatibleVersions(s, projectId);
  const v = pickVersion(versions);
  if (!v) throw new HttpError(404, "no_compatible_version", { version: s.version });
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  if (!file) throw new HttpError(404, "no_compatible_version", { version: s.version });

  const dir = path.join(serverDir(s.id), kind.dir);
  await ensureDir(dir);
  const fileName = safeFileName(file.filename);
  await downloadVerified(file.url, path.join(dir, fileName), file.hashes.sha1);

  const previous = s.projects.find((p) => p.projectId === v.project_id);
  if (previous && previous.fileName !== fileName) await fsp.rm(path.join(dir, previous.fileName), { force: true });

  const info = await projectInfo(v.project_id).catch(() => ({ title: fileName, icon_url: undefined }));
  const installed: InstalledProject[] = [
    { projectId: v.project_id, versionId: v.id, title: info.title, fileName, iconUrl: info.icon_url },
  ];

  for (const dep of v.dependencies) {
    if (dep.dependency_type !== "required" || !dep.project_id) continue;
    if (s.projects.some((p) => p.projectId === dep.project_id)) continue;
    try {
      installed.push(...(await install(s, dep.project_id, seen)));
    } catch {
      // A missing optional build of a dependency should not undo the main install.
    }
  }
  return installed;
}

export async function uninstall(s: ServerConfig, projectId: string) {
  const kind = contentKind(s.type);
  const p = s.projects.find((x) => x.projectId === projectId);
  if (!kind || !p) throw new HttpError(404, "not_installed");
  await fsp.rm(path.join(serverDir(s.id), kind.dir, p.fileName), { force: true });
}

/** Which installed projects have a newer compatible version. */
export async function checkUpdates(s: ServerConfig) {
  const out: { projectId: string; latestVersionId: string; latestName: string }[] = [];
  await Promise.all(
    s.projects.map(async (p) => {
      try {
        const v = pickVersion(await compatibleVersions(s, p.projectId));
        if (v && v.id !== p.versionId) out.push({ projectId: p.projectId, latestVersionId: v.id, latestName: v.version_number });
      } catch {
        /* skip projects Modrinth can't answer for */
      }
    }),
  );
  return out;
}

/** Jar files in plugins/ or mods/ that were added by hand, not through Modrinth. */
export async function manualJars(s: ServerConfig) {
  const kind = contentKind(s.type);
  if (!kind) return [];
  try {
    const files = await fsp.readdir(path.join(serverDir(s.id), kind.dir));
    const known = new Set(s.projects.map((p) => p.fileName));
    return files.filter((f) => f.endsWith(".jar") && !known.has(f));
  } catch {
    return [];
  }
}
