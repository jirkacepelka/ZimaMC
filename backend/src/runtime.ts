import type { Readable } from "node:stream";
import type { ServerConfig } from "./store.js";

export type ServerStatus = "offline" | "downloading" | "starting" | "online" | "stopping" | "crashed";

export interface ServerStats {
  cpuPercent: number;
  memoryMB: number;
  memoryLimitMB: number;
}

/**
 * Where Minecraft servers run. On ZimaOS every server is a Docker container
 * (docker.ts); in the Windows app they are plain Java processes (native/).
 */
export interface Runtime {
  readonly kind: "docker" | "native";
  /**
   * Whether extra ports are published under another number (Docker). Without
   * it a plugin's port is reachable only under its own number.
   */
  readonly mapsPorts: boolean;
  /** Downloads before a start (image, Java, server jar), by server id, with 0-100 progress. */
  pulling: Map<string, number>;

  info(): Promise<{ MemTotal: number; NCPU: number }>;
  status(id: string): Promise<ServerStatus>;
  isRunning(id: string): Promise<boolean>;
  start(s: ServerConfig): Promise<void>;
  setCpus(id: string, cpus: number): Promise<void>;
  stop(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  stats(id: string): Promise<ServerStats | null>;
  /** Send a console command and return its reply. */
  rcon(id: string, command: string): Promise<string>;
  /** The server's console output, following new lines. */
  logs(id: string, tail: number): Promise<Readable>;
  logTail(id: string, tail: number): Promise<string>;

  /** The playit.gg agent for tunnels. */
  startAgent(secretKey: string): Promise<void>;
  agentRunning(): Promise<boolean>;
  removeAgent(): Promise<void>;

  /** After a restart of ZimaMC: deal with servers left running by the previous run. */
  recover?(servers: ServerConfig[]): Promise<void>;
  /** Stop everything cleanly, e.g. when the desktop app quits. */
  shutdown?(): Promise<void>;
}
