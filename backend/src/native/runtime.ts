import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { DATA_DIR } from "../config.js";
import { plainText } from "../minecraft.js";
import { serverDir } from "../paths.js";
import { ping } from "../ping.js";
import { containerMemoryMB } from "../resources.js";
import type { Runtime, ServerStats, ServerStatus } from "../runtime.js";
import { HttpError, type ServerConfig } from "../store.js";
import { downloadTo } from "./download.js";
import { ensureJava, javaMajorFor, RUNTIME_DIR } from "./java.js";
import { ProcStats } from "./procstats.js";
import { managedProperties, writeServerFiles } from "./properties.js";
import { RconClient } from "./rcon.js";
import { installServer, type InstallContext } from "./software.js";

/** Aikar's G1 settings, which Paper recommends (the Docker image's USE_AIKAR_FLAGS). */
const AIKAR_FLAGS = [
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxGCPauseMillis=200",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC",
  "-XX:G1NewSizePercent=30",
  "-XX:G1MaxNewSizePercent=40",
  "-XX:G1HeapRegionSize=8M",
  "-XX:G1ReservePercent=20",
  "-XX:G1HeapWastePercent=5",
  "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=15",
  "-XX:G1MixedGCLiveThresholdPercent=90",
  "-XX:G1RSetUpdatingPauseIntervalMillis=5000",
  "-XX:SurvivorRatio=32",
  "-XX:+PerfDisableSharedMem",
  "-XX:MaxTenuringThreshold=1",
  "-Dusing.aikars.flags=https://mcflags.emc.gs",
  "-Daikars.new.flags=true",
];

const MAX_LINES = 2000;
const STOP_TIMEOUT_MS = 90_000;
/** A crashed server is started again this many times, like Docker's on-failure restart policy. */
const MAX_RESTARTS = 3;

/** "Done (12.345s)! For help, type "help"" — the server is ready for players. */
const DONE = /\bDone \(\d+[.,]\d+s\)!/;

export interface NativeOptions {
  /** Java executable for a major version. Default: download Eclipse Temurin. */
  java?: (major: number, onProgress: (pct: number) => void) => Promise<string>;
  /** Install the server software; returns the launch arguments. */
  install?: (s: ServerConfig, ctx: InstallContext) => Promise<string[]>;
  /** Folder for pid files of running servers. */
  runDir?: string;
}

interface Proc {
  child: ChildProcess;
  pid: number;
  config: ServerConfig;
  status: ServerStatus;
  stopping: boolean;
  rcon: RconClient;
  startedAt: number;
  lastPing: number;
  restarts: number;
  cpu?: { ms: number; at: number };
  exited: Promise<void>;
}

