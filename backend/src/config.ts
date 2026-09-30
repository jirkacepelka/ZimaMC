import path from "node:path";

/** Directory inside this container where ZimaMC keeps everything. */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "./data");

/**
 * The same directory as seen by the Docker host. Minecraft servers run as
 * sibling containers, so their bind mounts must use host paths.
 */
export const HOST_DATA_DIR = process.env.HOST_DATA_DIR ?? DATA_DIR;

export const PORT = Number(process.env.PORT ?? 8765);
export const HOST = process.env.HOST ?? "0.0.0.0";
export const VERSION = "0.1.0";

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
