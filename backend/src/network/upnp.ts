import NatAPI from "nat-api";

let client: NatAPI | undefined;
const mapped = new Set<number>();

function nat() {
  // One long-lived client: it renews its mappings before they expire.
  client ??= new NatAPI({ description: "ZimaMC", ttl: 7200, autoUpdate: true, enablePMP: true });
  return client;
}

/** Ask the router to forward a TCP port to this machine (UPnP / NAT-PMP). */
export function openPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upnp_timeout")), 15_000);
    nat().map({ publicPort: port, privatePort: port, protocol: "TCP", description: `ZimaMC ${port}` }, (err) => {
      clearTimeout(timer);
      if (err) return reject(new Error("upnp_failed"));
      mapped.add(port);
      resolve();
    });
  });
}

export function closePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    if (!mapped.has(port)) return resolve();
    nat().unmap({ publicPort: port, privatePort: port, protocol: "TCP" }, () => {
      mapped.delete(port);
      resolve();
    });
  });
}

export const isMapped = (port: number) => mapped.has(port);
