import { fetchJson } from "../http.js";
import { HttpError } from "../store.js";

const API = "https://api.cloudflare.com/client/v4";

/**
 * Link to Cloudflare's "Create API token" page with the two permissions
 * ZimaMC needs already filled in. The user only clicks Continue and Create.
 */
export function tokenTemplateUrl() {
  const perms = JSON.stringify([
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
  ]);
  const p = new URLSearchParams({ permissionGroupKeys: perms, name: "ZimaMC", accountId: "*", zoneId: "all" });
  return `https://dash.cloudflare.com/profile/api-tokens?${p}`;
}

interface CfResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let r: CfResponse<T>;
  try {
    r = await fetchJson<CfResponse<T>>(
      `${API}${path}`,
      { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
      "cloudflare_error",
    );
  } catch (e) {
    const body = (e as { body?: CfResponse<T> }).body;
    const msg = body?.errors?.map((x) => x.message).join("; ");
    if (body?.errors?.some((x) => x.code === 1000 || x.code === 9109 || x.code === 6003)) {
      throw new HttpError(400, "cloudflare_bad_token");
    }
    throw new HttpError(502, "cloudflare_error", { message: msg ?? "" });
  }
  if (!r.success) throw new HttpError(502, "cloudflare_error", { message: r.errors.map((x) => x.message).join("; ") });
  return r.result;
}

export async function verifyToken(token: string) {
  if (!token || !/^[\w-]{20,}$/.test(token.trim())) throw new HttpError(400, "cloudflare_bad_token");
  const r = await cf<{ status: string }>(token.trim(), "/user/tokens/verify");
  if (r.status !== "active") throw new HttpError(400, "cloudflare_bad_token");
}

export async function listZones(token: string) {
  const zones = await cf<{ id: string; name: string; status: string }[]>(token, "/zones?per_page=50&status=active");
  return zones.map((z) => ({ id: z.id, name: z.name }));
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
}

export function fqdn(name: string, zoneName: string) {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (!n || n === "@") return zoneName;
  return n.endsWith(`.${zoneName}`) || n === zoneName ? n : `${n}.${zoneName}`;
}

export function isValidSubdomain(name: string) {
  return name === "" || name === "@" || /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(name);
}

/** Records ZimaMC writes for a server reachable at host:port. */
export function buildRecords(host: string, ip: string, port: number) {
  const a = { type: "A", name: host, content: ip, ttl: 60, proxied: false, comment: "Managed by ZimaMC" };
  // An SRV record lets players type just the domain even when the port isn't 25565.
  const srv =
    port === 25565
      ? null
      : {
          type: "SRV",
          name: `_minecraft._tcp.${host}`,
          ttl: 60,
          comment: "Managed by ZimaMC",
          data: { priority: 0, weight: 5, port, target: host },
        };
  return { a, srv };
}

async function upsert(token: string, zoneId: string, rec: { type: string; name: string } & Record<string, unknown>, knownId?: string) {
  let id = knownId;
  if (!id) {
    const q = new URLSearchParams({ type: rec.type, name: rec.name });
    const existing = await cf<DnsRecord[]>(token, `/zones/${zoneId}/dns_records?${q}`);
    id = existing[0]?.id;
  }
  if (id) {
    try {
      return await cf<DnsRecord>(token, `/zones/${zoneId}/dns_records/${id}`, { method: "PUT", body: JSON.stringify(rec) });
    } catch (e) {
      if (!knownId) throw e;
      // The record was deleted in Cloudflare; create it again.
    }
  }
  return cf<DnsRecord>(token, `/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(rec) });
}

export async function applyDomain(
  token: string,
  zoneId: string,
  host: string,
  ip: string,
  port: number,
  known: { aRecordId?: string; srvRecordId?: string } = {},
) {
  const { a, srv } = buildRecords(host, ip, port);
  const aRec = await upsert(token, zoneId, a, known.aRecordId);
  let srvId: string | undefined;
  if (srv) srvId = (await upsert(token, zoneId, srv, known.srvRecordId)).id;
  else if (known.srvRecordId) await deleteRecord(token, zoneId, known.srvRecordId);
  return { aRecordId: aRec.id, srvRecordId: srvId };
}

export async function deleteRecord(token: string, zoneId: string, id: string) {
  try {
    await cf(token, `/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" });
  } catch {
    /* already gone */
  }
}
