import path from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Where each server and the backups live. A "storage base" is a folder that holds
 * servers/<id> and backups/<id>: DATA_DIR by default, <disk>/ZimaMC on other disks.
 */
const serverBases = new Map<string, string>();
let backupsBase: string | undefined;

export function setServerBase(id: string, base: string | undefined) {
  if (base) serverBases.set(id, base);
  else serverBases.delete(id);
}

export function setBackupsBase(base: string | undefined) {
  backupsBase = base;
}

export const serverDir = (id: string) => path.join(serverBases.get(id) ?? DATA_DIR, "servers", id);
export const backupDir = (id: string) => path.join(backupsBase ?? DATA_DIR, "backups", id);
