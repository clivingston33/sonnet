import { randomInt, randomUUID } from "node:crypto";
import {
  BYPASS,
  checkPassword,
  crossSite,
  currentUser,
  endSession,
  hashPassword,
  startSession,
  switchProfile,
} from "../../server/auth";
import { db } from "../../server/db";

const fail = (error: string, status = 400) => Response.json({ error }, { status });
// The guest from "Continue without an account" never counts: the first real account is the admin.
const noAdmin = () => !db.prepare("SELECT 1 FROM users WHERE admin = 1").get();
// Anyone who can reach the server may create an account unless the admin turns this off.
const signupsOpen = () =>
  db.prepare("SELECT value FROM settings WHERE key = 'signups'").get()?.value !== "off";
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validPassword = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 8 && v.length <= 200;

/** Who is signed in, what the sign-in page should offer, and (for admins) the user list. */
export async function GET(req: Request) {
  const user = currentUser(req);
  const first = noAdmin();
  return Response.json({
    first, // no real account yet: the next one created becomes the admin
    signups: first || signupsOpen(),
    bypass: BYPASS,
    user,
    // Everyone who shares this sign-in, the account's own profile first.
    profiles: user
      ? db
          .prepare("SELECT id, trim(first || ' ' || last) AS name FROM users WHERE id = ? OR owner = ? ORDER BY id")
          .all(user.account, user.account)
      : undefined,
    users: user?.admin
      ? db
          .prepare(
            // `reset` is a code the person asked for after forgetting their password; the admin passes it on.
            `SELECT id, first || ' ' || last AS name, email, admin,
               (SELECT code FROM resets r WHERE r.user_id = users.id AND r.expires > ?) AS reset
             FROM users WHERE owner IS NULL ORDER BY id`,
          )
          .all(Date.now())
      : undefined,
  });
}

