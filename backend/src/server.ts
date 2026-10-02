import fs from "node:fs";
import { buildApp } from "./app.js";
import { BACKUPS_DIR, DATA_DIR, HOST, PORT, SERVERS_DIR, VERSION } from "./config.js";

export interface StartOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  /** Try a random free port when the usual one is taken (the desktop app). */
  anyPort?: boolean;
}

/**
 * Start ZimaMC: the web interface and API, plus the background jobs
 * (status, backups, dynamic DNS, tunnels) and auto-starting servers.
 * Used by the command line (index.ts) and by the desktop app.
 */
export async function startZimaMC(opts: StartOptions = {}) {
  for (const d of [DATA_DIR, SERVERS_DIR, BACKUPS_DIR]) fs.mkdirSync(d, { recursive: true });
  const built = await buildApp({ staticDir: opts.staticDir });
  const { app, servers, backups, runtime } = built;

  const host = opts.host ?? HOST;
  let port = opts.port ?? PORT;
  try {
    await app.listen({ port, host });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || !opts.anyPort) {
      throw (e as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? new Error(`Port ${port} is already in use. Is ZimaMC already running? Set PORT to use another one.`)
        : e;
    }
    await app.listen({ port: 0, host });
  }
  const addr = app.server.address();
  if (addr && typeof addr === "object") port = addr.port;
  const url = `http://${host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host}:${port}`;

  /** Run a task now and then every `ms`, never overlapping itself. */
  const timers: NodeJS.Timeout[] = [];
  function every(ms: number, name: string, fn: () => Promise<unknown>) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        console.error(`[${name}]`, e);
      } finally {
        running = false;
      }
    };
    void run();
    timers.push(setInterval(run, ms));
  }

  every(4_000, "refresh", () => servers.refresh());
  every(60_000, "backups", () => backups.tick());
  every(5 * 60_000, "ddns", () => servers.ddnsTick());
  every(15_000, "tunnels", () => servers.tunnelTick());
  servers.autoStart().catch((e) => console.error("[autostart]", e));

  let stopping: Promise<void> | undefined;
  return {
    ...built,
    url,
    port,
    version: VERSION,
    /** Stop the web interface; plain-process servers are saved and stopped, Docker containers keep running. */
    stop() {
      stopping ??= (async () => {
        for (const t of timers) clearInterval(t);
        await runtime.shutdown?.();
        await app.close();
      })();
      return stopping;
    },
  };
}
