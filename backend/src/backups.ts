import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import type { DockerManager } from "./docker.js";
import { safeJoin, serverDir } from "./files.js";
import { backupDir } from "./paths.js";
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
  size: number;
  createdAt: string;
  auto: boolean;
}


export class Backups {
  private running = new Set<string>();

  constructor(
    private store: Store,
    private docker: DockerManager,
  ) {}

  isRunning(id: string) {
    return this.running.has(id);
  }

  async list(id: string): Promise<BackupInfo[]> {
    let files: string[];
    try {
      files = await fsp.readdir(backupDir(id));
    } catch {
      return [];
    }
    const out: BackupInfo[] = [];
    for (const f of files.filter((f) => f.endsWith(".tar.gz"))) {
      const st = await fsp.stat(path.join(backupDir(id), f));
      out.push({ file: f, size: st.size, createdAt: st.mtime.toISOString(), auto: f.includes("-auto") });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pathOf(id: string, file: string) {
    if (!/^[\w.-]+\.tar\.gz$/.test(file)) throw new HttpError(400, "invalid_path");
    return safeJoin(backupDir(id), file);
  }

  async create(s: ServerConfig, auto = false) {
    if (this.running.has(s.id)) throw new HttpError(409, "backup_in_progress");
    this.running.add(s.id);
    const live = await this.docker.isRunning(s.id);
    try {
      if (live) {
        // Make the world consistent on disk and pause autosave while we copy it.
        await this.docker.rcon(s.id, "save-off").catch(() => {});
        await this.docker.rcon(s.id, "save-all flush").catch(() => {});
      }
      await fsp.mkdir(backupDir(s.id), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = `${stamp}${auto ? "-auto" : ""}.tar.gz`;
      const src = serverDir(s.id);
      const entries = (await fsp.readdir(src)).filter((e) => includeInBackup(e));
      await tar.c(
        {
          gzip: true,
          cwd: src,
          file: path.join(backupDir(s.id), file),
          portable: false,
          filter: (p) => includeInBackup(p),
        },
        entries,
      );
      this.store.updateServer(s.id, (x) => (x.backup.lastAt = new Date().toISOString()));
      if (auto) await this.prune(s);
      return file;
    } finally {
      if (live) await this.docker.rcon(s.id, "save-on").catch(() => {});
      this.running.delete(s.id);
    }
  }

  /** Keep only the newest N automatic backups. Manual backups are never deleted. */
  async prune(s: ServerConfig) {
    const autos = (await this.list(s.id)).filter((b) => b.auto);
    for (const b of autos.slice(Math.max(1, s.backup.keep))) {
      await fsp.rm(path.join(backupDir(s.id), b.file), { force: true });
    }
  }

  async remove(id: string, file: string) {
    await fsp.rm(this.pathOf(id, file), { force: true });
  }

  /** Replace the server's world and configs with a backup. The server must be stopped. */
  async restore(s: ServerConfig, file: string) {
    if (await this.docker.isRunning(s.id)) throw new HttpError(409, "stop_server_first");
    const archive = this.pathOf(s.id, file);
    if (!fs.existsSync(archive)) throw new HttpError(404, "backup_not_found");
    const dir = serverDir(s.id);
    const tmp = path.join(dir, `.restore-${Date.now()}`);
    await fsp.mkdir(tmp);
    try {
      await tar.x({ file: archive, cwd: tmp });
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
      if (!(await this.docker.isRunning(s.id))) continue;
      await this.create(s, true).catch((e) => console.error(`[backup] ${s.name}:`, e));
    }
  }
}
