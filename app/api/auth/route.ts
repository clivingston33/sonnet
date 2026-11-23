import { randomInt, randomUUID } from "node:crypto";
import {
  checkPassword,
  crossSite,
  currentUser,
  demoGuard,
  endSession,
  hashPassword,
  familyMembers,
  familyOf,
  startSession,
  switchProfile,
} from "../../server/auth";
import { DEMO, db } from "../../server/db";
import { lanAddresses } from "../../server/discovery";

const fail = (error: string, status = 400) => Response.json({ error }, { status });
// The guest from "Continue without an account" never counts: the first real account is the admin.
const noAdmin = () => !db.prepare("SELECT 1 FROM users WHERE admin = 1").get();
// People sign themselves up, and a family code entered there puts them straight into a family.
// The admin can turn that off and add people one by one instead.
const signupsOpen = () =>
  db.prepare("SELECT value FROM settings WHERE key = 'signups'").get()?.value !== "off";
const setting = (key: string, value: string) =>
  db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value")
    .run(key, value);
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
  const refused = demoGuard(req);
  if (refused) return refused;
  const user = currentUser(req);
  const first = noAdmin();
  const family = user && familyOf(user.account);
  return Response.json({
    first, // no real account yet: the next one created becomes the admin
    demo: !!DEMO, // a public demo: the sign-in page offers a throwaway account
    signups: !DEMO && (first || signupsOpen()),
    user,
    // The admin of a new server is walked through setting it up, once (see `Setup` in app/page.tsx).
    setup:
      !!user?.admin && db.prepare("SELECT value FROM settings WHERE key = 'setup'").get()?.value === "pending",
    addresses: user?.admin ? lanAddresses() : undefined,
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
            `SELECT id, first || ' ' || last AS name, username, admin,
               (SELECT code FROM resets r WHERE r.user_id = users.id AND r.expires > ?) AS reset
             FROM users WHERE owner IS NULL ORDER BY id`,
          )
          .all(Date.now())
      : undefined,
  });
}

/** What a chosen username may be. Accounts older than usernames keep an email address instead. */
const USERNAME = /^[a-z0-9._-]{3,30}$/i;
const BAD_USERNAME = "Choose a username of 3 to 30 letters, numbers, dots, dashes or underscores.";

