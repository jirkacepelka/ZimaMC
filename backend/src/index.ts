import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, VERSION } from "./config.js";
import { Store } from "./store.js";
import { startZimaMC } from "./server.js";

// Password recovery: set RESET_PASSWORD=true in the app's settings (or start with --reset-password) and restart.
if (/^(1|true|yes)$/i.test(process.env.RESET_PASSWORD ?? "") || process.argv.includes("--reset-password")) {
  const store = new Store();
  if (store.settings.auth) {
    delete store.settings.auth;
    store.save();
    fs.rmSync(path.join(DATA_DIR, "sessions.json"), { force: true });
    console.warn("The password was removed. Open ZimaMC to choose a new one, then start without --reset-password / RESET_PASSWORD.");
  }
}

try {
  const zima = await startZimaMC();
  console.log(`ZimaMC ${VERSION} is running on ${zima.url}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await zima.stop();
      process.exit(0);
    });
  }
} catch (e) {
  console.error("ZimaMC could not start:", e instanceof Error ? e.message : e);
  process.exit(1);
}
