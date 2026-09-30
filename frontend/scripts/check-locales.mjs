// Checks every language file against en.json: reports missing and unknown keys.
// Usage: npm run check-locales -w frontend
import fs from "node:fs";
import path from "node:path";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../src/locales");
const PLURAL = /_(zero|one|two|few|many|other)$/;

function keys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`.replace(PLURAL, "")],
  );
}

const en = new Set(keys(JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8"))));
let failed = false;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const k = new Set(keys(data));
  const missing = [...en].filter((x) => !k.has(x));
  const extra = [...k].filter((x) => !en.has(x));
  if (!data._meta?.name) console.log(`${f}: add "_meta": { "name": "..." }`);
  console.log(`${f}: ${missing.length ? `${missing.length} missing` : "complete"}${extra.length ? `, ${extra.length} unknown` : ""}`);
  for (const m of missing) console.log(`  missing: ${m}`);
  for (const m of extra) console.log(`  unknown: ${m}`);
  if (missing.length || extra.length) failed = true;
}
process.exit(failed ? 1 : 0);
