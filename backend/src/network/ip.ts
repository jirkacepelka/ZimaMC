import os from "node:os";
import { fetchJson } from "../http.js";

/** The machine's address in the home network, e.g. 192.168.1.20. */
export function lanIp(): string | undefined {
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Skip Docker bridges and VPN/virtual interfaces.
    if (/^(docker|br-|veth|virbr|tun|tap|zt|tailscale|lo)/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
  }
  const priv = candidates.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return priv ?? candidates[0];
}

let cachedIp: { at: number; ip: string } | undefined;

/** Public IPv4 address of the network, as the internet sees it. */
export async function publicIp(force = false): Promise<string> {
  if (!force && cachedIp && Date.now() - cachedIp.at < 5 * 60_000) return cachedIp.ip;
  const sources = [
    async () => (await fetchJson<{ ip: string }>("https://api.ipify.org?format=json")).ip,
    async () => (await fetchJson<{ ip: string }>("https://api4.my-ip.io/v2/ip.json")).ip,
    async () => (await fetchJson<{ address: string }>("https://ipv4.seeip.org/jsonip")).address,
  ];
  for (const src of sources) {
    try {
      const ip = await src();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        cachedIp = { at: Date.now(), ip };
        return ip;
      }
    } catch {
      /* try the next source */
    }
  }
  throw new Error("public_ip_unknown");
}

/** RFC 6598 shared address space: the ISP uses carrier-grade NAT and port forwarding cannot work. */
export function isCgnat(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Ask a public Minecraft status service whether the server answers from the
 * internet. Testing from inside the home network is unreliable (NAT loopback).
 */
export async function checkReachable(address: string) {
  try {
    const r = await fetchJson<{ online: boolean; players?: { online: number } }>(
      `https://api.mcsrvstat.us/3/${encodeURIComponent(address)}`,
    );
    return { reachable: Boolean(r.online) };
  } catch {
    return { reachable: false, unknown: true };
  }
}
