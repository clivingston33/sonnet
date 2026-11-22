import { authorize, familyMembers, familyOf } from "../../server/auth";
import { db, getBook } from "../../server/db";

type Row = Record<string, unknown>;
const ids = (json: unknown): string[] => JSON.parse(String(json));
const numbers = (json: unknown): number[] => JSON.parse(String(json));
/** A shared shelf is seen by its maker and by the people it is shared with (no list: the whole family). */
const visible = (shelf: Row, userId: number) =>
  shelf.owner === userId || !shelf.members || numbers(shelf.members).includes(userId);

/**
 * GET: what the people on this server share with each other: the shared shelves, what the
 * others are reading or just finished (unless they turned that off), and books recommended to you.
 */
export async function GET(req: Request) {
  const user = authorize(req);
  if (user instanceof Response) return user;
  const family = familyOf(user.account).id;
  const people = familyMembers(family).filter((p) => p.id !== user.id);
  const shelves = db
    .prepare(
      "SELECT id, name, owner, books, members FROM shared_shelves WHERE family = ? OR family IS NULL ORDER BY id",
    )
    .all(family)
    .filter((s) => visible(s, user.id))
    .map((s) => ({
      id: Number(s.id),
      name: String(s.name),
      bookIds: ids(s.books),
      mine: s.owner === user.id || user.admin, // may rename, delete and stop sharing it
      owned: s.owner === user.id, // may choose who it is shared with
      members: s.members ? numbers(s.members) : null, // null: the whole family
    }));

  const activity: Row[] = [];
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toLocaleDateString("sv");
  for (const p of people) {
    if (p.share === 0) continue; // they keep their reading to themselves
    const rows = db
      .prepare("SELECT book_id, data FROM user_books WHERE user_id = ?")
      .all(p.id)
      .map((r): Row & { book: string } => ({ ...JSON.parse(String(r.data)), book: String(r.book_id) }));
    const reading = rows
      .filter((r) => !r.finished && Number(r.progress) > 0 && Number(r.progress) < 1)
      .sort((a, b) => Number(b.opened ?? 0) - Number(a.opened ?? 0))[0];
    if (reading) activity.push({ name: p.name, book: reading.book, progress: reading.progress });
    const finished = rows
      .filter((r) => typeof r.finished === "string" && r.finished >= monthAgo)
      .sort((a, b) => String(b.finished).localeCompare(String(a.finished)))[0];
    if (finished) activity.push({ name: p.name, book: finished.book, finished: finished.finished, rating: finished.rating });
  }

  const recs = db
    .prepare(
      `SELECT r.book_id AS book, trim(u.first || ' ' || u.last) AS name FROM recommendations r
       JOIN users u ON u.id = r.from_user WHERE r.to_user = ? ORDER BY r.created DESC`,
    )
    .all(user.id);
  return Response.json({ people: people.map((p) => ({ id: p.id, name: p.name })), shelves, activity, recs });
}

/** POST { action: "newShelf" | "renameShelf" | "deleteShelf" | "toggleBook" | "recommend" | "dismiss", ... } */
export async function POST(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const body: Row = await req.json().catch(() => ({}));
  const fail = (error: string, status = 400) => Response.json({ error }, { status });
  const ok = (extra: Row = {}) => Response.json({ ok: true, ...extra });
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const family = familyOf(user.account).id;
  const found = db
    .prepare("SELECT id, owner, books, members FROM shared_shelves WHERE id = ? AND (family = ? OR family IS NULL)")
    .get(Number(body.id), family);
  const shelf = found && visible(found, user.id) ? found : undefined;
  const book = typeof body.book === "string" && getBook(body.book) ? body.book : null;
  // Who a shelf is shared with: people of this family other than its maker. Not a list: everyone.
  const members = Array.isArray(body.members)
    ? JSON.stringify(
        familyMembers(family)
          .map((p) => Number(p.id))
          .filter((id) => id !== user.id && (body.members as unknown[]).includes(id)),
      )
    : null;

  if (body.action === "newShelf") {
    if (!name) return fail("Give the shelf a name.");
    // `books`: the shelf starts with these (a personal shelf being shared).
    const books = Array.isArray(body.books) ? body.books.filter((b) => typeof b === "string" && getBook(b)) : [];
    const id = db
      .prepare("INSERT INTO shared_shelves (name, owner, books, family, members) VALUES (?, ?, ?, ?, ?)")
      .run(name, user.id, JSON.stringify(books), family, members).lastInsertRowid;
    return ok({ id: Number(id) });
  }
  if (body.action === "recommend") {
    const to = familyMembers(family).find((p) => p.id === Number(body.to) && p.id !== user.id);
    if (!to || !book) return fail("No such person or book.", 404);
    db.prepare(
      "INSERT OR REPLACE INTO recommendations (to_user, from_user, book_id, created) VALUES (?, ?, ?, ?)",
    ).run(to.id, user.id, book, Date.now());
    return ok();
  }
  if (body.action === "dismiss") {
    db.prepare("DELETE FROM recommendations WHERE to_user = ? AND book_id = ?").run(user.id, String(body.book));
    return ok();
  }

  if (!shelf) return fail("No such shelf.", 404);
  // Everyone may put books on a shared shelf and take them off.
  if (body.action === "toggleBook") {
    if (!book) return fail("No such book.", 404);
    const list = ids(shelf.books);
    const next = list.includes(book) ? list.filter((b) => b !== book) : [...list, book];
    db.prepare("UPDATE shared_shelves SET books = ? WHERE id = ?").run(JSON.stringify(next), shelf.id);
    return ok();
  }
  // Only whoever made a shelf chooses who sees it.
  if (body.action === "shareWith") {
    if (shelf.owner !== user.id) return fail("Only the person who made this shelf can do that.", 403);
    db.prepare("UPDATE shared_shelves SET members = ? WHERE id = ?").run(members, shelf.id);
    return ok();
  }
  // Renaming and deleting are for whoever made it, and the admin.
  if (shelf.owner !== user.id && !user.admin) return fail("Only the person who made this shelf can do that.", 403);
  if (body.action === "renameShelf") {
    if (!name) return fail("Give the shelf a name.");
    db.prepare("UPDATE shared_shelves SET name = ? WHERE id = ?").run(name, shelf.id);
    return ok();
  }
  if (body.action === "deleteShelf") {
    db.prepare("DELETE FROM shared_shelves WHERE id = ?").run(shelf.id);
    return ok();
  }
  return fail("Unknown action");
}
