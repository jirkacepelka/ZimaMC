import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { fetchJson } from "../http.js";
import { javaTagFor } from "../minecraft.js";
import { HttpError, type ServerConfig } from "../store.js";
import { extractTarGz, extractZip } from "./archive.js";
import { downloadTo } from "./download.js";

export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");

/** Java major version a server needs: from its Expert setting ("java17", "java21-graalvm") or its Minecraft version. */
export function javaMajorFor(s: Pick<ServerConfig, "version" | "advanced">) {
  const tag = s.advanced?.javaImageTag || javaTagFor(s.version);
  const m = tag.match(/java(\d+)/);
  return m ? Number(m[1]) : Number(javaTagFor(s.version).slice(4));
}

const javaExe = (home: string) => path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java");

/** Where a downloaded archive keeps bin/java (macOS archives nest it in Contents/Home). */
function findHome(dir: string) {
  for (const home of [dir, path.join(dir, "Contents", "Home")]) if (fs.existsSync(javaExe(home))) return home;
  return null;
}

interface AdoptiumAsset {
  binary: { package: { link: string; checksum: string; name: string } };
}

function platform() {
  const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const arch = os.arch() === "arm64" ? "aarch64" : "x64";
  return { osName, arch };
}

const installing = new Map<number, Promise<string>>();

/**
 * Path of a java executable for this major version, downloading Eclipse
 * Temurin into the data folder the first time it is needed.
 */
export function ensureJava(major: number, onProgress?: (pct: number) => void): Promise<string> {
  const home = path.join(RUNTIME_DIR, "java", String(major));
  const found = findHome(home);
  if (found) return Promise.resolve(javaExe(found));
  // Two servers may need the same Java at once; download it once.
  let p = installing.get(major);
  if (!p) {
    p = installJava(major, home, onProgress).finally(() => installing.delete(major));
    installing.set(major, p);
  }
  return p;
}

async function installJava(major: number, home: string, onProgress?: (pct: number) => void) {
  const { osName, arch } = platform();
  let asset: AdoptiumAsset | undefined;
  // A JRE is enough and smaller; fall back to a JDK where no JRE is published.
  for (const imageType of ["jre", "jdk"]) {
    const list = await fetchJson<AdoptiumAsset[]>(
      `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=${imageType}&os=${osName}&vendor=eclipse`,
      {},
      "java_download_failed",
    ).catch(() => []);
    asset = list.find((a) => /\.(zip|tar\.gz)$/.test(a.binary.package.name));
    if (asset) break;
  }
  if (!asset) throw new HttpError(502, "java_download_failed");
  const pkg = asset.binary.package;
  const archive = path.join(RUNTIME_DIR, "downloads", pkg.name);
  await downloadTo(pkg.link, archive, { onProgress, hash: pkg.checksum ? { algorithm: "sha256", hex: pkg.checksum } : undefined });
  const tmp = `${home}.unpacking`;
  await fsp.rm(tmp, { recursive: true, force: true });
  if (pkg.name.endsWith(".zip")) await extractZip(archive, tmp);
  else await extractTarGz(archive, tmp);
  await fsp.rm(archive, { force: true });
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rename(tmp, home);
  const found = findHome(home);
  if (!found) throw new Error(`Java ${major} archive has no bin/java`);
  return javaExe(found);
}
