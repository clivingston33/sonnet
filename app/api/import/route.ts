import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { kindOf } from "../../formats";
import { authorize } from "../../server/auth";
import { LIBRARY_DIR, db, getBook, patchBook, type BookData } from "../../server/db";
import { hashFile, saveBody, saveCover } from "../../server/files";
import { CONVERTER, nameMeta, readMeta, tidyComic, volumeOf } from "../../server/metadata";

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 2048) * 1024 * 1024;
const UNKNOWN_AUTHOR = "Unknown Author";
const PALETTE = [
  ["#23254d", "#07070c"],
  ["#2f9d5c", "#04201f"],
  ["#f0a030", "#8a3a14"],
  ["#7a2f3a", "#1c0a10"],
  ["#2b5d8a", "#0a1a2a"],
  ["#5a3d8a", "#150d24"],
];

type Part = { file: string; duration: number; name: string; track?: number };
const isPart = (v: unknown): v is Part =>
  !!v && typeof v === "object" && "file" in v && "duration" in v && "name" in v;
const partsOf = (book: BookData) => (Array.isArray(book.files) ? book.files.filter(isPart) : []);

/**
 * PUT /api/import?name=<original file name>, raw file as the body.
 * Stores the file, reads its own metadata and cover, and returns the book it created.
 * An audio file whose album matches an existing audiobook is added to it as the next part.
 */
export async function PUT(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  let kind = kindOf(name);
  if (!kind || !req.body)
    return Response.json({ error: "Unsupported file type" }, { status: 415 });
  const tooLarge = Response.json({ error: "File too large" }, { status: 413 });
  if (Number(req.headers.get("content-length")) > MAX_BYTES) return tooLarge;

  // The client's name only supplies the (allow-listed) extension, never the path.
  const file = `${randomUUID()}.${name.split(".").pop()!.toLowerCase()}`;
  const saved = await saveBody(req, path.join(LIBRARY_DIR, file), MAX_BYTES);
  if (saved !== "ok")
    return saved === "too-large" ? tooLarge : Response.json({ error: "Upload failed" }, { status: 500 });

  // The very same file again (a folder imported twice): keep the copy that is already there.
  const hash = await hashFile(path.join(LIBRARY_DIR, file));
  const twin = db.prepare("SELECT book_id FROM files WHERE hash = ?").get(hash)?.book_id;
  if (twin) {
    await rm(path.join(LIBRARY_DIR, file), { force: true });
    return Response.json({ book: { ...getBook(String(twin)), id: twin }, duplicate: true });
  }
  const remember = (bookId: unknown) =>
    db.prepare("INSERT OR REPLACE INTO files (hash, book_id) VALUES (?, ?)").run(hash, String(bookId));

  const { cover, comic, ...meta } = await readMeta(path.join(LIBRARY_DIR, file));
  if (comic) kind = "comic"; // an EPUB of page images belongs with the manga, not the novels
  const named = nameMeta(name);
  const tidy = (title: string | undefined) => (kind === "comic" && title ? tidyComic(title) : title);
  meta.title = tidy(meta.title);
  const fallbackTitle = tidy(named.title)!;
  if (kind === "comic" && CONVERTER.test(meta.author ?? "")) delete meta.author;
  const author = meta.author ?? named.author ?? UNKNOWN_AUTHOR;
  // A comic that says nothing about its series is filed by the number in its name.
  const volume = kind === "comic" && !meta.series ? volumeOf(meta.title ?? fallbackTitle) : {};
  const part: Part = {
    file,
    duration: meta.duration ?? 0,
    name: meta.part ?? fallbackTitle,
    track: meta.track,
  };

  if (kind === "audiobook" && meta.album) {
    const row = db
      .prepare(
        `SELECT id FROM books WHERE data ->> 'kind' = 'audiobook'
         AND data ->> 'album' = ? AND data ->> 'author' = ?`,
      )
      .get(meta.album, author);
    const existing = row && getBook(String(row.id));
    if (row && existing) {
      const files = [...partsOf(existing), part].sort(
        (a, b) => (a.track ?? 1e9) - (b.track ?? 1e9) || a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
      // With several files, each file is a chapter.
      let start = 0;
      const chapters = files.map((f) => {
        const chapter = { title: f.name, start };
        start += f.duration;
        return chapter;
      });
      patchBook(String(row.id), { files, chapters, duration: start, file: files[0].file });
      remember(row.id);
      return Response.json({ book: { ...getBook(String(row.id)), id: row.id }, merged: true });
    }
  }

  const book: BookData = {
    title: (meta.title ?? fallbackTitle) || "Untitled",
    author,
    kind,
    cover: PALETTE[fallbackTitle.length % PALETTE.length],
    coverFile: cover && (await saveCover(cover)),
    added: new Date().toLocaleDateString("sv"),
    file,
    blurb: meta.description,
    series: meta.series ?? volume.series,
    seriesIndex: meta.seriesIndex ?? volume.seriesIndex,
    rtl: meta.rtl,
    isbn: meta.isbn,
    ...(kind === "audiobook" && {
      narrator: meta.narrator,
      album: meta.album,
      duration: meta.duration,
      chapters: meta.chapters?.length ? meta.chapters : undefined,
      files: [part],
    }),
  };
  const id = randomUUID();
  db.prepare("INSERT INTO books (id, data) VALUES (?, ?)").run(id, JSON.stringify(book));
  remember(id);
  return Response.json({ book: { ...getBook(id), id } });
}
