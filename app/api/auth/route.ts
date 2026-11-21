import { randomInt, randomUUID } from "node:crypto";
import {
  checkPassword,
  crossSite,
  currentUser,
  endSession,
  hashPassword,
  familyMembers,
  familyOf,
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
const validPin = (v: unknown): v is string => typeof v === "string" && /^\d{4,8}$/.test(v);

// Eight wrong tries at one account (or one profile's PIN) lock it for 15 minutes.
// Counted per account, not per address: an address is easy to fake, an account's name is the target.
// ponytail: kept in memory, so a restart forgets the counts; move to the database if that matters.
const misses = new Map<string, { n: number; until: number }>();
const locked = (key: string) => {
  const m = misses.get(key);
  return m && m.n >= 8 && m.until > Date.now() ? Math.ceil((m.until - Date.now()) / 60_000) : 0;
};
const miss = (key: string) => {
  if (misses.size > 10_000) misses.clear();
  const m = misses.get(key);
  misses.set(key, { n: m && m.until > Date.now() ? m.n + 1 : 1, until: Date.now() + 15 * 60_000 });
};
const tooMany = (minutes: number) =>
  fail(`Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429);

/** Who is signed in, what the sign-in page should offer, and (for admins) the user list. */
export async function GET(req: Request) {
  const user = currentUser(req);
  const first = noAdmin();
  const family = user && familyOf(user.account);
  return Response.json({
    first, // no real account yet: the next one created becomes the admin
    signups: first || signupsOpen(),
    user,
    // The code others enter to join this person's family, and who is in it.
    family: family && {
      code: family.code,
      members: familyMembers(family.id).map((m) => ({ id: m.id, name: m.name })),
    },
    // Everyone who shares this sign-in, the account's own profile first.
    profiles: user
      ? db
          .prepare(
            `SELECT id, trim(first || ' ' || last) AS name, pin IS NOT NULL AS locked
             FROM users WHERE id = ? OR owner = ? ORDER BY id`,
          )
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

/** POST { action: "register" | "login" | "logout" | "password" | "signups" | "removeUser", ... } */
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
    // Optional: the six-digit code of a family to join. Without one the account starts its own.
    const code = text(body.family, 10);
    // Nobody is signed in yet, so wrong codes are counted for the whole server:
    // otherwise the million possible codes could simply be tried one after another.
    const wait = code ? locked("family-code") : 0;
    if (wait) return tooMany(wait);
    const joining = code ? db.prepare("SELECT id FROM families WHERE code = ?").get(code) : null;
    if (code && !joining) {
      miss("family-code");
      return fail("No family has that code. Check it, or leave it empty.");
    }
    const id = create(first, text(body.last, 40), email, body.password, admin);
    if (joining) db.prepare("UPDATE users SET family = ? WHERE id = ?").run(joining.id, id);
    return signIn(id, body.remember === true);
  }

  if (body.action === "login") {
    const email = text(body.email, 200).toLowerCase();
    const wait = locked(email);
    if (wait) return tooMany(wait);
    const row = db.prepare("SELECT id, password FROM users WHERE email = ?").get(email);
    if (!row || typeof body.password !== "string" || !checkPassword(body.password, String(row.password))) {
      miss(email);
      return fail("Wrong email or password.", 401);
    }
    misses.delete(email);
    return signIn(Number(row.id), body.remember === true);
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

  // Moves this account (and its profiles) into the family that has the code.
  if (body.action === "joinFamily") {
    const key = `family:${user.account}`;
    const wait = locked(key);
    if (wait) return tooMany(wait); // a six-digit code must not be guessable by trying them all
    const target = db.prepare("SELECT id FROM families WHERE code = ?").get(text(body.code, 10));
    if (!target) {
      miss(key);
      return fail("No family has that code.", 404);
    }
    db.prepare("UPDATE users SET family = ? WHERE id = ?").run(target.id, user.account);
    return Response.json({ ok: true });
  }
  // Leaves the family for a new one of its own, with a new code.
  if (body.action === "leaveFamily") {
    db.prepare("UPDATE users SET family = NULL WHERE id = ?").run(user.account);
    familyOf(user.account);
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
    const pin = db.prepare("SELECT pin FROM users WHERE id = ?").get(Number(body.id))?.pin;
    if (pin && body.id !== user.id) {
      const key = `pin:${body.id}`;
      const wait = locked(key);
      if (wait) return tooMany(wait);
      if (typeof body.pin !== "string" || !checkPassword(body.pin, String(pin))) {
        miss(key);
        return fail("Wrong PIN.", 403);
      }
      misses.delete(key);
    }
    switchProfile(req, Number(body.id));
    return Response.json({ ok: true });
  }

  // A profile sets or removes its own PIN; the account's password can clear anyone's (a forgotten PIN).
  if (body.action === "setPin") {
    if (!inAccount(body.id)) return fail("No such profile.", 404);
    if (body.id !== user.id) {
      const row = db.prepare("SELECT password FROM users WHERE id = ?").get(user.account)!;
      if (typeof body.password !== "string" || !checkPassword(body.password, String(row.password)))
        return fail("The account password is wrong.", 403);
    }
    if (body.pin && !validPin(body.pin)) return fail("A PIN is 4 to 8 digits.");
    db.prepare("UPDATE users SET pin = ? WHERE id = ?").run(
      body.pin ? hashPassword(String(body.pin)) : null,
      Number(body.id),
    );
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

  // For someone who forgot their password and can't use a reset code. Signs them out everywhere.
  if (body.action === "setPassword") {
    if (typeof body.id !== "number" || !validPassword(body.password))
      return fail("Use a password of at least 8 characters.");
    const done = db
      .prepare("UPDATE users SET password = ? WHERE id = ? AND owner IS NULL")
      .run(hashPassword(body.password), body.id);
    if (!done.changes) return fail("No such account.", 404);
    if (body.id !== user.account)
      db.prepare(
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR owner = ?)",
      ).run(body.id, body.id);
    return Response.json({ ok: true });
  }

  return fail("Unknown action");
}
