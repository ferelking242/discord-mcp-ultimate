import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Dashboard authentication.
 *
 * A self-hosted dashboard has one operator, not a user table, so the model is a
 * password plus a signed session cookie rather than an account system. That keeps
 * the dashboard a single process with no dependency and no database.
 *
 * What is done carefully, and why:
 *
 * - **scrypt for the password.** A plain SHA-256 of a password is brute-forceable
 *   on a GPU in seconds. scrypt is deliberately slow and memory-hard. A hash in
 *   `DASHBOARD_PASSWORD_HASH` is preferred over a plaintext `DASHBOARD_PASSWORD`,
 *   so a leaked environment file does not hand over the password itself.
 * - **HMAC-signed session token.** The cookie carries an expiry and a nonce, signed
 *   with a server-side secret. The signature is what stops a client from editing
 *   its own expiry; without it the cookie would be a bearer token anyone could mint.
 * - **`timingSafeEqual` everywhere a secret is compared.** A plain `===` leaks how
 *   many leading characters matched, which is enough to recover a token byte by byte.
 * - **Login throttling.** Password guessing over HTTP is cheap, so attempts are
 *   rate-limited per client address, and a correct guess does not clear the window.
 */

export interface AuthOptions {
  /** Plaintext password, hashed in memory at startup. */
  password?: string;
  /** `scrypt$N$r$p$salt$hash`, base64. Takes precedence over `password`. */
  passwordHash?: string;
  /** Signing key for session cookies. Generated at startup when absent. */
  sessionSecret?: string;
  /** Session lifetime in milliseconds. */
  sessionTtlMs?: number;
  /** Set the cookie's `Secure` flag. Requires TLS, so it is opt-in. */
  secureCookies?: boolean;
  cookieName?: string;
  maxLoginAttempts?: number;
  loginWindowMs?: number;
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** `scrypt$N$r$p$<salt-b64>$<hash-b64>`, the format `hashPassword` produces. */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Verifies a password against a stored hash. Returns false on any malformed input. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Guard against a hostile hash line asking for gigabytes of memory.
  if (N > 1 << 20 || r > 32 || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Constant-time compare that tolerates different lengths without throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface Session {
  /** Opaque token: `<payload>.<signature>`. */
  token: string;
  expiresAt: number;
  /** The value the client must echo in `X-CSRF-Token` on state-changing requests. */
  csrf: string;
}

export class Authenticator {
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly cookieName: string;
  private readonly secure: boolean;
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly opts: AuthOptions) {
    if (!opts.password && !opts.passwordHash) {
      throw new Error("the dashboard needs DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_HASH");
    }
    // A random per-process secret invalidates every session on restart, which is
    // the right default: an operator who did not set one did not ask for long-lived
    // sessions, and a hardcoded fallback would be a forged-cookie vulnerability.
    this.secret = opts.sessionSecret ?? randomBytes(32).toString("base64url");
    this.ttlMs = opts.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.cookieName = opts.cookieName ?? "dmcp_session";
    this.secure = opts.secureCookies ?? false;
  }

  get sessionCookieName(): string {
    return this.cookieName;
  }

  /** True when the operator supplied a hash rather than a plaintext password. */
  get usesHashedPassword(): boolean {
    return this.opts.passwordHash !== undefined;
  }

  /**
   * Checks a password. Throttled per client key, which the caller passes as the
   * remote address.
   */
  checkPassword(password: string, clientKey: string): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const windowMs = this.opts.loginWindowMs ?? 15 * 60 * 1000;
    const max = this.opts.maxLoginAttempts ?? 10;
    const recent = (this.attempts.get(clientKey) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const oldest = Math.min(...recent);
      return { ok: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
    }

    const ok = this.opts.passwordHash
      ? verifyPassword(password, this.opts.passwordHash)
      : safeEqual(password, this.opts.password!);

    // A successful login does not clear the window: otherwise an attacker who
    // guesses right once gets unlimited attempts, and one who is brute-forcing
    // keeps the record of their earlier failures.
    this.attempts.set(clientKey, [...recent, now]);
    return ok ? { ok: true } : { ok: false, retryAfterMs: 0 };
  }

  /** Issues a session for a client that has just authenticated. */
  createSession(): Session {
    const expiresAt = Date.now() + this.ttlMs;
    const csrf = randomBytes(24).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ exp: expiresAt, csrf, n: randomBytes(8).toString("base64url") }),
    ).toString("base64url");
    return { token: `${payload}.${sign(payload, this.secret)}`, expiresAt, csrf };
  }

  /** Validates a session token. Returns the session, or null when invalid or expired. */
  verifySession(token: string | undefined): Session | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!safeEqual(signature, sign(payload, this.secret))) return null;
    let parsed: { exp?: number; csrf?: string };
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof parsed.exp !== "number" || typeof parsed.csrf !== "string") return null;
    if (parsed.exp <= Date.now()) return null;
    return { token, expiresAt: parsed.exp, csrf: parsed.csrf };
  }

  /**
   * Verifies the CSRF header against the session.
   *
   * `SameSite=Strict` already blocks a cross-site form post, so this is defence in
   * depth: it also stops a request forged by a script on a page the operator has
   * open, which SameSite alone does not cover for same-site subdomains.
   */
  verifyCsrf(session: Session, header: string | undefined): boolean {
    return typeof header === "string" && safeEqual(header, session.csrf);
  }

  /** The `Set-Cookie` value for a new session. */
  sessionCookie(session: Session): string {
    const parts = [
      `${this.cookieName}=${session.token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ];
    if (this.secure) parts.push("Secure");
    return parts.join("; ");
  }

  /** The `Set-Cookie` value that clears the session. */
  clearCookie(): string {
    const parts = [`${this.cookieName}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    if (this.secure) parts.push("Secure");
    return parts.join("; ");
  }

  /** Reads one cookie value out of a `Cookie` header. */
  static readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
  }
}

/** A short fingerprint of a client address, for logs that must not store the raw IP. */
export function clientKey(address: string | undefined): string {
  return createHash("sha256")
    .update(address ?? "unknown")
    .digest("base64url")
    .slice(0, 16);
}
