import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, IS_WINDOWS } from "./config.js";
import { chownForServer, dirSize } from "./files.js";
import { HttpError } from "./store.js";

/** A place ZimaMC can keep servers or backups: a storage base folder on some disk. */
export interface Location {
  /** Storage base: holds servers/<id> and backups/<id>. */
  path: string;
  /** Disk or folder name to show. */
  label: string;
  freeBytes: number;
  totalBytes: number;
  default: boolean;
}

const BASE_NAME = "ZimaMC";

async function space(p: string) {
  try {
    const st = await fsp.statfs(p);
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

function writableDir(p: string) {
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The closest existing folder, to ask for free space of a base that doesn't exist yet. */
function existingParent(p: string) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) cur = path.dirname(cur);
  return cur;
}

const deviceOf = (p: string) => {
  try {
    return fs.statSync(existingParent(p)).dev;
  } catch {
    return undefined;
  }
};

/** Disk roots worth offering: mounted drives on a NAS or Linux box, drive letters on Windows. */
export function candidateRoots(): { root: string; explicit: boolean }[] {
  const roots: string[] = [];
  const extra = (process.env.STORAGE_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (IS_WINDOWS) {
    for (let c = 67; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      if (fs.existsSync(drive)) roots.push(drive);
    }
  } else {
    for (const parent of ["/media", "/mnt"]) {
      try {
        for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) roots.push(path.join(parent, e.name));
      } catch {
        /* not there */
      }
    }
    if (fs.existsSync("/DATA")) roots.push("/DATA");
  }
  return [...extra.map((root) => ({ root, explicit: true })), ...roots.map((root) => ({ root, explicit: false }))];
}

/** Storage base on a disk root: <root>/ZimaMC, or the folder itself if it already is one. */
export const baseFor = (root: string) => (path.basename(path.resolve(root)) === BASE_NAME ? path.resolve(root) : path.join(path.resolve(root), BASE_NAME));

export const sameBase = (a: string | undefined, b: string | undefined) => path.resolve(a ?? DATA_DIR) === path.resolve(b ?? DATA_DIR);

/**
 * Every place the user can pick: the data folder first, then one entry per other disk,
 * plus bases already in use (e.g. a custom folder chosen earlier).
 */
export async function listLocations(inUse: string[] = []): Promise<Location[]> {
  const out: Location[] = [{ path: DATA_DIR, label: "default", ...(await space(DATA_DIR)), default: true }];
  const devices = new Set([deviceOf(DATA_DIR)]);
  // Folders on the system disk itself (e.g. empty /media/usb in a container) are not other disks.
  const systemDev = IS_WINDOWS ? undefined : deviceOf("/");
  for (const { root, explicit } of candidateRoots()) {
    if (!writableDir(root)) continue;
    const dev = deviceOf(root);
    if (!explicit && (dev === undefined || devices.has(dev) || dev === systemDev)) continue;
    devices.add(dev);
    out.push({ path: baseFor(root), label: IS_WINDOWS ? root.replace(/\\$/, "") : path.basename(root) || root, ...(await space(root)), default: false });
  }
  for (const base of inUse) {
    if (out.some((l) => sameBase(l.path, base))) continue;
    out.push({ path: base, label: base, ...(await space(existingParent(base))), default: false });
  }
  return out;
}

/** Check a folder the user typed (or picked) and return the storage base inside it. Creates it. */
export async function prepareBase(input: string): Promise<string> {
  const raw = String(input ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, "invalid_path");
  const resolved = path.resolve(raw);
  if (sameBase(resolved, DATA_DIR)) return DATA_DIR;
  const base = baseFor(resolved);
  try {
    await fsp.mkdir(base, { recursive: true });
    const probe = path.join(base, `.zimamc-write-test-${process.pid}`);
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
  } catch {
    throw new HttpError(400, "storage_not_writable", { path: resolved });
  }
  await chownForServer(base);
  return base;
}

export async function freeBytes(p: string) {
  return (await space(existingParent(p))).freeBytes;
}

export interface CopyJob {
  state: "copying" | "done" | "failed";
  copied: number;
  total: number;
  error?: string;
}

/** Copy a folder tree, counting bytes for a progress bar. Files are given to the Minecraft user. */
export async function copyTree(from: string, to: string, onBytes: (n: number) => void) {
  await fsp.mkdir(to, { recursive: true });
  await chownForServer(to);
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b, onBytes);
    else if (e.isSymbolicLink()) await fsp.symlink(await fsp.readlink(a), b);
    else if (e.isFile()) {
      await fsp.copyFile(a, b);
      await chownForServer(b);
      onBytes((await fsp.stat(b)).size);
    }
  }
}

/**
 * Move a folder to another place in the background: copy, let the caller switch
 * over, then delete the old copy. On failure the partial copy is removed and the
 * original stays untouched.
 */
export async function startMove(from: string, to: string, job: CopyJob, switchOver: () => void | Promise<void>) {
  if (fs.existsSync(to) && (await fsp.readdir(to)).length > 0) throw new HttpError(409, "target_exists", { path: to });
  job.total = fs.existsSync(from) ? await dirSize(from) : 0;
  if (job.total * 1.05 > (await freeBytes(to))) throw new HttpError(409, "not_enough_space");
  const done = (async () => {
    try {
      if (fs.existsSync(from)) await copyTree(from, to, (n) => (job.copied += n));
      else await fsp.mkdir(to, { recursive: true });
      await switchOver();
      job.state = "done";
      await fsp.rm(from, { recursive: true, force: true }).catch(() => {});
    } catch (e) {
      job.state = "failed";
      job.error = e instanceof HttpError ? e.code : "move_failed";
      console.error("[move]", e);
      await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return { done };
}
