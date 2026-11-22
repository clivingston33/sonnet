import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db";

/**
 * Whoever is using the app: a profile. `account` is the profile that signs in (it has the
 * username and password); the profiles under it share that sign-in, like profiles on a streaming service.
 */
export type User = { id: number; account: number; name: string; username: string; admin: boolean };

const DAY = 60 * 60 * 24; // seconds

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
      // A profile shows its account's username, not its own placeholder.
      `SELECT u.id, u.owner, u.first, u.last, coalesce(o.username, u.username) AS username, u.admin
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users o ON o.id = u.owner
       WHERE s.token = ? AND s.expires > ?`,
    )
    .get(digest(token), Date.now());
  return row
    ? {
        id: Number(row.id),
        account: Number(row.owner ?? row.id),
        name: `${row.first} ${row.last}`.trim(),
        username: String(row.username),
        admin: !!row.admin,
      }
    : null;
}

/** Points the request's session at another profile of the same account. */
export function switchProfile(req: Request, userId: number) {
  db.prepare("UPDATE sessions SET user_id = ? WHERE token = ?").run(userId, digest(tokenOf(req) ?? ""));
}

/**
 * The family an account belongs to. Every account has one: its own, until it joins someone
 * else's with their code. Profiles are in their account's family. Shared shelves,
 * recommendations and reading activity stay inside a family.
 */
export function familyOf(accountId: number): { id: number; code: string } {
  const row = db
    .prepare("SELECT f.id, f.code FROM users u JOIN families f ON f.id = u.family WHERE u.id = ?")
    .get(accountId);
  if (row) return { id: Number(row.id), code: String(row.code) };
  for (;;) {
    const code = randomInt(1e6).toString().padStart(6, "0");
    if (db.prepare("SELECT 1 FROM families WHERE code = ?").get(code)) continue; // taken: draw again
    const id = Number(db.prepare("INSERT INTO families (code) VALUES (?)").run(code).lastInsertRowid);
    db.prepare("UPDATE users SET family = ? WHERE id = ?").run(id, accountId);
    return { id, code };
  }
}

/** Everyone in a family: its accounts and their profiles. */
export const familyMembers = (familyId: number) =>
  db
    .prepare(
      `SELECT u.id, trim(u.first || ' ' || u.last) AS name, u.prefs ->> 'share' AS share
       FROM users u LEFT JOIN users o ON o.id = u.owner
       WHERE coalesce(o.family, u.family) = ? ORDER BY u.id`,
    )
    .all(familyId);

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

/** The signed-in admin, or the Response to return instead. */
export function authorizeAdmin(req: Request, write = false): User | Response {
  const user = authorize(req, write);
  if (user instanceof Response) return user;
  return user.admin ? user : Response.json({ error: "Only the admin can do that." }, { status: 403 });
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
