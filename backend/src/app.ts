import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { Auth } from "./auth.js";
import { Backups } from "./backups.js";
import { VERSION } from "./config.js";
import { DockerManager } from "./docker.js";
import * as files from "./files.js";
import * as modrinth from "./modrinth.js";
import { SERVER_TYPES, contentKind } from "./minecraft.js";
import { isValidSubdomain, listZones, tokenTemplateUrl, verifyToken } from "./network/cloudflare.js";
import { checkReachable, isCgnat, lanIp, publicIp } from "./network/ip.js";
import { Playit } from "./network/playit.js";
import { isMapped, openPort } from "./network/upnp.js";
import { Players, type PlayerList } from "./players.js";
import { defaultLimits, hostInfo } from "./resources.js";
import { Servers } from "./servers.js";
import { HttpError, Store, type ServerType } from "./store.js";
import { listVersions } from "./versions.js";

type IdParams = { Params: { id: string } };

export interface AppDeps {
  store?: Store;
  docker?: DockerManager;
  staticDir?: string;
}

export async function buildApp(deps: AppDeps = {}) {
  const store = deps.store ?? new Store();
  const docker = deps.docker ?? new DockerManager();
  const auth = new Auth(store);
  const players = new Players(docker);
  const playit = new Playit(store, docker);
  const servers = new Servers(store, docker, players, playit);
  const backups = new Backups(store, docker);

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" }, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, params: err.params ?? {} });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === "ENOENT") return reply.status(404).send({ error: "not_found", params: {} });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "bad_request", params: { message: e.message } });
    if (/connect ENOENT .*docker\.sock|ECONNREFUSED.*docker/i.test(e.message)) {
      return reply.status(503).send({ error: "docker_unavailable", params: {} });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal", params: { message: e.message } });
  });

  // ---- Auth ----

  const PUBLIC = new Set(["/api/status", "/api/setup", "/api/login"]);
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    const url = req.url.split("?")[0];
    if (PUBLIC.has(url)) return;
    if (!auth.isLoggedIn(req)) throw new HttpError(401, "not_logged_in");
  });

  app.get("/api/status", async (req) => ({
    version: VERSION,
    setUp: auth.isSetUp,
    loggedIn: auth.isLoggedIn(req),
    language: store.settings.language,
  }));

  app.post<{ Body: { password: string; language?: string; limits?: { memoryMB: number; cpus: number } } }>(
    "/api/setup",
    async (req, reply) => {
      if (auth.isSetUp) throw new HttpError(409, "already_set_up");
      auth.setPassword(req.body?.password);
      if (req.body.language) store.settings.language = String(req.body.language).slice(0, 10);
      store.settings.limits = req.body.limits ?? defaultLimits(hostInfo(await docker.info().catch(() => undefined)));
      store.save();
      auth.startSession(reply);
      return { ok: true };
    },
  );

  app.post<{ Body: { password: string } }>("/api/login", async (req, reply) => {
    auth.checkRateLimit(req.ip);
    if (!auth.verify(req.body?.password)) {
      auth.recordFailure(req.ip);
      throw new HttpError(401, "wrong_password");
    }
    auth.startSession(reply);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    auth.endSession(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>("/api/password", async (req, reply) => {
    if (!auth.verify(req.body?.current)) throw new HttpError(401, "wrong_password");
    auth.setPassword(req.body.next);
    auth.startSession(reply);
    return { ok: true };
  });

  // ---- System & settings ----

  app.get("/api/system", async () => {
    const info = await docker.info().catch(() => undefined);
    const host = hostInfo(info);
    const { auth: _a, cloudflare, playit: pl, ...settings } = store.settings;
    return {
      version: VERSION,
      docker: Boolean(info),
      host,
      suggestedLimits: defaultLimits(host),
      settings: { ...settings, cloudflareConnected: Boolean(cloudflare), playitConnected: Boolean(pl) },
      usage: await servers.usage(),
    };
  });

  app.put<{ Body: { language?: string; showAdvanced?: boolean; limits?: { memoryMB: number; cpus: number }; network?: { lanIp?: string; publicIp?: string; upnp?: boolean } } }>(
    "/api/settings",
    async (req) => {
      const b = req.body ?? {};
      const s = store.settings;
      if (b.language) s.language = String(b.language).slice(0, 10);
      if (b.showAdvanced !== undefined) s.showAdvanced = Boolean(b.showAdvanced);
      if (b.limits) {
        const memoryMB = Math.max(0, Math.round(Number(b.limits.memoryMB)));
        const cpus = Math.max(0, Number(b.limits.cpus));
        if (!Number.isFinite(memoryMB) || !Number.isFinite(cpus)) throw new HttpError(400, "bad_request");
        s.limits = { memoryMB, cpus };
        await servers.balanceCpu();
      }
      if (b.network) {
        const ipOk = (v?: string) => !v || /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
        if (!ipOk(b.network.lanIp) || !ipOk(b.network.publicIp)) throw new HttpError(400, "invalid_ip");
        s.network = { ...s.network, ...b.network };
      }
      store.save();
      return { ok: true };
    },
  );

  app.get<{ Params: { type: string } }>("/api/versions/:type", async (req) => {
    const type = req.params.type.toUpperCase() as ServerType;
    if (!SERVER_TYPES.includes(type)) throw new HttpError(400, "invalid_type");
    try {
      return { versions: await listVersions(type) };
    } catch {
      throw new HttpError(502, "versions_unavailable");
    }
  });

  // ---- Servers ----

  app.get("/api/servers", async () => ({ servers: store.servers.map((s) => servers.view(s)) }));

  app.post<{ Body: Parameters<Servers["create"]>[0] }>("/api/servers", async (req) => {
    const { server, startError } = await servers.create(req.body ?? ({} as never));
    return {
      server: servers.view(server),
      startError: startError ? { error: startError.code, params: startError.params ?? {} } : undefined,
    };
  });

  app.get<IdParams>("/api/servers/:id", async (req) => ({ server: servers.view(servers.get(req.params.id)) }));

  app.patch<IdParams & { Body: Record<string, unknown> }>("/api/servers/:id", async (req) => {
    const r = await servers.update(req.params.id, req.body ?? {});
    return { server: servers.view(r.server), restartNeeded: r.restartNeeded };
  });

  app.delete<IdParams & { Querystring: { deleteFiles?: string } }>("/api/servers/:id", async (req) => {
    await servers.remove(req.params.id, req.query.deleteFiles !== "false");
    return { ok: true };
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post<IdParams>(`/api/servers/:id/${action}`, async (req) => {
      const id = req.params.id;
      if (action === "start") await servers.checkCanStart(id);
      else servers.get(id);
      // Starting can take minutes (image download); answer right away and let the UI poll.
      servers[action](id).catch((e) => app.log.error(e));
      return { ok: true };
    });
  }

  app.post<IdParams>("/api/servers/:id/kill", async (req) => {
    servers.get(req.params.id);
    await docker.kill(req.params.id);
    return { ok: true };
  });

  app.post<IdParams & { Body: { command: string } }>("/api/servers/:id/command", async (req) => {
    servers.get(req.params.id);
    const cmd = String(req.body?.command ?? "").replace(/^\//, "").trim();
    if (!cmd) throw new HttpError(400, "empty_command");
    if (!(await docker.isRunning(req.params.id))) throw new HttpError(409, "server_offline");
    return { output: await docker.rcon(req.params.id, cmd) };
  });

  app.get<IdParams>("/api/servers/:id/console", { websocket: true }, async (socket, req) => {
    const id = (req.params as { id: string }).id;
    if (!store.server(id)) return socket.close(4404, "server_not_found");
    let stream: NodeJS.ReadableStream | undefined;
    const attach = async () => {
      try {
        stream = await docker.logs(id, 300);
        stream.on("data", (c: Buffer) => socket.readyState === 1 && socket.send(c.toString("utf8")));
        stream.on("end", () => setTimeout(() => socket.readyState === 1 && attach(), 2000));
      } catch {
        // Container doesn't exist yet (server never started): try again shortly.
        setTimeout(() => socket.readyState === 1 && attach(), 2000);
      }
    };
    await attach();
    socket.on("close", () => (stream as unknown as { destroy?: () => void })?.destroy?.());
  });

  // ---- Plugins & mods (Modrinth) ----

  app.get<IdParams>("/api/servers/:id/projects", async (req) => {
    const s = servers.get(req.params.id);
    return { installed: s.projects, manual: await modrinth.manualJars(s) };
  });

  app.get<IdParams & { Querystring: { q?: string; offset?: string; category?: string } }>("/api/servers/:id/projects/search", async (req) => {
    const s = servers.get(req.params.id);
    return modrinth.search(s, String(req.query.q ?? "").slice(0, 100), Number(req.query.offset ?? 0) || 0, req.query.category || undefined);
  });

  app.get<IdParams>("/api/servers/:id/projects/categories", async (req) => ({
    categories: await modrinth.categories(servers.get(req.params.id)),
  }));

  app.get<{ Params: { id: string; pid: string } }>("/api/servers/:id/projects/:pid/details", async (req) =>
    modrinth.details(servers.get(req.params.id), req.params.pid),
  );

  const saveInstalled = (id: string, installed: Awaited<ReturnType<typeof modrinth.install>>) =>
    store.updateServer(id, (x) => {
      for (const p of installed) {
        x.projects = x.projects.filter((q) => q.projectId !== p.projectId);
        x.projects.push(p);
      }
    });

  app.post<IdParams & { Body: { projectId: string } }>("/api/servers/:id/projects", async (req) => {
    const s = servers.get(req.params.id);
    const installed = await modrinth.install(s, String(req.body?.projectId ?? ""));
    saveInstalled(s.id, installed);
    return { installed, restartNeeded: await docker.isRunning(s.id) };
  });

  app.delete<{ Params: { id: string; pid: string } }>("/api/servers/:id/projects/:pid", async (req) => {
    const s = servers.get(req.params.id);
    await modrinth.uninstall(s, req.params.pid);
    store.updateServer(s.id, (x) => (x.projects = x.projects.filter((p) => p.projectId !== req.params.pid)));
    return { ok: true, restartNeeded: await docker.isRunning(s.id) };
  });

  app.delete<IdParams & { Querystring: { file: string } }>("/api/servers/:id/projects-manual", async (req) => {
    const s = servers.get(req.params.id);
    const kind = contentKind(s.type);
    if (!kind) throw new HttpError(400, "no_plugins_for_vanilla");
    await files.remove(path.join(files.serverDir(s.id), kind.dir), path.basename(String(req.query.file)));
    return { ok: true };
  });

  app.get<IdParams>("/api/servers/:id/projects/updates", async (req) => ({
    updates: await modrinth.checkUpdates(servers.get(req.params.id)),
  }));

  app.post<IdParams>("/api/servers/:id/projects/update-all", async (req) => {
    const s = servers.get(req.params.id);
    const updates = await modrinth.checkUpdates(s);
    for (const u of updates) saveInstalled(s.id, await modrinth.install(servers.get(s.id), u.projectId));
    return { updated: updates.length, restartNeeded: updates.length > 0 && (await docker.isRunning(s.id)) };
  });

  // ---- Players ----

  app.get<IdParams>("/api/servers/:id/players", async (req) => {
    const s = servers.get(req.params.id);
    const [online, lists] = await Promise.all([players.online(s), players.lists(s)]);
    return { online, ...lists, whitelistEnabled: s.properties.whitelist };
  });

  app.post<IdParams & { Body: { list: PlayerList; name: string; add: boolean } }>("/api/servers/:id/players", async (req) => {
    const s = servers.get(req.params.id);
    const { list, name, add } = req.body ?? ({} as never);
    if (!["whitelist", "ops", "banned"].includes(list)) throw new HttpError(400, "bad_request");
    return { output: await players.change(s, list, name, Boolean(add)) };
  });

  app.post<IdParams & { Body: { name: string } }>("/api/servers/:id/players/kick", async (req) => {
    return { output: await players.kick(servers.get(req.params.id), req.body?.name) };
  });

  // ---- Files ----

  const root = (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    servers.get(id);
    return files.serverDir(id);
  };

  app.get<IdParams & { Querystring: { path?: string } }>("/api/servers/:id/files", async (req) => ({
    entries: await files.listDir(root(req), req.query.path ?? ""),
  }));

  app.get<IdParams & { Querystring: { path: string } }>("/api/servers/:id/files/content", async (req) => ({
    content: await files.readText(root(req), req.query.path),
  }));

  app.put<IdParams & { Body: { path: string; content: string } }>("/api/servers/:id/files/content", async (req) => {
    await files.writeText(root(req), req.body.path, String(req.body.content ?? ""));
    return { ok: true };
  });

  app.delete<IdParams & { Querystring: { path: string } }>("/api/servers/:id/files", async (req) => {
    await files.remove(root(req), req.query.path);
    return { ok: true };
  });

  app.post<IdParams & { Body: { path: string } }>("/api/servers/:id/files/mkdir", async (req) => {
    await files.mkdir(root(req), req.body.path);
    return { ok: true };
  });

  app.post<IdParams & { Body: { from: string; to: string } }>("/api/servers/:id/files/rename", async (req) => {
    await files.rename(root(req), req.body.from, req.body.to);
    return { ok: true };
  });

  app.post<IdParams & { Querystring: { path?: string } }>("/api/servers/:id/files/upload", async (req) => {
    const dir = files.safeJoin(root(req), req.query.path ?? "");
    let count = 0;
    for await (const part of req.files()) {
      const dest = files.safeJoin(dir, path.basename(part.filename));
      await pipeline(part.file, fs.createWriteStream(dest));
      await files.chownForServer(dest);
      count++;
    }
    return { uploaded: count };
  });

  app.get<IdParams & { Querystring: { path: string } }>("/api/servers/:id/files/download", async (req, reply) => {
    const p = files.safeJoin(root(req), req.query.path);
    if (fs.statSync(p).isDirectory()) throw new HttpError(400, "is_directory");
    reply.header("Content-Disposition", `attachment; filename="${path.basename(p).replace(/"/g, "")}"`);
    return reply.type("application/octet-stream").send(fs.createReadStream(p));
  });

  // ---- Backups ----

  app.get<IdParams>("/api/servers/:id/backups", async (req) => {
    const s = servers.get(req.params.id);
    return { backups: await backups.list(s.id), running: backups.isRunning(s.id), schedule: s.backup };
  });

  app.post<IdParams>("/api/servers/:id/backups", async (req) => ({ file: await backups.create(servers.get(req.params.id)) }));

  app.post<IdParams & { Body: { file: string } }>("/api/servers/:id/backups/restore", async (req) => {
    await backups.restore(servers.get(req.params.id), req.body?.file);
    return { ok: true };
  });

  app.delete<IdParams & { Querystring: { file: string } }>("/api/servers/:id/backups", async (req) => {
    servers.get(req.params.id);
    await backups.remove(req.params.id, req.query.file);
    return { ok: true };
  });

  app.get<IdParams & { Querystring: { file: string } }>("/api/servers/:id/backups/download", async (req, reply) => {
    servers.get(req.params.id);
    const p = backups.pathOf(req.params.id, req.query.file);
    reply.header("Content-Disposition", `attachment; filename="${path.basename(p)}"`);
    return reply.type("application/gzip").send(fs.createReadStream(p));
  });

  // ---- Network ----

  app.get("/api/network", async () => {
    const pub = store.settings.network.publicIp || (await publicIp().catch(() => undefined));
    return {
      lanIp: store.settings.network.lanIp || lanIp(),
      publicIp: pub,
      cgnat: pub ? isCgnat(pub) : false,
      upnp: store.settings.network.upnp,
      cloudflare: { connected: Boolean(store.settings.cloudflare), tokenUrl: tokenTemplateUrl() },
      playit: { connected: playit.connected, agentRunning: playit.connected ? await playit.agentRunning() : false },
    };
  });

  app.post<IdParams>("/api/servers/:id/network/open-port", async (req) => {
    const s = servers.get(req.params.id);
    try {
      await openPort(s.port);
    } catch (e) {
      throw new HttpError(502, (e as Error).message === "upnp_timeout" ? "upnp_timeout" : "upnp_failed");
    }
    return { ok: true };
  });

  app.post<IdParams>("/api/servers/:id/network/check", async (req) => {
    const s = servers.get(req.params.id);
    const a = servers.address(s);
    const target = a.domain ?? a.public;
    if (!target) throw new HttpError(502, "public_ip_unknown");
    return { target, portMapped: isMapped(s.port), ...(await checkReachable(target)) };
  });

  app.post<{ Body: { token: string } }>("/api/network/cloudflare", async (req) => {
    const token = String(req.body?.token ?? "").trim();
    await verifyToken(token);
    const zones = await listZones(token);
    if (!zones.length) throw new HttpError(400, "cloudflare_no_zones");
    store.settings.cloudflare = { token };
    store.save();
    return { zones };
  });

  app.get("/api/network/cloudflare/zones", async () => {
    const t = store.settings.cloudflare?.token;
    if (!t) throw new HttpError(400, "cloudflare_not_connected");
    return { zones: await listZones(t) };
  });

  app.delete("/api/network/cloudflare", async () => {
    for (const s of store.servers) if (s.domain) await servers.removeDomain(s).catch(() => {});
    delete store.settings.cloudflare;
    store.save();
    return { ok: true };
  });

  app.put<IdParams & { Body: { zoneId: string; zoneName: string; name: string } }>("/api/servers/:id/domain", async (req) => {
    const { zoneId, zoneName, name } = req.body ?? ({} as never);
    if (!zoneId || !zoneName || !isValidSubdomain(String(name ?? ""))) throw new HttpError(400, "invalid_domain");
    return { domain: await servers.setDomain(req.params.id, zoneId, zoneName, String(name)) };
  });

  app.delete<IdParams>("/api/servers/:id/domain", async (req) => {
    await servers.removeDomain(servers.get(req.params.id));
    return { ok: true };
  });

  app.post("/api/network/playit/claim", async () => playit.startClaim());
  app.get("/api/network/playit/claim", async () => playit.pollClaim());
  app.delete("/api/network/playit", async () => {
    for (const s of store.servers) if (s.tunnel) await servers.disableTunnel(s.id).catch(() => {});
    await playit.disconnect();
    return { ok: true };
  });

  app.post<IdParams>("/api/servers/:id/tunnel", async (req) => ({ tunnel: await servers.enableTunnel(req.params.id) }));
  app.delete<IdParams>("/api/servers/:id/tunnel", async (req) => {
    await servers.disableTunnel(req.params.id);
    return { ok: true };
  });

  // ---- Frontend ----

  const staticDir =
    deps.staticDir ?? process.env.STATIC_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/dist");
  if (fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found", params: {} });
      return reply.sendFile("index.html");
    });
  }

  return { app, store, docker, servers, backups, playit };
}
