import fsp from "node:fs/promises";
import zlib from "node:zlib";

/** Read one small text file from a jar (zip) without unpacking it. Returns null if missing or unreadable. */
export async function readJarEntry(file: string, entry: string): Promise<string | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, "r");
    const size = (await fh.stat()).size;
    // The "end of central directory" record sits in the last 64 KB + 22 bytes.
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
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize > 32 * 1024 * 1024) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    for (let p = 0; p + 46 <= cdSize && cd.readUInt32LE(p) === 0x02014b50; ) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (name === entry) {
        if (compSize > 4 * 1024 * 1024) return null;
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, localOffset);
        const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = Buffer.alloc(compSize);
        await fh.read(data, 0, compSize, dataStart);
        const raw = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 }) : null;
        return raw ? raw.toString("utf8") : null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
