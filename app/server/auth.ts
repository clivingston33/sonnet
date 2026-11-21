import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db";

/**
 * Whoever is using the app: a profile. `account` is the profile that signs in (it has the
 * email and password); the profiles under it share that sign-in, like profiles on a streaming service.
 */
export type User = { id: number; account: number; name: string; email: string; admin: boolean };

const DAY = 60 * 60 * 24; // seconds

/** Skipping sign-in is for trying the app out: always available in development, opt-in otherwise. */
export const BYPASS = process.env.AUTH_BYPASS === "1" || process.env.NODE_ENV !== "production";

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, Buffer.from(salt, "hex"), 64),
    Buffer.from(hash, "hex"),
  );
}

// Only a hash of the session token is stored, so a copy of the database can't be used to sign in.
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenOf = (req: Request) =>
  /(?:^|;\s*)session=([a-f0-9]{64})/.exec(req.headers.get("cookie") ?? "")?.[1];

export function currentUser(req: Request): User | null {
  const token = tokenOf(req);
  if (!token) return null;
  const row = db
    .prepare(
      // A profile shows its account's email, not its own placeholder.
      `SELECT u.id, u.owner, u.first, u.last, coalesce(o.email, u.email) AS email, u.admin
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users o ON o.id = u.owner
       WHERE s.token = ? AND s.expires > ?`,
    )
    .get(digest(token), Date.now());
  return row
    ? {
        id: Number(row.id),
        account: Number(row.owner ?? row.id),
        name: `${row.first} ${row.last}`.trim(),
        email: String(row.email),
        admin: !!row.admin,
      }
    : null;
}

/** Points the request's session at another profile of the same account. */
export function switchProfile(req: Request, userId: number) {
  db.prepare("UPDATE sessions SET user_id = ? WHERE token = ?").run(userId, digest(tokenOf(req) ?? ""));
}

/** True when a browser on another site sent the request (browsers always attach Origin to those). */
export function crossSite(req: Request) {
  const origin = req.headers.get("origin");
  return !!origin && new URL(origin).host !== req.headers.get("host");
}

/**
 * The signed-in user, or the Response to return instead.
 * Pass `write` for anything that changes data: those are refused when they come from another site.
 */
export function authorize(req: Request, write = false): User | Response {
  if (write && crossSite(req)) return Response.json({ error: "Forbidden" }, { status: 403 });
  return currentUser(req) ?? Response.json({ error: "Sign in first" }, { status: 401 });
}

// `Secure` only over HTTPS: a home server reached by plain http://ip would otherwise never get the cookie.
// Without Max-Age the cookie goes when the browser closes.
const cookie = (req: Request, value: string, maxAge?: number) =>
  `session=${value}; Path=/; HttpOnly; SameSite=Lax${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}${
    new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https"
      ? "; Secure"
      : ""
  }`;

/**
 * Creates a session and returns the Set-Cookie header value for it.
 * `remember` keeps it for 30 days; otherwise it ends with the browser, or after a day.
 */
export function startSession(req: Request, userId: number, remember: boolean) {
  const token = randomBytes(32).toString("hex");
  const life = remember ? 30 * DAY : DAY;
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)").run(
    digest(token),
    userId,
    Date.now() + life * 1000,
  );
  return cookie(req, token, remember ? life : undefined);
}

/** Ends the request's session and returns the Set-Cookie header value that clears it. */
export function endSession(req: Request) {
  const token = tokenOf(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(digest(token));
  return cookie(req, "", 0);
}
