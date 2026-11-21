import { rm } from "node:fs/promises";
import path from "node:path";
import { authorize } from "../../server/auth";
import { COVER_DIR, LIBRARY_DIR, STORED, db, getBook, patchBook } from "../../server/db";
import { startWatching } from "../../server/watch";
import { EDITABLE_FIELDS, PREF_KEYS, USER_FIELDS, type Batch } from "../../sync";

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v);
const pick = (source: unknown, keys: readonly string[]) => {
  const out: Fields = {};
  if (isFields(source)) for (const key of keys) if (key in source) out[key] = source[key];
  return out;
};

/** Everything the signed-in user sees: books (shared data + their own), settings and reading time. */
export async function GET(req: Request) {
  const user = authorize(req);
  if (user instanceof Response) return user;

  const prefs: Fields = JSON.parse(
    String(db.prepare("SELECT prefs FROM users WHERE id = ?").get(user.id)!.prefs),
  );
  const rows = db
    .prepare(
      `SELECT b.id, b.data, ub.data AS mine FROM books b
       LEFT JOIN user_books ub ON ub.book_id = b.id AND ub.user_id = ?`,
    )
    .all(user.id);
  const order = Array.isArray(prefs.order) ? prefs.order : [];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i; // books this user hasn't ordered go last
  };
  const books = rows
    // A book added from Discover has no file; it shows only for the people who listed it.
    .filter((r) => r.mine || JSON.parse(String(r.data)).file)
    .map((r) => ({
      ...JSON.parse(String(r.data)),
      ...(r.mine ? JSON.parse(String(r.mine)) : {}),
      id: String(r.id),
    }))
    .sort((a, b) => rank(a.id) - rank(b.id) || String(a.added).localeCompare(String(b.added)));

  const log: Record<string, number> = {};
  for (const r of db.prepare("SELECT day, seconds FROM reading_days WHERE user_id = ?").all(user.id))
    log[String(r.day)] = Number(r.seconds);

  startWatching(); // the watched folder is checked for as long as someone uses the server
  delete prefs.order;
  return Response.json({ user, books, log, prefs });
}

/** Applies a batch of changes (see `diff` in app/sync.ts). */
export async function PATCH(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const text = await req.text();
  if (text.length > 2_000_000) return Response.json({ error: "Too large" }, { status: 413 });
  let batch: Batch;
  try {
    batch = JSON.parse(text);
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const upsertMine = db.prepare(
    `INSERT INTO user_books (user_id, book_id, data) VALUES (?, ?, json_patch('{}', ?))
     ON CONFLICT DO UPDATE SET data = json_patch(data, excluded.data)`,
  );
  const addTime = db.prepare(
    `INSERT INTO reading_days (user_id, day, seconds) VALUES (?, ?, ?)
     ON CONFLICT DO UPDATE SET seconds = seconds + excluded.seconds`,
  );

  for (const [id, change] of Object.entries(isFields(batch.books) ? batch.books : {})) {
    if (!isFields(change) || !getBook(id)) continue;
    // Edited details (title, author, description, series, tags) are the editor's own view of the
    // book: they are kept with that profile and laid over the shared record, for them only.
    const edits = pick(change.shared, EDITABLE_FIELDS);
    // Which shelf a file belongs on (Books or Manga & Comics) is a fact about the file, so it is shared.
    if (edits.kind === "book" || edits.kind === "comic") patchBook(id, { kind: edits.kind });
    delete edits.kind;
    if (Object.keys(edits).length) upsertMine.run(user.id, id, JSON.stringify(edits));
    const mine = pick(change.mine, USER_FIELDS);
    if (Object.keys(mine).length) upsertMine.run(user.id, id, JSON.stringify(mine));
  }

  const prefs = pick(batch.prefs, [...PREF_KEYS, "order"]);
  if (Object.keys(prefs).length)
    db.prepare("UPDATE users SET prefs = json_patch(prefs, ?) WHERE id = ?").run(
      JSON.stringify(prefs),
      user.id,
    );

  for (const [day, seconds] of Object.entries(isFields(batch.time) ? batch.time : {}))
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === "number" && seconds > 0 && seconds <= 86400)
      addTime.run(user.id, day, seconds);

  // Removing a book removes it, and its files, for everyone: admin only.
  for (const id of Array.isArray(batch.removed) ? batch.removed : []) {
    const book = typeof id === "string" ? getBook(id) : null;
    if (!book) continue;
    if (!book.file) {
      // No file: anyone may drop it from their own lists; it is deleted once nobody lists it.
      db.prepare("DELETE FROM user_books WHERE user_id = ? AND book_id = ?").run(user.id, id);
      if (db.prepare("SELECT 1 FROM user_books WHERE book_id = ?").get(id)) continue;
    } else if (!user.admin) continue;
    const parts = Array.isArray(book.files) ? book.files.map((f) => (isFields(f) ? f.file : "")) : [];
    for (const file of [book.file, ...parts])
      if (typeof file === "string" && STORED.test(file))
        await rm(path.join(LIBRARY_DIR, file), { force: true });
    if (typeof book.coverFile === "string" && STORED.test(book.coverFile))
      await rm(path.join(COVER_DIR, book.coverFile), { force: true });
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
  }

  return Response.json({ ok: true });
}
