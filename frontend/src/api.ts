export type ServerType = "PAPER" | "VANILLA" | "FABRIC" | "FORGE";
export type ServerStatus = "offline" | "downloading" | "starting" | "online" | "stopping" | "crashed";

export interface Properties {
  motd: string;
  maxPlayers: number;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  gamemode: "survival" | "creative" | "adventure" | "spectator";
  pvp: boolean;
  onlineMode: boolean;
  whitelist: boolean;
  viewDistance: number;
}

export interface InstalledProject {
  projectId: string;
  versionId: string;
  title: string;
  fileName: string;
  iconUrl?: string;
}

export interface Server {
  id: string;
  name: string;
  type: ServerType;
  version: string;
  memoryMB: number;
  cpus: number;
  port: number;
  properties: Properties;
  advanced: { javaImageTag?: string; jvmFlags?: string; extraEnv?: Record<string, string> };
  autoStart: boolean;
  projects: InstalledProject[];
  backup: { everyHours: number; keep: number; lastAt?: string };
  domain?: { zoneId: string; zoneName: string; name: string };
  tunnel?: { tunnelId: string; address?: string };
  status: ServerStatus;
  downloadProgress?: number;
  stats: { cpuPercent: number; memoryMB: number; memoryLimitMB: number } | null;
  players: { online: number; max: number; names: string[] };
  containerMemoryMB: number;
  address: { lan?: string; public?: string; domain?: string; tunnel?: string };
}

export interface SystemInfo {
  version: string;
  docker: boolean;
  host: { memoryMB: number; cpus: number };
  suggestedLimits: { memoryMB: number; cpus: number };
  settings: {
    language: string;
    showAdvanced: boolean;
    limits: { memoryMB: number; cpus: number };
    network: { lanIp?: string; publicIp?: string; upnp: boolean };
    cloudflareConnected: boolean;
    playitConnected: boolean;
  };
  usage: {
    limits: { memoryMB: number; cpus: number };
    reserved: { memoryMB: number; cpus: number };
    used: { memoryMB: number; cpuPercent: number };
    diskBytes: number;
  };
}

/** Error returned by the API: `code` is a key under "errors." in the locale files. */
export class ApiError extends Error {
  constructor(
    public code: string,
    public params: Record<string, unknown> = {},
    public status = 0,
  ) {
    super(code);
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("offline");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === "not_logged_in") window.dispatchEvent(new Event("zimamc:logout"));
    throw new ApiError(data.error ?? "internal", data.params ?? {}, res.status);
  }
  return data as T;
}

export const get = <T>(url: string) => api<T>("GET", url);
export const post = <T>(url: string, body: unknown = {}) => api<T>("POST", url, body);
export const put = <T>(url: string, body: unknown = {}) => api<T>("PUT", url, body);
export const patch = <T>(url: string, body: unknown = {}) => api<T>("PATCH", url, body);
export const del = <T>(url: string) => api<T>("DELETE", url);

export function formatMB(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
}

export function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
