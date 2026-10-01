import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { ping } from "../src/ping.js";

function varInt(n: number) {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** A tiny fake Minecraft server that answers the status request. */
const status = { version: { name: "1.21.8", protocol: 772 }, players: { max: 20, online: 2, sample: [{ name: "Steve", id: "x" }, { name: "Alex", id: "y" }] } };
let handshakeSeen = false;
const server = net.createServer((sock) => {
  sock.once("data", (d) => {
    handshakeSeen = d[1] === 0x00; // packet id of the handshake
    const json = Buffer.from(JSON.stringify(status));
    const body = Buffer.concat([varInt(0), varInt(json.length), json]);
    // Send in two pieces to check that partial packets are handled.
    const full = Buffer.concat([varInt(body.length), body]);
    sock.write(full.subarray(0, 5));
    setTimeout(() => sock.write(full.subarray(5)), 20);
  });
});
const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));
afterAll(() => server.close());

describe("server list ping", () => {
  it("reads players online, max and names", async () => {
    expect(await ping("127.0.0.1", port)).toEqual({ online: 2, max: 20, names: ["Steve", "Alex"] });
    expect(handshakeSeen).toBe(true);
  });

  it("fails cleanly when nothing listens", async () => {
    await expect(ping("127.0.0.1", 1, 500)).rejects.toBeTruthy();
  });
});
