// End-to-end check of servers without Docker, run in CI on Windows: start the bundled
// backend, create a real Paper server (Java and Paper are downloaded), wait until players
// could join, run a console command over RCON, then stop it cleanly.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zimamc-smoke-"));
const port = 8799;
const base = `http://127.0.0.1:${port}`;
const type = process.argv[2] ?? "PAPER";

const backend = spawn(
  process.execPath,
  ["-e", `require(${JSON.stringify(path.join(dist, "backend.cjs"))}).startZimaMC({ staticDir: ${JSON.stringify(path.join(dist, "ui"))} })`],
  { env: { ...process.env, DATA_DIR: dataDir, ZIMAMC_RUNTIME: "native", PORT: String(port), HOST: "127.0.0.1" }, stdio: "inherit" },
);

let cookie = "";
async function api(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function consoleTail(id) {
  try {
    return fs.readFileSync(path.join(dataDir, "servers", id, "logs", "zimamc-console.log"), "utf8").split("\n").slice(-80).join("\n");
  } catch {
    return "(no console log)";
  }
}

let id;
try {
  for (let i = 0; ; i++) {
    try {
      await api("GET", "/api/status");
      break;
    } catch (e) {
      if (i > 60) throw e;
      await sleep(500);
    }
  }
  await api("POST", "/api/setup", { password: "smoke-test", language: "en", limits: { memoryMB: 4096, cpus: 2 } });
  const created = await api("POST", "/api/servers", { name: "Smoke", type, maxPlayers: 5, start: true, backup: { everyHours: 0 } });
  id = created.server.id;
  if (created.startError) throw new Error(`start failed: ${JSON.stringify(created.startError)}`);
  console.log(`Created ${type} ${created.server.version}; waiting for it to come online…`);

  const started = Date.now();
  let last = "";
  for (;;) {
    const { server } = await api("GET", `/api/servers/${id}`);
    const now = `${server.status}${server.downloadProgress !== undefined ? ` ${server.downloadProgress}%` : ""}`;
    if (now !== last) console.log(`  ${Math.round((Date.now() - started) / 1000)}s: ${now}`);
    last = now;
    if (server.status === "online") break;
    if (server.status === "crashed" || (server.status === "offline" && Date.now() - started > 30_000)) throw new Error(`server is ${server.status}`);
    if (Date.now() - started > 10 * 60_000) throw new Error("server did not come online in 10 minutes");
    await sleep(2000);
  }

  const { output } = await api("POST", `/api/servers/${id}/command`, { command: "list" });
  console.log(`list → ${output}`);
  if (!/players online/i.test(output)) throw new Error("unexpected reply to list");
  const { server } = await api("GET", `/api/servers/${id}`);
  console.log(`stats → ${JSON.stringify(server.stats)}`);

  // The API answers right away and the interface follows the status, so wait for it like the UI does.
  await api("POST", `/api/servers/${id}/stop`);
  const stopAt = Date.now();
  for (;;) {
    const { server: s } = await api("GET", `/api/servers/${id}`);
    if (s.status === "offline") break;
    if (s.status === "crashed") throw new Error("the server crashed while stopping");
    if (Date.now() - stopAt > 120_000) throw new Error(`the server is still ${s.status} after 2 minutes`);
    await sleep(1000);
  }
  console.log(`stopped in ${Math.round((Date.now() - stopAt) / 1000)}s`);
  if (!fs.existsSync(path.join(dataDir, "servers", id, "world", "level.dat"))) throw new Error("the world was not saved");
  console.log(`Native ${type} server: OK`);
  backend.kill();
  process.exit(0);
} catch (e) {
  console.error(e);
  if (id) console.error(consoleTail(id));
  backend.kill();
  process.exit(1);
}