/** POST { action: "register" | "login" | "logout" | "password" | "signups" | "removeUser", ... } */
export async function POST(req: Request) {
  const refused = demoGuard(req);
  if (refused) return refused;
  if (crossSite(req)) return fail("Forbidden", 403);
  const body: Record<string, unknown> = await req.json().catch(() => ({}));
  // A demo has throwaway accounts only: nothing to sign in to, create, reset or change.
  if (DEMO && body.action !== "demo" && body.action !== "logout")
    return fail("That is turned off in the demo.", 403);
  const signIn = (id: number, remember: boolean) =>
    Response.json({ ok: true }, { headers: { "Set-Cookie": startSession(req, id, remember) } });
  const create = (first: string, last: string, username: string, password: string, admin = false) =>
    Number(
      db
        .prepare("INSERT INTO users (first, last, username, password, admin) VALUES (?, ?, ?, ?, ?)")
        .run(first, last, username, hashPassword(password), admin ? 1 : 0).lastInsertRowid,
    );
  const idOf = (username: string) =>
    db.prepare("SELECT id FROM users WHERE username = ?").get(username)?.id;

  if (body.action === "register") {
    const admin = noAdmin();
    if (!admin && !signupsOpen())
      return fail("New accounts are turned off on this server. Ask its admin.", 403);
    const first = text(body.first, 40);
    const username = text(body.username, 30);
    if (!first) return fail("Enter your first name.");
    if (!USERNAME.test(username)) return fail(BAD_USERNAME);
    if (!validPassword(body.password)) return fail("Use a password of at least 8 characters.");
    if (idOf(username)) return fail("That username is taken. Choose another, or sign in instead.", 409);
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
    const id = create(first, text(body.last, 40), username, body.password, admin);
    if (admin) setting("setup", "pending");
    if (joining) db.prepare("UPDATE users SET family = ? WHERE id = ?").run(joining.id, id);
    return signIn(id, body.remember === true);
  }

  if (body.action === "login") {
    // 200: accounts from before usernames sign in with the email address they were made with.
    const username = text(body.username, 200).toLowerCase();
    const wait = locked(username);
    if (wait) return tooMany(wait);
    const row = db.prepare("SELECT id, password FROM users WHERE username = ?").get(username);
    if (!row || typeof body.password !== "string" || !checkPassword(body.password, String(row.password))) {
      miss(username);
      return fail("Wrong username or password.", 401);
    }
    misses.delete(username);
    return signIn(Number(row.id), body.remember === true);
  }

  // A public demo: every visitor gets an account of their own, so they don't share progress or shelves.
  if (body.action === "demo" && DEMO) {
    // Earlier visitors' accounts go once their day-long session has ended, and the oldest go
    // early when there are more than 300: a script can't fill the database with them.
    db.prepare(
      `DELETE FROM users WHERE username LIKE 'demo-%@local' AND (
         id NOT IN (SELECT coalesce(u.owner, u.id) FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires > ?)
         OR id <= (SELECT id FROM users WHERE username LIKE 'demo-%@local' ORDER BY id DESC LIMIT 1 OFFSET 300))`,
    ).run(Date.now());
    // Like a profile's, the name has an "@" and the password is unknown: nobody can sign in to it.
    return signIn(create("Guest", "", `demo-${randomUUID()}@local`, randomUUID()), false);
  }

  // There is no mail server, so the code goes to the admin (Settings → Account) and the server log.
  if (body.action === "forgot") {
    const username = text(body.username, 200);
    const id = idOf(username);
    if (id) {
      const code = randomInt(1e8).toString().padStart(8, "0");
      db.prepare(
        `INSERT INTO resets (user_id, code, expires) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET code = excluded.code, expires = excluded.expires, tries = 0`,
      ).run(id, code, Date.now() + 30 * 60_000);
      console.log(`Password reset code for ${username}: ${code} (valid for 30 minutes)`);
    }
    return Response.json({ ok: true }); // the same answer either way, so this can't be used to find accounts
  }

  if (body.action === "reset") {
    if (!validPassword(body.password)) return fail("Use a password of at least 8 characters.");
    const row = db
      .prepare(
        `SELECT r.user_id, r.code, r.tries FROM resets r JOIN users u ON u.id = r.user_id
         WHERE u.username = ? AND r.expires > ?`,
      )
      .get(text(body.username, 200), Date.now());
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

  if (body.action === "username") {
    // Like the password, it belongs to the account. The password is asked for: this is what signs in.
    const username = text(body.username, 30);
    if (!USERNAME.test(username)) return fail(BAD_USERNAME);
    const row = db.prepare("SELECT password FROM users WHERE id = ?").get(user.account)!;
    if (typeof body.current !== "string" || !checkPassword(body.current, String(row.password)))
      return fail("Your password is wrong.", 403);
    const taken = idOf(username);
    if (taken && taken !== user.account) return fail("That username is taken. Choose another.", 409);
    db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, user.account);
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
    // A profile can't sign in by itself: nobody knows its password, and its placeholder name
    // has an "@", which no chosen username can.
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
    setting("signups", body.allow === true ? "on" : "off");
    return Response.json({ ok: true });
  }

  if (body.action === "setupDone") {
    setting("setup", "done");
    return Response.json({ ok: true });
  }

  // The admin makes someone's account and tells them the username and password.
  if (body.action === "addUser") {
    const first = text(body.first, 40);
    const username = text(body.username, 30);
    if (!first) return fail("Enter their first name.");
    if (!USERNAME.test(username)) return fail(BAD_USERNAME);
    if (!validPassword(body.password)) return fail("Use a password of at least 8 characters.");
    if (idOf(username)) return fail("That username is taken. Choose another.", 409);
    create(first, text(body.last, 40), username, body.password);
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
