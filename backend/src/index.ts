import fs from "node:fs";
import { buildApp } from "./app.js";
import { BACKUPS_DIR, DATA_DIR, HOST, PORT, SERVERS_DIR, VERSION } from "./config.js";

for (const d of [DATA_DIR, SERVERS_DIR, BACKUPS_DIR]) fs.mkdirSync(d, { recursive: true });

const { app, servers, backups, store } = await buildApp();

// Password recovery: set RESET_PASSWORD=true in the app's settings and restart.
if (/^(1|true|yes)$/i.test(process.env.RESET_PASSWORD ?? "") && store.settings.auth) {
  delete store.settings.auth;
  store.save();
  console.warn("RESET_PASSWORD is set: the password was removed. Open ZimaMC to choose a new one, then remove the variable.");
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

await app.listen({ port: PORT, host: HOST });
console.log(`ZimaMC ${VERSION} is running on http://${HOST}:${PORT}`);

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
