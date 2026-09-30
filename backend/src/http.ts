import { VERSION } from "./config.js";
import { HttpError } from "./store.js";

const UA = `ZimaMC/${VERSION} (github.com/jirkacepelka/ZimaMC)`;

/** fetch() JSON with a timeout, a proper User-Agent and a translatable error on failure. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, errorCode = "network_error"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(502, errorCode, { url: new URL(url).host });
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const e = new HttpError(502, errorCode, { url: new URL(url).host, status: res.status });
    (e as HttpError & { body?: unknown }).body = body;
    throw e;
  }
  return body as T;
}

export async function download(url: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new HttpError(502, "download_failed", { url: new URL(url).host });
  }
  if (!res.ok || !res.body) throw new HttpError(502, "download_failed", { url: new URL(url).host, status: res.status });
  return res;
}
