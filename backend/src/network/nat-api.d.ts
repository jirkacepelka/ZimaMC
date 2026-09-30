declare module "nat-api" {
  type Cb = (err?: Error | null) => void;
  export default class NatAPI {
    constructor(opts?: { ttl?: number; description?: string; autoUpdate?: boolean; enablePMP?: boolean });
    map(opts: { publicPort: number; privatePort: number; protocol?: "TCP" | "UDP"; description?: string }, cb: Cb): void;
    unmap(opts: { publicPort: number; privatePort: number; protocol?: "TCP" | "UDP" }, cb: Cb): void;
    externalIp(cb: (err: Error | null, ip?: string) => void): void;
    destroy(cb?: Cb): void;
  }
}
