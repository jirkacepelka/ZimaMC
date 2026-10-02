import os from "node:os";
import path from "node:path";

export const VERSION = "0.10.0";
export const IS_WINDOWS = process.platform === "win32";

/**
 * Directory where ZimaMC keeps everything. In the container it is mounted by the
 * app definition; on Windows it lives in the user's AppData folder.
 */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? (IS_WINDOWS ? path.join(process.env.APPDATA ?? os.homedir(), "ZimaMC") : "./data"));

/**
 * The same directory as seen by the Docker host. Minecraft servers run as
 * sibling containers, so their bind mounts must use host paths.
 */
export const HOST_DATA_DIR = process.env.HOST_DATA_DIR ?? DATA_DIR;

export const PORT = Number(process.env.PORT ?? 8765);
// On a desktop PC the panel is only for that PC unless the user opts in; on a NAS it is for the whole network.
export const HOST = process.env.HOST ?? (IS_WINDOWS ? "127.0.0.1" : "0.0.0.0");

/**
 * The same path as the Docker host sees it, for bind mounts of Minecraft containers.
 * Only DATA_DIR may be mounted elsewhere; other disks (/media, /DATA, D:\\) are mounted 1:1.
 */
export function toHostPath(p: string) {
  const rel = path.relative(DATA_DIR, p);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return path.join(HOST_DATA_DIR, rel);
  return p;
}

export const SERVERS_DIR = path.join(DATA_DIR, "servers");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const STORE_FILE = path.join(DATA_DIR, "zimamc.json");

/** Image used for every Minecraft server. It downloads Paper/Vanilla/Fabric/Forge itself. */
export const MC_IMAGE = process.env.MC_IMAGE ?? "itzg/minecraft-server";
export const PLAYIT_IMAGE = process.env.PLAYIT_IMAGE ?? "ghcr.io/playit-cloud/playit-agent:0.16";

/** Prefix of every container ZimaMC creates, so we never touch anything else. */
export const CONTAINER_PREFIX = "zimamc-";

/** UID/GID the Minecraft container runs as; files we write are chowned to it. */
export const MC_UID = Number(process.env.MC_UID ?? 1000);
export const MC_GID = Number(process.env.MC_GID ?? 1000);
