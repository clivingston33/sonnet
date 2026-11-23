import { authorize } from "../../server/auth";
import { db, getBook } from "../../server/db";

/** GET ?book=<id>: what people on this server wrote about the book, newest first, with the stars they gave it. */
export async function GET(req: Request) {
  const user = authorize(req);
  if (user instanceof Response) return user;
  const book = new URL(req.url).searchParams.get("book") ?? "";
  const reviews = db
    .prepare(
      `SELECT r.user_id, r.text, r.created, u.first || ' ' || u.last AS name, ub.data ->> 'rating' AS rating
       FROM reviews r JOIN users u ON u.id = r.user_id
       LEFT JOIN user_books ub ON ub.user_id = r.user_id AND ub.book_id = r.book_id
       WHERE r.book_id = ? ORDER BY r.created DESC`,
    )
    .all(book)
    .map((r) => ({
      name: String(r.name).trim(),
      text: String(r.text),
      created: String(r.created),
      rating: typeof r.rating === "number" ? r.rating : undefined,
      mine: r.user_id === user.id,
    }));
  return Response.json({ reviews });
}

/** PUT { book, text }: saves the signed-in user's review of the book; empty text removes it. */
export async function PUT(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => null);
  const book: unknown = body?.book;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (typeof book !== "string" || !getBook(book))
    return Response.json({ error: "No such book" }, { status: 404 });
  if (text)
    db.prepare(
      `INSERT INTO reviews (user_id, book_id, text, created) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET text = excluded.text, created = excluded.created`,
    ).run(user.id, book, text, new Date().toISOString());
  else db.prepare("DELETE FROM reviews WHERE user_id = ? AND book_id = ?").run(user.id, book);
  return Response.json({ ok: true });
}
