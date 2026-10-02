import net from "node:net";

const AUTH = 3;
const COMMAND = 2;
/**
 * Any other type makes Minecraft answer "Unknown request", which marks the end of a long reply.
 * It is sent only after the first part of the reply arrived: Minecraft closes the connection
 * when one read holds more than one packet.
 */
const SENTINEL = 100;

function packet(id: number, type: number, body: string) {
  const b = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

interface Waiter {
  id: number;
  sentinel: number;
  sentinelSent: boolean;
  parts: string[];
  resolve: (s: string) => void;
  reject: (e: Error) => void;
}

/**
 * Minimal RCON client for a Minecraft server. One connection is kept open and
 * commands run one after another; a broken connection is reopened on the next command.
 */
export class RconClient {
  private sock?: net.Socket;
  private connecting?: Promise<void>;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter?: Waiter;
  private authWaiter?: { id: number; resolve: () => void; reject: (e: Error) => void };

  constructor(
    private port: number,
    private password: string,
    private host = "127.0.0.1",
  ) {}

  private connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const fail = (e: Error) => {
        this.close(e);
        reject(e);
      };
      sock.setNoDelay(true);
      sock.once("error", fail);
      sock.on("data", (d) => this.onData(d));
      sock.on("close", () => this.close(new Error("RCON connection closed")));
      sock.once("connect", () => {
        this.sock = sock;
        const id = this.nextId++;
        this.authWaiter = {
          id,
          resolve: () => {
            sock.off("error", fail);
            sock.setTimeout(0);
            sock.on("error", (e) => this.close(e));
            resolve();
          },
          reject: fail,
        };
        sock.write(packet(id, AUTH, this.password));
      });
      sock.setTimeout(10_000, () => fail(new Error("RCON timeout")));
    }).finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.toString("utf8", 12, 4 + len - 2);
      this.buf = this.buf.subarray(4 + len);
      this.onPacket(id, type, body);
    }
  }

  private onPacket(id: number, type: number, body: string) {
    const a = this.authWaiter;
    if (a && type === COMMAND) {
      this.authWaiter = undefined;
      if (id === -1) a.reject(new Error("RCON password rejected"));
      else a.resolve();
      return;
    }
    const w = this.waiter;
    if (!w) return;
    if (id === w.id) {
      w.parts.push(body);
      if (!w.sentinelSent) {
        w.sentinelSent = true;
        this.sock?.write(packet(w.sentinel, SENTINEL, ""));
      }
    } else if (id === w.sentinel) {
      this.waiter = undefined;
      w.resolve(w.parts.join(""));
    }
  }

  private close(e: Error) {
    const sock = this.sock;
    this.sock = undefined;
    sock?.destroy();
    this.buf = Buffer.alloc(0);
    this.authWaiter?.reject(e);
    this.authWaiter = undefined;
    this.waiter?.reject(e);
    this.waiter = undefined;
  }

  /** Run a console command and return its reply. */
  command(cmd: string): Promise<string> {
    const run = async () => {
      await this.connect();
      const sock = this.sock!;
      return new Promise<string>((resolve, reject) => {
        const id = this.nextId++;
        const sentinel = this.nextId++;
        const timer = setTimeout(() => {
          if (this.waiter?.id !== id) return;
          // No end marker (some servers ignore unknown requests): return what arrived.
          const w = this.waiter;
          this.waiter = undefined;
          w.resolve(w.parts.join(""));
        }, 15_000);
        this.waiter = {
          id,
          sentinel,
          sentinelSent: false,
          parts: [],
          resolve: (s) => (clearTimeout(timer), resolve(s)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        };
        sock.write(packet(id, COMMAND, cmd));
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  end() {
    this.close(new Error("RCON closed"));
  }
}
