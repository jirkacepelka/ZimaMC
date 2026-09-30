import crypto from "node:crypto";
import type { DockerManager } from "../docker.js";
import { CONTAINER_PREFIX, PLAYIT_IMAGE, VERSION } from "../config.js";
import { fetchJson } from "../http.js";
import { HttpError, type Store } from "../store.js";

const API = "https://api.playit.gg";
const AGENT_CONTAINER = `${CONTAINER_PREFIX}playit`;

type ApiResult<T> = { status: "success"; data: T } | { status: "fail"; data: string } | { status: "error"; data: unknown };

async function call<T>(path: string, body: unknown, secret?: string): Promise<T> {
  const r = await fetchJson<ApiResult<T>>(
    `${API}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Agent-Key ${secret}` } : {}) },
      body: JSON.stringify(body),
    },
    "playit_error",
  );
  if (r.status !== "success") throw new HttpError(502, "playit_error", { message: JSON.stringify(r.data) });
  return r.data;
}

export type ClaimState = "WaitingForUserVisit" | "WaitingForUser" | "UserAccepted" | "UserRejected";

/**
 * playit.gg tunnel for networks where ports can't be opened (CGNAT).
 * The user approves this machine once on playit.gg; after that ZimaMC
 * creates and removes tunnels itself.
 */
export class Playit {
  private claimCode?: string;

  constructor(
    private store: Store,
    private docker: DockerManager,
  ) {}

  get connected() {
    return Boolean(this.store.settings.playit?.secretKey);
  }

  startClaim() {
    this.claimCode = crypto.randomBytes(5).toString("hex");
    return { url: `https://playit.gg/claim/${this.claimCode}` };
  }

  /** Poll while the user approves the agent on playit.gg. */
  async pollClaim(): Promise<{ state: ClaimState | "Connected" }> {
    if (this.connected) return { state: "Connected" };
    if (!this.claimCode) throw new HttpError(400, "playit_no_claim");
    const state = await call<ClaimState>("/claim/setup", {
      code: this.claimCode,
      agent_type: "self-managed",
      version: `ZimaMC ${VERSION}`,
    });
    if (state !== "UserAccepted") return { state };
    const { secret_key } = await call<{ secret_key: string }>("/claim/exchange", { code: this.claimCode });
    this.store.settings.playit = { secretKey: secret_key };
    this.store.save();
    this.claimCode = undefined;
    await this.startAgent();
    return { state: "Connected" };
  }

  private get secret() {
    const k = this.store.settings.playit?.secretKey;
    if (!k) throw new HttpError(400, "playit_not_connected");
    return k;
  }

  async agentId() {
    const s = this.store.settings.playit;
    if (s?.agentId) return s.agentId;
    const data = await call<{ agent_id: string }>("/agents/rundata", {}, this.secret);
    this.store.settings.playit = { ...s!, agentId: data.agent_id };
    this.store.save();
    return data.agent_id;
  }

  /** Run the playit agent next to the Minecraft servers (host network, so it reaches their ports). */
  async startAgent() {
    const docker = this.docker.docker;
    if (!(await this.docker.hasImage(PLAYIT_IMAGE))) await this.docker.pull(PLAYIT_IMAGE);
    try {
      await docker.getContainer(AGENT_CONTAINER).remove({ force: true });
    } catch {
      /* not there */
    }
    const c = await docker.createContainer({
      name: AGENT_CONTAINER,
      Image: PLAYIT_IMAGE,
      Env: [`SECRET_KEY=${this.secret}`],
      Labels: { "zimamc.role": "playit" },
      HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" } },
    });
    await c.start();
  }

  async agentRunning() {
    try {
      return (await this.docker.docker.getContainer(AGENT_CONTAINER).inspect()).State.Running;
    } catch {
      return false;
    }
  }

  async createTunnel(name: string, localPort: number) {
    const agent_id = await this.agentId();
    if (!(await this.agentRunning())) await this.startAgent();
    return call<{ id: string }>(
      "/tunnels/create",
      {
        name: name.slice(0, 60),
        tunnel_type: "minecraft-java",
        port_type: "tcp",
        port_count: 1,
        origin: { type: "agent", data: { agent_id, local_ip: "127.0.0.1", local_port: localPort } },
        enabled: true,
        alloc: null,
        firewall_id: null,
        proxy_protocol: null,
      },
      this.secret,
    );
  }

  /** Public address of a tunnel once playit has assigned one. */
  async tunnelAddress(tunnelId: string): Promise<string | undefined> {
    const r = await call<{
      tunnels: { id: string; alloc: { status: string; data?: { assigned_domain: string; assigned_srv?: string | null; port_start: number } } }[];
    }>("/tunnels/list", { tunnel_id: tunnelId, agent_id: null }, this.secret);
    const t = r.tunnels.find((x) => x.id === tunnelId);
    if (t?.alloc.status !== "allocated" || !t.alloc.data) return undefined;
    const d = t.alloc.data;
    // Minecraft tunnels usually get an SRV name that needs no port; otherwise show host:port.
    return d.assigned_srv ?? `${d.assigned_domain}:${d.port_start}`;
  }

  async deleteTunnel(tunnelId: string) {
    await call("/tunnels/delete", { tunnel_id: tunnelId }, this.secret).catch(() => {});
  }

  async disconnect() {
    try {
      await this.docker.docker.getContainer(AGENT_CONTAINER).remove({ force: true });
    } catch {
      /* not running */
    }
    delete this.store.settings.playit;
    this.store.save();
  }
}
