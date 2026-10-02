import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DATA_DIR } from "./config.js";
import { HttpError, type Store } from "./store.js";

const COOKIE = "zimamc_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

/** Sessions are kept by the hash of their token, so the file alone can't log anyone in. */
const tokenKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export class Auth {
  private sessions = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();

  /** Sessions survive a restart of ZimaMC (a reboot of the PC or NAS), so nobody has to log in again. */
  constructor(
    private store: Store,
    private file = path.join(DATA_DIR, "sessions.json"),
  ) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
      for (const [k, exp] of Object.entries(saved)) if (exp > Date.now()) this.sessions.set(k, exp);
    } catch {
      /* none yet */
    }
  }

  private saveSessions() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[auth]", e);
    }
  }

  get isSetUp() {
    return Boolean(this.store.settings.auth);
  }

  setPassword(password: string) {
    if (typeof password !== "string" || password.length < 6) throw new HttpError(400, "password_too_short");
    const salt = crypto.randomBytes(16).toString("hex");
    this.store.settings.auth = { salt, hash: hashPassword(password, salt) };
    this.store.save();
    this.sessions.clear();
    this.saveSessions();
  }

  /** Forget the password and every session; the next visit asks for a new password. */
  reset() {
    delete this.store.settings.auth;
    this.store.save();
    this.sessions.clear();
    this.saveSessions();
  }

  verify(password: string) {
    const a = this.store.settings.auth;
    if (!a || typeof password !== "string") return false;
    const got = Buffer.from(hashPassword(password, a.salt), "hex");
    return crypto.timingSafeEqual(got, Buffer.from(a.hash, "hex"));
  }

  /** Slow down password guessing: 5 failures per IP lock it out for a minute. */
  checkRateLimit(ip: string) {
    const f = this.failures.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) throw new HttpError(429, "too_many_attempts");
  }

  recordFailure(ip: string) {
    const f = this.failures.get(ip) ?? { count: 0, until: 0 };
    f.count = f.until < Date.now() && f.count >= 5 ? 1 : f.count + 1;
    f.until = Date.now() + 60_000;
    this.failures.set(ip, f);
  }

  startSession(reply: FastifyReply) {
    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(tokenKey(token), Date.now() + SESSION_TTL_MS);
    this.saveSessions();
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  endSession(req: FastifyRequest, reply: FastifyReply) {
    const token = req.cookies[COOKIE];
    if (token && this.sessions.delete(tokenKey(token))) this.saveSessions();
    reply.clearCookie(COOKIE, { path: "/" });
  }

  isLoggedIn(req: FastifyRequest) {
    const token = req.cookies[COOKIE];
    if (!token) return false;
    const key = tokenKey(token);
    const exp = this.sessions.get(key);
    if (!exp || exp < Date.now()) {
      if (exp && this.sessions.delete(key)) this.saveSessions();
      return false;
    }
    return true;
  }
}
