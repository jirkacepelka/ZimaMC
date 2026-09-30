import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MC_GID, MC_UID, SERVERS_DIR } from "./config.js";
import { HttpError } from "./store.js";

export const serverDir = (id: string) => path.join(SERVERS_DIR, id);

/**
 * Resolve a user-supplied relative path inside a root directory.
 * Rejects anything that would escape the root (../, absolute paths, symlinks out).
 */
export function safeJoin(root: string, rel: string) {
  const cleaned = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const full = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) throw new HttpError(400, "invalid_path");
  try {
    const real = fs.realpathSync(full);
    const realRoot = fs.realpathSync(rootResolved);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(400, "invalid_path");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Path does not exist yet; its lexical check above is enough.
  }
  return full;
}

/** Give files we create to the Minecraft user so the server can modify them. */
export async function chownForServer(p: string) {
  if (process.getuid?.() !== 0) return;
  try {
    await fsp.chown(p, MC_UID, MC_GID);
  } catch {
    /* best effort */
  }
}

export async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
  await chownForServer(p);
}

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  modified: string;
}

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const dir = safeJoin(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    try {
      const st = await fsp.stat(path.join(dir, e.name));
      out.push({ name: e.name, dir: st.isDirectory(), size: st.size, modified: st.mtime.toISOString() });
    } catch {
      /* broken symlink */
    }
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export async function readText(root: string, rel: string) {
  const p = safeJoin(root, rel);
  const st = await fsp.stat(p);
  if (st.isDirectory()) throw new HttpError(400, "is_directory");
  if (st.size > MAX_EDIT_BYTES) throw new HttpError(413, "file_too_large");
  const buf = await fsp.readFile(p);
  if (buf.includes(0)) throw new HttpError(415, "binary_file");
  return buf.toString("utf8");
}

export async function writeText(root: string, rel: string, content: string) {
  const p = safeJoin(root, rel);
  if (p === path.resolve(root)) throw new HttpError(400, "invalid_path");
  await fsp.writeFile(p, content, "utf8");
  await chownForServer(p);
}

export async function remove(root: string, rel: string) {
  const p = safeJoin(root, rel);
  if (p === path.resolve(root)) throw new HttpError(400, "invalid_path");
  await fsp.rm(p, { recursive: true, force: true });
}

export async function rename(root: string, from: string, to: string) {
  const a = safeJoin(root, from);
  const b = safeJoin(root, to);
  if (a === path.resolve(root) || b === path.resolve(root)) throw new HttpError(400, "invalid_path");
  await fsp.rename(a, b);
}

export async function mkdir(root: string, rel: string) {
  await ensureDir(safeJoin(root, rel));
}

/** Total size of a directory in bytes. */
export async function dirSize(p: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}
