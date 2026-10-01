import { spawn } from "node:child_process";
import fs from "node:fs";
import { buildApp } from "./app.js";
import { BACKUPS_DIR, DATA_DIR, HOST, IS_WINDOWS, PORT, SERVERS_DIR, VERSION } from "./config.js";
import { IS_PACKED_APP, unpackUi } from "./sea.js";

/** In the packed Windows app a crash would close the window before anyone can read the message. */
async function fatal(e: unknown): Promise<never> {
  console.error("\nZimaMC could not start:\n", e instanceof Error ? e.message : e);
  if (IS_PACKED_APP && process.stdin.isTTY) {
    console.error("\nPress Enter to close this window.");
    await new Promise((r) => process.stdin.once("data", r));
  }
  process.exit(1);
}

// Wrapped in a function: the packed app is a CommonJS bundle, which has no top-level await.
async function main() {
  if (IS_PACKED_APP) process.noDeprecation = true;
  try {
    for (const d of [DATA_DIR, SERVERS_DIR, BACKUPS_DIR]) fs.mkdirSync(d, { recursive: true });
    const ui = await unpackUi();
    if (ui) process.env.STATIC_DIR = ui;
  } catch (e) {
    await fatal(e);
  }

  const { app, servers, backups, store } = await buildApp().catch(fatal);

  // Password recovery: set RESET_PASSWORD=true in the app's settings (or start with --reset-password) and restart.
  if ((/^(1|true|yes)$/i.test(process.env.RESET_PASSWORD ?? "") || process.argv.includes("--reset-password")) && store.settings.auth) {
    delete store.settings.auth;
    store.save();
    console.warn("The password was removed. Open ZimaMC to choose a new one, then start without --reset-password / RESET_PASSWORD.");
  }

  /** Run a task now and then every `ms`, never overlapping itself. */
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
    return setInterval(run, ms);
  }

  await app.listen({ port: PORT, host: HOST }).catch((e) =>
    fatal(e?.code === "EADDRINUSE" ? new Error(`Port ${PORT} is already in use. Is ZimaMC already running? Set PORT to use another one.`) : e),
  );
  const url = `http://${HOST === "0.0.0.0" || HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`;
  console.log(`ZimaMC ${VERSION} is running on ${url}`);
  if (IS_PACKED_APP) {
    console.log("Keep this window open while you use ZimaMC. Closing it stops the web page, not your Minecraft servers.");
    if (IS_WINDOWS && process.env.NO_BROWSER !== "1") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  }

  every(4_000, "refresh", () => servers.refresh());
  every(60_000, "backups", () => backups.tick());
  every(5 * 60_000, "ddns", () => servers.ddnsTick());
  every(15_000, "tunnels", () => servers.tunnelTick());
  servers.autoStart().catch((e) => console.error("[autostart]", e));

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      // Minecraft servers keep running in their own containers.
      await app.close();
      process.exit(0);
    });
  }
}

void main();
