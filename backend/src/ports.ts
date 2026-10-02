import dgram from "node:dgram";
import net from "node:net";

/** Error codes that mean "this machine has no IPv6", not "the port is taken". */
const NO_IPV6 = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"]);

function tryBind(port: number, protocol: "tcp" | "udp", host: string) {
  return new Promise<"free" | "taken" | "unsupported">((resolve) => {
    const onError = (e: NodeJS.ErrnoException) => resolve(NO_IPV6.has(e.code ?? "") ? "unsupported" : "taken");
    if (protocol === "udp") {
      const sock = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
      sock.once("error", onError);
      sock.bind(port, host, () => sock.close(() => resolve("free")));
      return;
    }
    const srv = net.createServer();
    srv.once("error", onError);
    srv.listen({ port, host, ipv6Only: host === "::" ? false : undefined }, () => srv.close(() => resolve("free")));
  });
}

/**
 * Whether a port can be used by a Minecraft server. Java listens on every
 * address including IPv6, so a program holding the port only on IPv6 (Docker
 * Desktop does that) counts as taken, which a check on 0.0.0.0 alone misses.
 */
export async function portFree(port: number, protocol: "tcp" | "udp" = "tcp") {
  if ((await tryBind(port, protocol, "0.0.0.0")) !== "free") return false;
  return (await tryBind(port, protocol, "::")) !== "taken";
}
