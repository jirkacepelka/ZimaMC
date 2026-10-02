import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, IS_WINDOWS } from "./config.js";
import { chownForServer } from "./files.js";
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

/** Where ZimaOS mounts drives. Overridable for tests. */
const mediaDir = () => process.env.ZIMAMC_MEDIA_DIR ?? "/media";

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
    for (const parent of [mediaDir(), "/mnt"]) {
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
    // A folder the user picked: name it after that folder, e.g. "Games" for /media/HDD/Games/ZimaMC.
    const label = path.basename(path.basename(base) === BASE_NAME ? path.dirname(base) : base) || base;
    out.push({ path: base, label, ...(await space(existingParent(base))), default: false });
  }
  return out;
}

/** Running in a container (the ZimaOS app), where only mounted folders reach the real disks. */
export const inContainer = () =>
  process.env.ZIMAMC_IN_CONTAINER !== undefined ? process.env.ZIMAMC_IN_CONTAINER === "1" : fs.existsSync("/.dockerenv");

const explicitRoots = () => (process.env.STORAGE_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Folders the user may browse and pick from. In the container only mounted
 * volumes count: anything else lives inside the container (or, as a bind mount
 * of a sibling container, on the system disk) and is not what the user meant.
 */
export function allowedRoots(): string[] {
  const extra = explicitRoots();
  if (IS_WINDOWS) return [...candidateRoots().filter((r) => !r.explicit).map((r) => r.root), ...extra];
  if (inContainer()) return [...new Set(["/DATA", mediaDir(), DATA_DIR, ...extra])].filter((r) => fs.existsSync(r));
  return ["/", ...extra];
}

const isInside = (p: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const isAllowed = (p: string) => allowedRoots().some((r) => isInside(p, r));

/**
 * Turn what the user typed or pasted into an existing folder. ZimaOS's Files app
 * copies paths without the mount point: "/HDD-Storage/Games" is really
 * "/media/HDD-Storage/Games", and "/ZimaOS-HD/..." is "/DATA/...". The folder must
 * exist: ZimaMC never creates the user's folder, only its own ZimaMC folder inside.
 */
export function resolveUserPath(input: string): string {
  const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new HttpError(400, "invalid_path");
  if (!IS_WINDOWS && !raw.startsWith("/")) throw new HttpError(400, "invalid_path");
  if (IS_WINDOWS && !path.isAbsolute(raw)) throw new HttpError(400, "invalid_path");
  const p = path.resolve(raw);
  const candidates = [p];
  if (!IS_WINDOWS) {
    candidates.push(path.join(mediaDir(), p));
    const [, first, ...rest] = p.split("/");
    if (first === "ZimaOS-HD") candidates.push(path.join("/DATA", ...rest));
  }
  const found = candidates.find((c) => {
    try {
      return fs.statSync(c).isDirectory();
    } catch {
      return false;
    }
  });
  if (!found) throw new HttpError(400, "folder_not_found", { path: raw });
  if (!isAllowed(found)) throw new HttpError(400, "not_mounted", { path: found });
  return found;
}

/** Check a folder the user picked and return the storage base inside it (its ZimaMC folder, created if needed). */
export async function prepareBase(input: string): Promise<string> {
  const raw = String(input ?? "").trim();
  if (raw && sameBase(path.resolve(raw), DATA_DIR)) return DATA_DIR;
  // Bases offered by ZimaMC end in ZimaMC and may not exist yet; their parent must.
  const isBase = path.basename(raw) === BASE_NAME;
  const folder = resolveUserPath(isBase ? path.dirname(raw) : raw);
  if (sameBase(folder, DATA_DIR)) return DATA_DIR;
  const base = baseFor(isBase ? path.join(folder, BASE_NAME) : folder);
  try {
    await fsp.mkdir(base, { recursive: true });
    const probe = path.join(base, `.zimamc-write-test-${process.pid}`);
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
  } catch {
    throw new HttpError(400, "storage_not_writable", { path: folder });
  }
  await chownForServer(base);
  return base;
}

export async function freeBytes(p: string) {
  return (await space(existingParent(p))).freeBytes;
}

export async function spaceOf(p: string) {
  return space(existingParent(p));
}

/** List the subfolders of a folder, for the folder picker. Without a path: the starting points. */
export async function browse(input?: string) {
  if (!input) {
    const roots = IS_WINDOWS || inContainer() ? allowedRoots() : ["/", ...candidateRoots().map((r) => r.root)];
    return { path: "", parent: null, dirs: [...new Set(roots)].filter((r) => fs.existsSync(r)).map((r) => ({ name: r, path: r })) };
  }
  const p = path.resolve(String(input));
  if (!isAllowed(p)) throw new HttpError(400, "not_mounted", { path: p });
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    throw new HttpError(400, "folder_not_found", { path: p });
  }
  const dirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
    .filter((d) => {
      try {
        return fs.statSync(d.path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const up = path.dirname(p);
  return { path: p, parent: up !== p && isAllowed(up) ? up : "", dirs };
}

/** Space a folder really takes: a file hardlinked several times counts once. */
export async function uniqueSize(dir: string, seen = new Set<string>()): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await uniqueSize(p, seen);
    else if (e.isFile()) {
      const st = await fsp.stat(p);
      const key = `${st.dev}:${st.ino}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += st.size;
    }
  }
  return total;
}

export interface CopyJob {
  state: "copying" | "done" | "failed";
  copied: number;
  total: number;
  error?: string;
}

/**
 * Copy a folder tree, counting bytes for a progress bar. Files are given to the
 * Minecraft user. Files hardlinked to each other (incremental backups) stay
 * hardlinked in the copy, so their data is not duplicated.
 */
export async function copyTree(from: string, to: string, onBytes: (n: number) => void, links = new Map<string, string>()) {
  await fsp.mkdir(to, { recursive: true });
  await chownForServer(to);
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b, onBytes, links);
    else if (e.isSymbolicLink()) await fsp.symlink(await fsp.readlink(a), b);
    else if (e.isFile()) {
      const st = await fsp.stat(a);
      const key = `${st.dev}:${st.ino}`;
      const twin = st.nlink > 1 ? links.get(key) : undefined;
      // Hardlinks take no extra space, so they don't count towards progress either.
      if (twin && (await fsp.link(twin, b).then(() => true, () => false))) continue;
      await fsp.copyFile(a, b);
      await fsp.utimes(b, st.atime, st.mtime).catch(() => {});
      await chownForServer(b);
      if (st.nlink > 1) links.set(key, b);
      onBytes(st.size);
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
  job.total = await uniqueSize(from);
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
