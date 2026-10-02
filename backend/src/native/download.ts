import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { download } from "../http.js";
import { HttpError } from "../store.js";

export interface DownloadOptions {
  /** 0-100 as bytes arrive (only when the size is known). */
  onProgress?: (pct: number) => void;
  /** Expected hash, e.g. { algorithm: "sha256", hex: "…" }. */
  hash?: { algorithm: "sha1" | "sha256"; hex: string };
}

/** Download a file next to its destination first, so a cut connection never leaves half a jar behind. */
export async function downloadTo(url: string, dest: string, opts: DownloadOptions = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await download(url);
  const total = Number(res.headers.get("content-length") ?? 0);
  const tmp = `${dest}.part`;
  const hash = opts.hash ? crypto.createHash(opts.hash.algorithm) : undefined;
  let got = 0;
  let last = -1;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (c: Buffer) => {
    got += c.length;
    hash?.update(c);
    if (total > 0 && opts.onProgress) {
      const pct = Math.min(100, Math.floor((got / total) * 100));
      if (pct !== last) opts.onProgress((last = pct));
    }
  });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    if (hash && opts.hash && hash.digest("hex").toLowerCase() !== opts.hash.hex.toLowerCase()) {
      throw new HttpError(502, "download_failed", { url: new URL(url).host, status: "checksum" });
    }
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "download_failed", { url: new URL(url).host });
  }
}
