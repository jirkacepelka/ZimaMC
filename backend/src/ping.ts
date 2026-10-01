import net from "node:net";

/**
 * Minecraft "Server List Ping": the same request the game's server list sends.
 * Unlike RCON it leaves no lines in the server log, so it is safe to poll.
 */

function varInt(n: number) {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function readVarInt(buf: Buffer, offset: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [value, i + 1];
  }
  throw new Error("bad varint");
}

const packet = (...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varInt(body.length), body]);
};
const mcString = (s: string) => Buffer.concat([varInt(Buffer.byteLength(s)), Buffer.from(s)]);

export interface PingResult {
  online: number;
  max: number;
  /** Player names the server shares (usually up to 12; some servers hide them). */
  names: string[];
}

export function ping(host: string, port: number, timeoutMs = 3000): Promise<PingResult> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (err: Error | null, res?: PingResult) => {
      sock.destroy();
      if (err) reject(err);
      else resolve(res!);
    };
    sock.setTimeout(timeoutMs, () => done(new Error("timeout")));
    sock.on("error", (e) => done(e));
    sock.on("connect", () => {
      const port16 = Buffer.alloc(2);
      port16.writeUInt16BE(port);
      // Handshake (protocol -1 = "any"), next state 1 = status; then a status request.
      sock.write(packet(varInt(0), varInt(-1 >>> 0), mcString(host), port16, varInt(1)));
      sock.write(packet(varInt(0)));
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len[1] + len[0]) return;
        let off = len[1];
        const id = readVarInt(buf, off)!;
        off += id[1];
        const strLen = readVarInt(buf, off)!;
        off += strLen[1];
        const json = JSON.parse(buf.subarray(off, off + strLen[0]).toString("utf8"));
        const p = json.players ?? {};
        done(null, {
          online: Number(p.online ?? 0),
          max: Number(p.max ?? 0),
          names: Array.isArray(p.sample) ? p.sample.map((x: { name?: string }) => String(x.name ?? "")).filter(Boolean) : [],
        });
      } catch (e) {
        done(e as Error);
      }
    });
  });
}
