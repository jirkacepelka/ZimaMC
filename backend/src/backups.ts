import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import type { Runtime } from "./runtime.js";
import { safeJoin, serverDir } from "./files.js";
import { backupDir } from "./paths.js";
import { copyTree, uniqueSize } from "./storage.js";
import { HttpError, type ServerConfig, type Store } from "./store.js";

/** Downloaded server software and caches: large, and re-downloaded automatically. */
const EXCLUDE_TOP = new Set(["libraries", "versions", "cache", ".cache", "logs", "crash-reports", ".fabric", "bundler"]);

export function includeInBackup(relPath: string) {
  const parts = relPath.replace(/^\.\//, "").split("/");
  if (EXCLUDE_TOP.has(parts[0])) return false;
  // Server jars in the root folder are downloaded again on start.
  if (parts.length === 1 && parts[0].endsWith(".jar")) return false;
  return true;
}

export interface BackupInfo {
  file: string;
  /** "full": one .tar.gz. "incremental": a folder sharing unchanged files with older backups. */
  kind: "full" | "incremental";
  /** Size of everything in the backup. */
  size: number;
  /** Incremental backups: data that was new in this backup. */
  added?: number;
  createdAt: string;
  auto: boolean;
}

const MANIFEST = ".zimamc-backup.json";

/** Paths in backups always use "/", also on Windows. */
const relJoin = (a: string, b: string) => (a ? `${a}/${b}` : b);


export class Backups {
  private running = new Set<string>();

  constructor(
    private store: Store,
    private runtime: Runtime,
  ) {}

  isRunning(id: string) {
    return this.running.has(id);
  }

  async list(id: string): Promise<BackupInfo[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(backupDir(id), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: BackupInfo[] = [];
    for (const e of entries) {
      const p = path.join(backupDir(id), e.name);
      if (e.isFile() && e.name.endsWith(".tar.gz")) {
        const st = await fsp.stat(p);
        out.push({ file: e.name, kind: "full", size: st.size, createdAt: st.mtime.toISOString(), auto: e.name.includes("-auto") });
      } else if (e.isDirectory() && !e.name.endsWith(".partial")) {
        try {
          const m = JSON.parse(await fsp.readFile(path.join(p, MANIFEST), "utf8")) as { totalBytes: number; addedBytes: number; createdAt: string };
          out.push({ file: e.name, kind: "incremental", size: m.totalBytes, added: m.addedBytes, createdAt: m.createdAt, auto: e.name.includes("-auto") });
        } catch {
          /* not a finished backup */
        }
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Disk space all backups of a server take; files shared between incremental backups count once. */
  async usage(id: string) {
    return uniqueSize(backupDir(id));
  }

  pathOf(id: string, file: string) {
    if (!/^[\w-][\w.-]*$/.test(String(file)) || String(file).endsWith(".partial")) throw new HttpError(400, "invalid_path");
    return safeJoin(backupDir(id), file);
  }

  async create(s: ServerConfig, auto = false) {
    if (this.running.has(s.id)) throw new HttpError(409, "backup_in_progress");
    this.running.add(s.id);
    const live = await this.runtime.isRunning(s.id);
    try {
      if (live) {
        // Make the world consistent on disk and pause autosave while we copy it.
        await this.runtime.rcon(s.id, "save-off").catch(() => {});
        await this.runtime.rcon(s.id, "save-all flush").catch(() => {});
      }
      await fsp.mkdir(backupDir(s.id), { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}${auto ? "-auto" : ""}`;
      const file = (s.backup.mode ?? "incremental") === "full" ? await this.fullBackup(s, name) : await this.incrementalBackup(s, name);
      this.store.updateServer(s.id, (x) => (x.backup.lastAt = new Date().toISOString()));
      if (auto) await this.prune(s);
      return file;
    } finally {
      if (live) await this.runtime.rcon(s.id, "save-on").catch(() => {});
      this.running.delete(s.id);
    }
  }

  /** One .tar.gz with everything: easy to download and keep elsewhere, but every backup takes full space. */
  private async fullBackup(s: ServerConfig, name: string) {
    const file = `${name}.tar.gz`;
    const src = serverDir(s.id);
    const entries = (await fsp.readdir(src)).filter((e) => includeInBackup(e));
    await tar.c({ gzip: true, cwd: src, file: path.join(backupDir(s.id), file), portable: false, filter: (p) => includeInBackup(p) }, entries);
    return file;
  }

  /**
   * A folder that looks like a full copy, but files unchanged since the previous
   * incremental backup are hardlinks to it: a big pre-generated world takes its
   * space once, and each backup only adds what changed. Backup files are never
   * linked to the live server files, so the server can't change a backup.
   */
  private async incrementalBackup(s: ServerConfig, name: string) {
    const root = backupDir(s.id);
    const prev = (await this.list(s.id)).find((b) => b.kind === "incremental");
    const prevDir = prev ? path.join(root, prev.file) : undefined;
    const tmp = path.join(root, `${name}.partial`);
    const stats = { totalBytes: 0, addedBytes: 0 };
    const walk = async (src: string, dst: string, rel: string) => {
      await fsp.mkdir(dst, { recursive: true });
      for (const e of await fsp.readdir(src, { withFileTypes: true })) {
        const r = relJoin(rel, e.name);
        if (!includeInBackup(r)) continue;
        const a = path.join(src, e.name);
        const b = path.join(dst, e.name);
        if (e.isDirectory()) await walk(a, b, r);
        else if (e.isSymbolicLink()) await fsp.symlink(await fsp.readlink(a), b).catch(() => {});
        else if (e.isFile()) {
          const st = await fsp.stat(a);
          stats.totalBytes += st.size;
          if (prevDir && (await this.linkUnchanged(path.join(prevDir, ...r.split("/")), b, st))) continue;
          await fsp.copyFile(a, b);
          await fsp.utimes(b, st.atime, st.mtime).catch(() => {});
          stats.addedBytes += st.size;
        }
      }
    };
    try {
      await walk(serverDir(s.id), tmp, "");
      await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify({ ...stats, createdAt: new Date().toISOString() }));
      await fsp.rename(tmp, path.join(root, name));
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    return name;
  }

  /** Hardlink the previous backup's copy if the file did not change. False when it changed or links aren't supported (FAT/exFAT). */
  private async linkUnchanged(prev: string, dst: string, cur: fs.Stats) {
    try {
      const p = await fsp.stat(prev);
      if (p.size !== cur.size || Math.trunc(p.mtimeMs / 1000) !== Math.trunc(cur.mtimeMs / 1000)) return false;
      await fsp.link(prev, dst);
      return true;
    } catch {
      return false;
    }
  }

  /** Keep only the newest N automatic backups. Manual backups are never deleted. */
  async prune(s: ServerConfig) {
    const autos = (await this.list(s.id)).filter((b) => b.auto);
    for (const b of autos.slice(Math.max(1, s.backup.keep))) {
      await fsp.rm(path.join(backupDir(s.id), b.file), { recursive: true, force: true });
    }
  }

  async remove(id: string, file: string) {
    await fsp.rm(this.pathOf(id, file), { recursive: true, force: true });
  }

  /** Replace the server's world and configs with a backup. The server must be stopped. */
  async restore(s: ServerConfig, file: string) {
    if (await this.runtime.isRunning(s.id)) throw new HttpError(409, "stop_server_first");
    const archive = this.pathOf(s.id, file);
    if (!fs.existsSync(archive)) throw new HttpError(404, "backup_not_found");
    const dir = serverDir(s.id);
    const tmp = path.join(dir, `.restore-${Date.now()}`);
    await fsp.mkdir(tmp);
    try {
      if ((await fsp.stat(archive)).isDirectory()) {
        // Copies (never links) so playing on the restored world can't change the backup.
        await copyTree(archive, tmp, () => {});
        await fsp.rm(path.join(tmp, MANIFEST), { force: true });
      } else await tar.x({ file: archive, cwd: tmp });
      for (const entry of await fsp.readdir(tmp)) {
        await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
        await fsp.rename(path.join(tmp, entry), path.join(dir, entry));
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  /** Called every minute: back up running servers whose schedule is due. */
  async tick() {
    for (const s of this.store.servers) {
      if (!s.backup.everyHours) continue;
      const last = s.backup.lastAt ? Date.parse(s.backup.lastAt) : 0;
      if (Date.now() - last < s.backup.everyHours * 3600_000) continue;
      if (!(await this.runtime.isRunning(s.id))) continue;
      await this.create(s, true).catch((e) => console.error(`[backup] ${s.name}:`, e));
    }
  }
}

/** Files of an incremental backup for a download as .tar.gz. */
export function backupEntries(dir: string) {
  return fs.readdirSync(dir).filter((e) => e !== MANIFEST);
}