export function splitArgs(s: string) {
  return (s.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((a) => a.replace(/"/g, ""));
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "0.0.0.0", () => srv.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      const c = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      c.on("exit", () => resolve());
      c.on("error", () => resolve());
    });
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  return Promise.resolve();
}

/**
 * Minecraft servers as plain Java processes, for the desktop app: no Docker
 * needed. ZimaMC downloads Java and the server software itself, writes
 * server.properties and talks to the server over RCON, like the Docker image would.
 */
export class NativeRuntime implements Runtime {
  readonly kind = "native" as const;
  readonly mapsPorts = false;
  pulling = new Map<string, number>();
  /** Between the click on Start and the Java process running (downloads, server.properties). */
  private preparing = new Set<string>();
  private procs = new Map<string, Proc>();
  private lines = new Map<string, string[]>();
  private listeners = new Map<string, Set<(line: string) => void>>();
  private stats_ = new ProcStats();
  private agent?: ChildProcess;
  private runDir: string;

  constructor(private opts: NativeOptions = {}) {
    this.runDir = opts.runDir ?? path.join(RUNTIME_DIR, "run");
  }

  async info() {
    return { MemTotal: os.totalmem(), NCPU: os.availableParallelism() };
  }

  // ---- Console output ----

  private emit(id: string, line: string) {
    let buf = this.lines.get(id);
    if (!buf) this.lines.set(id, (buf = []));
    buf.push(line);
    if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
    for (const fn of this.listeners.get(id) ?? []) fn(line);
  }

  /** Output kept in memory, or the server's last log file after a restart of ZimaMC. */
  private async history(id: string, tail: number) {
    const buf = this.lines.get(id);
    if (buf?.length) return buf.slice(-tail);
    try {
      const text = await fsp.readFile(path.join(serverDir(id), "logs", "latest.log"), "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-tail);
    } catch {
      return [];
    }
  }

  async logs(id: string, tail: number): Promise<Readable> {
    const out = new PassThrough();
    const past = await this.history(id, tail);
    if (past.length) out.write(past.join("\n") + "\n");
    const fn = (line: string) => out.write(line + "\n");
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    out.on("close", () => set!.delete(fn));
    return out;
  }

  async logTail(id: string, tail: number) {
    return (await this.history(id, tail)).join("\n");
  }

  // ---- Status ----

  async status(id: string): Promise<ServerStatus> {
    if (this.pulling.has(id)) return "downloading";
    if (this.preparing.has(id)) return "starting";
    const p = this.procs.get(id);
    if (!p) return "offline";
    // Some mod loaders print their own start-up message: ask the server itself.
    if (p.status === "starting" && Date.now() - p.startedAt > 20_000 && Date.now() - p.lastPing > 5_000) {
      p.lastPing = Date.now();
      ping("127.0.0.1", p.config.port)
        .then(() => {
          if (p.status === "starting" && this.procs.get(id) === p) p.status = "online";
        })
        .catch(() => {});
    }
    return p.status;
  }

  async isRunning(id: string) {
    const p = this.procs.get(id);
    return Boolean(p && (p.status === "starting" || p.status === "online" || p.status === "stopping"));
  }

  // ---- Start and stop ----

  async start(s: ServerConfig) {
    if ((await this.isRunning(s.id)) || this.preparing.has(s.id)) return;
    this.preparing.add(s.id);
    try {
      await this.prepareAndLaunch(s);
    } finally {
      this.preparing.delete(s.id);
    }
  }

  private async prepareAndLaunch(s: ServerConfig) {
    if (!(await portFree(s.port))) throw new HttpError(409, "port_in_use", { port: s.port });
    const dir = serverDir(s.id);
    await fsp.mkdir(dir, { recursive: true });
    this.emit(s.id, `[ZimaMC] Starting ${s.name}…`);

    let java: string;
    let args: string[];
    this.pulling.set(s.id, 0);
    try {
      const progress = (pct: number) => this.pulling.set(s.id, pct);
      const major = javaMajorFor(s);
      java = await (this.opts.java ?? ((m, onProgress) => {
        if (!fs.existsSync(path.join(RUNTIME_DIR, "java", String(m)))) this.emit(s.id, `[ZimaMC] Downloading Java ${m}, this happens only once…`);
        return ensureJava(m, onProgress);
      }))(major, progress);
      this.pulling.set(s.id, 0);
      args = await (this.opts.install ?? installServer)(s, { dir, java, onProgress: progress, log: (l) => this.emit(s.id, l) });
    } catch (e) {
      this.emit(s.id, `[ZimaMC] Could not prepare the server: ${e instanceof HttpError ? e.code : (e as Error).message}`);
      throw e;
    } finally {
      this.pulling.delete(s.id);
    }
    await this.launch(s, java, args, 0);
  }

  private async launch(s: ServerConfig, java: string, args: string[], restarts: number) {
    const dir = serverDir(s.id);
    const rconInfo = { port: await freePort(), password: crypto.randomBytes(18).toString("base64url") };
    await writeServerFiles(dir, managedProperties(s, rconInfo));

    const heap = Math.max(512, Math.round(s.memoryMB));
    const jvm = [
      `-Xms${Math.min(heap, Math.max(512, Math.round(heap / 2)))}M`,
      `-Xmx${heap}M`,
      // Older Java on Windows would otherwise write the console in the local code page.
      "-Dfile.encoding=UTF-8",
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
      ...(s.type === "PAPER" || s.type === "FOLIA" ? AIKAR_FLAGS : []),
      ...splitArgs(s.advanced.jvmFlags ?? ""),
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(s.advanced.extraEnv ?? {})) if (/^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = String(v);

    const child = spawn(java, [...jvm, ...args, "nogui"], { cwd: dir, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const pid = child.pid;
    if (!pid) {
      await new Promise((r) => child.once("error", r));
      throw new HttpError(500, "java_start_failed");
    }
    let resolveExit!: () => void;
    const p: Proc = {
      child,
      pid,
      config: s,
      status: "starting",
      stopping: false,
      rcon: new RconClient(rconInfo.port, rconInfo.password),
      startedAt: Date.now(),
      lastPing: 0,
      restarts,
      exited: new Promise<void>((r) => (resolveExit = r)),
    };
    this.procs.set(s.id, p);
    await fsp.mkdir(this.runDir, { recursive: true });
    await fsp.writeFile(path.join(this.runDir, `${s.id}.json`), JSON.stringify({ pid, ...rconInfo }));

    let partial = "";
    const onData = (c: Buffer) => {
      partial += c.toString("utf8");
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        this.emit(s.id, line);
        if (p.status === "starting" && DONE.test(plainText(line))) p.status = "online";
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.stdin!.on("error", () => {});
    child.on("exit", (code) => {
      if (partial) this.emit(s.id, partial);
      p.rcon.end();
      fs.rmSync(path.join(this.runDir, `${s.id}.json`), { force: true });
      const clean = p.stopping || code === 0;
      p.status = clean ? "offline" : "crashed";
      resolveExit();
      if (clean) return;
      this.emit(s.id, `[ZimaMC] The server stopped unexpectedly (exit code ${code}).`);
      if (p.restarts < MAX_RESTARTS && this.procs.get(s.id) === p) {
        this.emit(s.id, `[ZimaMC] Starting it again (${p.restarts + 1}/${MAX_RESTARTS})…`);
        setTimeout(() => {
          if (this.procs.get(s.id) !== p || p.stopping) return;
          this.launch(s, java, args, p.restarts + 1).catch((e) => this.emit(s.id, `[ZimaMC] ${(e as Error).message}`));
        }, 5_000);
      }
    });
    await this.stats_.limit(pid, s.cpus).catch(() => {});
  }

  async setCpus(id: string, cpus: number) {
    const p = this.procs.get(id);
    if (p && (await this.isRunning(id))) await this.stats_.limit(p.pid, cpus).catch(() => {});
  }

  async stop(id: string) {
    const p = this.procs.get(id);
    if (!p || !(await this.isRunning(id))) return;
    p.stopping = true;
    p.status = "stopping";
    // "stop" on the console saves the world and exits; works even when RCON is not up yet.
    p.child.stdin?.write("stop\n");
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), STOP_TIMEOUT_MS).unref());
    if ((await Promise.race([p.exited, timeout])) === "timeout") {
      this.emit(id, "[ZimaMC] The server did not stop in time and was ended.");
      await killTree(p.pid);
      await p.exited;
    }
  }

  async kill(id: string) {
    const p = this.procs.get(id);
    if (!p || !(await this.isRunning(id))) return;
    p.stopping = true;
    await killTree(p.pid);
    await p.exited;
  }

  async remove(id: string) {
    await this.kill(id);
    this.procs.delete(id);
    this.lines.delete(id);
  }

  async stats(id: string): Promise<ServerStats | null> {
    const p = this.procs.get(id);
    if (!p || !(await this.isRunning(id))) return null;
    const sample = (await this.stats_.sample([p.pid])).get(p.pid);
    if (!sample) return null;
    const now = Date.now();
    const prev = p.cpu;
    p.cpu = { ms: sample.cpuMs, at: now };
    // 100 % = one full core, like Docker reports it.
    const cpuPercent = prev && now > prev.at ? Math.max(0, ((sample.cpuMs - prev.ms) / (now - prev.at)) * 100) : 0;
    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryMB: Math.round(sample.memoryBytes / 1024 / 1024),
      memoryLimitMB: containerMemoryMB(p.config.memoryMB),
    };
  }

  async rcon(id: string, command: string) {
    const p = this.procs.get(id);
    if (!p || !(await this.isRunning(id))) throw new HttpError(409, "server_offline");
    if (p.status !== "online") {
      // RCON opens only once the server is ready; until then type into its console.
      p.child.stdin?.write(command + "\n");
      return "";
    }
    return plainText(await p.rcon.command(command));
  }

  // ---- After a restart of ZimaMC ----

  /**
   * Servers left running by a previous run of ZimaMC (it crashed or was ended)
   * can't be attached to again: stop them cleanly over RCON so they can be started fresh.
   */
  async recover() {
    let files: string[] = [];
    try {
      files = (await fsp.readdir(this.runDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    await Promise.all(
      files.map(async (f) => {
        const file = path.join(this.runDir, f);
        try {
          const { pid, port, password } = JSON.parse(await fsp.readFile(file, "utf8")) as { pid: number; port: number; password: string };
          if (!alive(pid)) return;
          // Only a process that knows our password is ours; never touch anything else.
          const rcon = new RconClient(port, password);
          try {
            await rcon.command("stop");
          } catch {
            return;
          } finally {
            rcon.end();
          }
          for (let i = 0; i < STOP_TIMEOUT_MS / 500 && alive(pid); i++) await new Promise((r) => setTimeout(r, 500));
          if (alive(pid)) await killTree(pid);
        } catch {
          /* unreadable file */
        } finally {
          await fsp.rm(file, { force: true });
        }
      }),
    );
  }

  async shutdown() {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id).catch(() => {})));
    await this.removeAgent();
    this.stats_.close();
  }

  // ---- playit.gg agent ----

  private agentFile() {
    const exe = process.platform === "win32" ? "playit.exe" : "playit";
    const asset =
      process.platform === "win32"
        ? "playit-windows-x86_64-signed.exe"
        : process.platform === "darwin"
          ? "playit-darwin-arm64"
          : os.arch() === "arm64"
            ? "playit-linux-aarch64"
            : "playit-linux-amd64";
    return { file: path.join(RUNTIME_DIR, "playit", exe), url: `https://github.com/playit-cloud/playit-agent/releases/latest/download/${asset}` };
  }

  async startAgent(secretKey: string) {
    await this.removeAgent();
    const { file, url } = this.agentFile();
    if (!fs.existsSync(file)) {
      await downloadTo(url, file);
      if (process.platform !== "win32") await fsp.chmod(file, 0o755);
    }
    const child = spawn(file, ["--secret", secretKey, "--stdout", "start"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (e) => console.error("[playit]", e.message));
    const log = (c: Buffer) => {
      for (const l of plainText(c.toString("utf8")).split(/\r?\n/)) if (/error|fail/i.test(l)) console.error("[playit]", l);
    };
    child.stdout!.on("data", log);
    child.stderr!.on("data", log);
    this.agent = child;
  }

  async agentRunning() {
    return Boolean(this.agent && this.agent.exitCode === null && !this.agent.killed);
  }

  async removeAgent() {
    if (this.agent?.pid && this.agent.exitCode === null) await killTree(this.agent.pid);
    this.agent = undefined;
  }
}
