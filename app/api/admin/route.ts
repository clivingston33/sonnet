import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { authorize } from "../../server/auth";
import { COVER_DIR, DATA_DIR, LIBRARY_DIR, STORED, closeDb, db, patchBook, type BookData } from "../../server/db";
import { hashFile } from "../../server/files";
import { CONVERTER, nameMeta, readMeta, tidyComic, volumeOf } from "../../server/metadata";
import { scanWatched, setWatchedFolder, watchedFolder } from "../../server/watch";

const DB_FILE = path.join(DATA_DIR, "library.db");
const admin = (req: Request, write = false) => {
  const user = authorize(req, write);
  if (user instanceof Response) return user;
  return user.admin ? user : Response.json({ error: "Only the admin can do that." }, { status: 403 });
};

/**
 * GET: a backup as one zip: the database (accounts, shelves, progress, reviews) and the cover images.
 * The book files themselves are not in it; copy the library folder for those.
 */
export async function GET(req: Request) {
  const user = admin(req);
  if (user instanceof Response) return user;
  // A consistent copy even while the server is in use.
  const copy = path.join(tmpdir(), `library-backup-${Date.now()}.db`);
  db.prepare("VACUUM INTO ?").run(copy);
  // ponytail: built in memory; fine for a database and covers, not for the book files
  const zip = new JSZip();
  zip.file("library.db", await readFile(copy));
  await rm(copy, { force: true });
  for (const name of await readdir(COVER_DIR))
    if (STORED.test(name)) zip.file(`covers/${name}`, await readFile(path.join(COVER_DIR, name)));
  const body = await zip.generateAsync({ type: "uint8array" });
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="library-backup-${new Date().toLocaleDateString("sv")}.zip"`,
    },
  });
}

/** PUT, a backup zip as the body: replaces the database and covers with the backup's. */
export async function PUT(req: Request) {
  const user = admin(req, true);
  if (user instanceof Response) return user;
  const bad = (error: string) => Response.json({ error }, { status: 400 });
  if (Number(req.headers.get("content-length")) > 1024 ** 3) return bad("That file is too large to be a backup.");
  const zip = await JSZip.loadAsync(await req.arrayBuffer()).catch(() => null);
  const data = await zip?.file("library.db")?.async("uint8array");
  if (!zip || !data || Buffer.from(data.subarray(0, 15)).toString() !== "SQLite format 3")
    return bad("That isn’t a backup made by this app.");
  closeDb();
  // The write-ahead files belong to the database being replaced.
  for (const suffix of ["", "-wal", "-shm"]) await rm(DB_FILE + suffix, { force: true });
  await writeFile(DB_FILE, data);
  for (const entry of zip.file(/^covers\//)) {
    const name = path.posix.basename(entry.name);
    // Only names this app generates are written, so a crafted zip can't reach other paths.
    if (STORED.test(name)) await writeFile(path.join(COVER_DIR, name), await entry.async("uint8array"));
  }
  return Response.json({ ok: true });
}

/**
 * POST { action }:
 * - "watchInfo": the watched folder. "watch" { folder }: sets it ("" turns it off) and checks it.
 *   "scan": checks it now.
 * - anything else: goes over every book again with the current rules. Files are fingerprinted so
 *   later imports of the same file are recognised, comics filed as books move to Manga & Comics,
 *   and titles lose download-site and release tags. Details edited by hand are left alone.
 */
export async function POST(req: Request) {
  const user = admin(req, true);
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => ({}));
  if (body.action === "watchInfo") return Response.json({ folder: watchedFolder() });
  if (body.action === "watch") {
    const error = await setWatchedFolder(typeof body.folder === "string" ? body.folder.trim().slice(0, 1000) : "");
    if (error) return Response.json({ error }, { status: 400 });
    return Response.json({ folder: watchedFolder(), ...(await scanWatched()) });
  }
  if (body.action === "scan") return Response.json(await scanWatched());

  let changed = 0;
  const remember = db.prepare("INSERT OR IGNORE INTO files (hash, book_id) VALUES (?, ?)");
  for (const row of db.prepare("SELECT id, data FROM books").all()) {
    const id = String(row.id);
    const book: BookData = JSON.parse(String(row.data));
    const parts = Array.isArray(book.files) ? book.files.map((f) => (f as { file?: unknown }).file) : [];
    for (const file of new Set([book.file, ...parts]))
      if (typeof file === "string" && STORED.test(file))
        await hashFile(path.join(LIBRARY_DIR, file))
          .then((hash) => remember.run(hash, id))
          .catch(() => {}); // the file is gone; nothing to fingerprint

    const file = typeof book.file === "string" ? book.file : "";
    if (!file) continue;
    const locked = (book.locked ?? {}) as Record<string, unknown>;
    const patch: BookData = {};
    let kind = book.kind;
    if (kind === "book" && !locked.kind) {
      if (file.endsWith(".cbz")) kind = "comic";
      else if (file.endsWith(".epub")) {
        const meta = await readMeta(path.join(LIBRARY_DIR, file));
        if (meta.comic) {
          kind = "comic";
          patch.rtl = meta.rtl;
        }
      }
      if (kind === "comic") patch.kind = kind;
    }
    const title = String(book.title);
    const tidy = kind === "comic" ? tidyComic(title) : nameMeta(`${title}.x`).title;
    if (tidy && tidy !== title && !locked.title) patch.title = tidy;
    if (!locked.author) {
      const named = kind === "comic" ? undefined : nameMeta(`${title}.x`).author;
      if (book.author === "Unknown Author" && named) patch.author = named;
      if (kind === "comic" && CONVERTER.test(String(book.author))) patch.author = "Unknown Author";
    }
    if (kind === "comic" && !book.series && !locked.series) Object.assign(patch, volumeOf(tidy));
    if (!Object.keys(patch).length) continue;
    patchBook(id, { ...patch, info: null }); // looked up again under its new name
    changed++;
  }
  return Response.json({ changed });
}
