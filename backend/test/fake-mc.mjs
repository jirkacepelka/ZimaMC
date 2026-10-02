// A stand-in for a Minecraft server, started by the native runtime tests instead of Java.
// It reads server.properties, prints the usual start-up line, answers RCON and the
// server list ping port, and stops on "stop" typed into its console.
import fs from "node:fs";
import net from "node:net";

const props = Object.fromEntries(
  fs
    .readFileSync("server.properties", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
fs.writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));

function stop(code = 0) {
  console.log("[Server thread/INFO]: Stopping server");
  process.exit(code);
}

function run(cmd) {
  if (cmd === "stop") setTimeout(() => stop(0), 50);
  if (cmd === "crash") setTimeout(() => process.exit(3), 50);
  if (cmd === "list") return `There are 0 of a max of ${props["max-players"]} players online: `;
  if (cmd === "help") return "x".repeat(10_000);
  console.log(`[Server thread/INFO]: ran ${cmd}`);
  return "";
}

function packet(id, type, body) {
  const b = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

net
  .createServer((sock) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString("utf8", 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (type === 3) {
          authed = body === props["rcon.password"];
          sock.write(packet(authed ? id : -1, 2, ""));
        } else if (type === 2 && authed) {
          // Like Minecraft: long replies arrive in pieces of 4096 bytes.
          const out = run(body);
          for (let i = 0; i < Math.max(1, out.length); i += 4096) sock.write(packet(id, 0, out.slice(i, i + 4096)));
        } else sock.write(packet(id, 0, `Unknown request ${type.toString(16)}`));
      }
    });
    sock.on("error", () => {});
  })
  .listen(Number(props["rcon.port"]), "127.0.0.1");

net.createServer((s) => s.end()).listen(Number(props["server-port"]), "0.0.0.0", () => {
  console.log('[Server thread/INFO]: Done (0.123s)! For help, type "help"');
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  for (const line of d.split("\n")) if (line.trim()) run(line.trim());
});