/** POST { action: "register" | "login" | "bypass" | "logout" | "password" | "signups" | "removeUser", ... } */
export async function POST(req: Request) {
  if (crossSite(req)) return fail("Forbidden", 403);
  const body: Record<string, unknown> = await req.json().catch(() => ({}));
  const signIn = (id: number, remember: boolean) =>
    Response.json({ ok: true }, { headers: { "Set-Cookie": startSession(req, id, remember) } });
  const create = (first: string, last: string, email: string, password: string, admin = false) =>
    Number(
      db
        .prepare("INSERT INTO users (first, last, email, password, admin) VALUES (?, ?, ?, ?, ?)")
        .run(first, last, email, hashPassword(password), admin ? 1 : 0).lastInsertRowid,
    );
  const idOf = (email: string) => db.prepare("SELECT id FROM users WHERE email = ?").get(email)?.id;

  if (body.action === "register") {
    const admin = noAdmin();
    if (!admin && !signupsOpen())
      return fail("New accounts are turned off on this server. Ask its admin.", 403);
    const first = text(body.first, 40);
    const email = text(body.email, 200);
    if (!first) return fail("Enter your first name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
    if (!validPassword(body.password)) return fail("Use a password of at least 8 characters.");
    if (idOf(email)) return fail("An account with that email already exists. Sign in instead.", 409);
    return signIn(
      create(first, text(body.last, 40), email, body.password, admin),
      body.remember === true,
    );
  }

  if (body.action === "login") {
    const row = db
      .prepare("SELECT id, password FROM users WHERE email = ?")
      .get(text(body.email, 200));
    // ponytail: no attempt limit; add a per-IP backoff before exposing this beyond the home network
    if (!row || typeof body.password !== "string" || !checkPassword(body.password, String(row.password)))
      return fail("Wrong email or password.", 401);
    return signIn(Number(row.id), body.remember === true);
  }

  // Signs in as a shared guest without a password, for trying the app out.
  if (body.action === "bypass") {
    if (!BYPASS) return fail("Not available on this server.", 403);
    const id = idOf("guest@local") ?? create("Guest", "", "guest@local", crypto.randomUUID());
    return signIn(Number(id), false);
  }

  // There is no mail server, so the code goes to the admin (Settings → Account) and the server log.
  if (body.action === "forgot") {
    const email = text(body.email, 200);
    const id = idOf(email);
    if (id) {
      const code = randomInt(1e8).toString().padStart(8, "0");
      db.prepare(
        `INSERT INTO resets (user_id, code, expires) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET code = excluded.code, expires = excluded.expires, tries = 0`,
      ).run(id, code, Date.now() + 30 * 60_000);
      console.log(`Password reset code for ${email}: ${code} (valid for 30 minutes)`);
    }
    return Response.json({ ok: true }); // the same answer either way, so this can't be used to find accounts
  }

  if (body.action === "reset") {
    if (!validPassword(body.password)) return fail("Use a password of at least 8 characters.");
    const row = db
      .prepare(
        `SELECT r.user_id, r.code, r.tries FROM resets r JOIN users u ON u.id = r.user_id
         WHERE u.email = ? AND r.expires > ?`,
      )
      .get(text(body.email, 200), Date.now());
    if (!row || row.code !== text(body.code, 20)) {
      // Five wrong guesses and the code is gone.
      if (row)
        db.prepare(
          Number(row.tries) >= 4
            ? "DELETE FROM resets WHERE user_id = ?"
            : "UPDATE resets SET tries = tries + 1 WHERE user_id = ?",
        ).run(row.user_id);
      return fail("That code is wrong or has expired. Ask for a new one.", 403);
    }
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashPassword(body.password), row.user_id);
    db.prepare("DELETE FROM resets WHERE user_id = ?").run(row.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id); // sign out everywhere
    return signIn(Number(row.user_id), false);
  }

  if (body.action === "logout")
    return Response.json({ ok: true }, { headers: { "Set-Cookie": endSession(req) } });

  const user = currentUser(req);
  if (!user) return fail("Sign in first", 401);

  if (body.action === "password") {
    // The password belongs to the account, whichever of its profiles is in use.
    const row = db.prepare("SELECT password FROM users WHERE id = ?").get(user.account)!;
    if (typeof body.current !== "string" || !checkPassword(body.current, String(row.password)))
      return fail("Your current password is wrong.", 403);
    if (!validPassword(body.next)) return fail("Use a password of at least 8 characters.");
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashPassword(body.next), user.account);
    return Response.json({ ok: true });
  }

  const inAccount = (id: unknown) =>
    typeof id === "number" &&
    !!db.prepare("SELECT 1 FROM users WHERE id = ? AND (id = ? OR owner = ?)").get(id, user.account, user.account);

  if (body.action === "addProfile") {
    const name = text(body.name, 40);
    if (!name) return fail("Enter a name.");
    const count = db.prepare("SELECT count(*) AS n FROM users WHERE owner = ?").get(user.account)!.n;
    if (Number(count) >= 7) return fail("An account can have up to 8 profiles.");
    // A profile can't sign in by itself: its email is a placeholder and nobody knows its password.
    const id = create(name, "", `profile-${randomUUID()}@local`, randomUUID());
    db.prepare("UPDATE users SET owner = ? WHERE id = ?").run(user.account, id);
    return Response.json({ ok: true });
  }

  if (body.action === "switchProfile") {
    if (!inAccount(body.id)) return fail("No such profile.", 404);
    switchProfile(req, Number(body.id));
    return Response.json({ ok: true });
  }

  if (body.action === "removeProfile") {
    if (!inAccount(body.id) || body.id === user.account || body.id === user.id)
      return fail("Switch to another profile first; the account’s own profile can’t be removed.");
    db.prepare("DELETE FROM users WHERE id = ?").run(Number(body.id));
    return Response.json({ ok: true });
  }

  if (!user.admin) return fail("Only the admin can do that.", 403);

  if (body.action === "signups") {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('signups', ?) ON CONFLICT DO UPDATE SET value = excluded.value",
    ).run(body.allow === false ? "off" : "on");
    return Response.json({ ok: true });
  }

  if (body.action === "removeUser") {
    if (typeof body.id !== "number" || body.id === user.id)
      return fail("You can’t remove your own account.");
    db.prepare("DELETE FROM users WHERE id = ?").run(body.id);
    return Response.json({ ok: true });
  }

  return fail("Unknown action");
}
