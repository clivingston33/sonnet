import { rm } from "node:fs/promises";
import path from "node:path";
import { authorize } from "../../server/auth";
import { COVER_DIR, STORED, getBook, patchBook } from "../../server/db";
import { filePath, saveCover, sendFile } from "../../server/files";

// Types the browser may display. Everything else is sent as a download.
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  epub: "application/epub+zip",
  mp3: "audio/mpeg",
  m4b: "audio/mp4",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** GET /api/file?file=<stored book file> or ?cover=<stored cover>. Signed-in users only. */
export async function GET(req: Request) {
  const user = authorize(req);
  if (user instanceof Response) return user;
  const query = new URL(req.url).searchParams;
  const cover = query.get("cover");
  const name = cover ?? query.get("file") ?? "";
  if (!STORED.test(name)) return new Response(null, { status: 400 });
  return sendFile(
    req,
    cover ? path.join(COVER_DIR, name) : filePath(name),
    TYPES[name.split(".").pop()!],
    // Stored names never change content, so covers can be cached for good.
    cover ? "private, max-age=31536000, immutable" : "private, no-cache",
  );
}

/** PUT /api/file?book=<id>, image as the body: sets the book's cover (used for a PDF's first page). */
export async function PUT(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const id = new URL(req.url).searchParams.get("book") ?? "";
  const book = getBook(id);
  if (!book) return new Response(null, { status: 404 });
  if (Number(req.headers.get("content-length")) > 10 * 1024 * 1024)
    return new Response(null, { status: 413 });
  const coverFile = await saveCover(new Uint8Array(await req.arrayBuffer()));
  if (!coverFile) return Response.json({ error: "Not an image" }, { status: 415 });
  if (typeof book.coverFile === "string" && STORED.test(book.coverFile))
    await rm(path.join(COVER_DIR, book.coverFile), { force: true });
  patchBook(id, { coverFile });
  return Response.json({ coverFile });
}
