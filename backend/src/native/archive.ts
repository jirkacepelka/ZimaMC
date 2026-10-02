import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { x as untar } from "tar";

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
  mode: number;
}

async function zipEntries(fh: fsp.FileHandle): Promise<ZipEntry[]> {
  const size = (await fh.stat()).size;
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const out: ZipEntry[] = [];
  for (let p = 0; p + 46 <= cdSize && cd.readUInt32LE(p) === 0x02014b50; ) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    out.push({
      method: cd.readUInt16LE(p + 10),
      compSize: cd.readUInt32LE(p + 20),
      localOffset: cd.readUInt32LE(p + 42),
      // Unix permissions live in the high half of the external attributes.
      mode: cd.readUInt32LE(p + 38) >>> 16,
      name: cd.toString("utf8", p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Unpack a zip archive into `dest`, dropping the top folder of every path
 * (archives of Java ship everything inside "jdk-21.0.4+7-jre/").
 */
export async function extractZip(file: string, dest: string, stripFirst = true) {
  const fh = await fsp.open(file, "r");
  try {
    const root = path.resolve(dest);
    for (const e of await zipEntries(fh)) {
      let name = e.name.replace(/\\/g, "/");
      if (stripFirst) name = name.split("/").slice(1).join("/");
      if (!name) continue;
      const target = path.resolve(root, name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in archive: ${e.name}`);
      if (name.endsWith("/")) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.localOffset);
      const start = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const src = fs.createReadStream(file, { start, end: start + e.compSize - 1 });
      const out = fs.createWriteStream(target, e.mode & 0o111 ? { mode: 0o755 } : {});
      if (e.compSize === 0) {
        src.destroy();
        await new Promise<void>((resolve, reject) => out.end(() => resolve()).on("error", reject));
      } else if (e.method === 0) await pipeline(src, out);
      else if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), out);
      else throw new Error(`unsupported compression in ${e.name}`);
    }
  } finally {
    await fh.close();
  }
}

export async function extractTarGz(file: string, dest: string) {
  await fsp.mkdir(dest, { recursive: true });
  await untar({ file, cwd: dest, strip: 1 });
}
