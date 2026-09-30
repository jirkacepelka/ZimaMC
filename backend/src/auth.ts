import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError, type Store } from "./store.js";

const COOKIE = "zimamc_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export class Auth {
  private sessions = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private store: Store) {}

  get isSetUp() {
    return Boolean(this.store.settings.auth);
  }

  setPassword(password: string) {
    if (typeof password !== "string" || password.length < 6) throw new HttpError(400, "password_too_short");
    const salt = crypto.randomBytes(16).toString("hex");
    this.store.settings.auth = { salt, hash: hashPassword(password, salt) };
    this.store.save();
    this.sessions.clear();
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
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  endSession(req: FastifyRequest, reply: FastifyReply) {
    const token = req.cookies[COOKIE];
    if (token) this.sessions.delete(token);
    reply.clearCookie(COOKIE, { path: "/" });
  }

  isLoggedIn(req: FastifyRequest) {
    const token = req.cookies[COOKIE];
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp || exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
}
