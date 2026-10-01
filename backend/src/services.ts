/**
 * Plugins and mods that listen on their own port. When one is installed,
 * ZimaMC publishes that port too, so a web map or voice chat just works.
 */
export interface KnownService {
  id: string;
  label: string;
  match: RegExp;
  containerPort: number;
  protocol: "tcp" | "udp";
  /** "web" opens in a browser; "game" is used by players' game clients. */
  kind: "web" | "game";
}

export const KNOWN_SERVICES: KnownService[] = [
  { id: "squaremap", label: "squaremap", match: /squaremap/i, containerPort: 8080, protocol: "tcp", kind: "web" },
  { id: "bluemap", label: "BlueMap", match: /bluemap/i, containerPort: 8100, protocol: "tcp", kind: "web" },
  { id: "dynmap", label: "Dynmap", match: /dynmap/i, containerPort: 8123, protocol: "tcp", kind: "web" },
  { id: "pl3xmap", label: "Pl3xMap", match: /pl3xmap/i, containerPort: 8080, protocol: "tcp", kind: "web" },
  { id: "voicechat", label: "Simple Voice Chat", match: /voice.?chat/i, containerPort: 24454, protocol: "udp", kind: "game" },
  { id: "geyser", label: "Geyser (Bedrock)", match: /geyser/i, containerPort: 19132, protocol: "udp", kind: "game" },
];

/** Which known services are present, judging by jar file names and project titles. */
export function detectServices(names: string[]): KnownService[] {
  const found: KnownService[] = [];
  for (const svc of KNOWN_SERVICES) {
    if (!names.some((n) => svc.match.test(n))) continue;
    // Two maps on the same internal port can't both work; keep the first.
    if (found.some((f) => f.containerPort === svc.containerPort && f.protocol === svc.protocol)) continue;
    found.push(svc);
  }
  return found;
}

export const serviceById = (id?: string) => KNOWN_SERVICES.find((s) => s.id === id);
