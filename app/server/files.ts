import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COVER_DIR, LIBRARY_DIR, db } from "./db";

/**
 * Where the book file with this stored name is: among the uploads, or where it lay when a
 * library folder was scanned. Requests only ever name files by stored name, so this is the one
 * place a path outside the app's own folders can come from, and only the admin's folders get in.
 */
export function filePath(name: string) {
  const linked = db.prepare("SELECT path FROM linked WHERE name = ?").get(name)?.path;
  return linked ? String(linked) : path.join(LIBRARY_DIR, name);
}

/**
 * Deletes an uploaded book file. A file in a library folder is its owner's and is left alone;
 * it stays linked, so the next scan doesn't bring the book straight back.
 */
export async function removeFile(name: string) {
  if (db.prepare("SELECT 1 FROM linked WHERE name = ?").get(name)) return;
  await rm(path.join(LIBRARY_DIR, name), { force: true });
}

/** SHA-256 of a file, read as a stream so audiobooks of any size are fine. */
export async function hashFile(target: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Streams a request body to `target`, refusing anything over `maxBytes`. Removes the partial file on failure.
 * `from` > 0 writes the body at that offset of a file that already exists (the next piece of an upload).
 */
export async function saveBody(req: Request, target: string, maxBytes: number, from = 0) {
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      done(size > maxBytes ? new Error("too large") : null, chunk);
    },
  });
  try {
    const out = createWriteStream(target, from ? { flags: "r+", start: from } : {});
    await pipeline(Readable.fromWeb(req.body as never), limit, out);
    return "ok" as const;
  } catch {
    await rm(target, { force: true });
    return size > maxBytes ? ("too-large" as const) : ("failed" as const);
  }
}

/** Sends a stored file, honouring Range so audio and PDFs can seek. `type` undefined = download only. */
export async function sendFile(req: Request, target: string, type: string | undefined, cache: string) {
  const info = await stat(target).catch(() => null);
  if (!info) return new Response(null, { status: 404 });
  const headers: Record<string, string> = {
    "Content-Type": type ?? "application/octet-stream",
    // Anything without a known type is a download, so an uploaded file can never run as a page here.
    "Content-Disposition": type ? "inline" : "attachment",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
  };
  const send = (status: number, start: number, end: number) =>
    new Response(Readable.toWeb(createReadStream(target, { start, end })) as never, {
      status,
      headers: { ...headers, "Content-Length": String(end - start + 1) },
    });

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (!range || (!range[1] && !range[2])) return send(200, 0, info.size - 1);
  // "a-b", "a-" (to the end) or "-n" (the last n bytes)
  const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
  if (start > end)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${info.size}` },
    });
  headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  return send(206, start, end);
}

/** The image type of `data` by its first bytes, or undefined when it isn't a supported image. */
function imageExt(data: Uint8Array) {
  const hex = Buffer.from(data.subarray(0, 12)).toString("hex");
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("47494638")) return "gif";
  if (hex.startsWith("52494646") && hex.slice(16) === "57454250") return "webp";
}

/** Stores a cover image and returns its stored name, or undefined when `data` is not an image. */
export async function saveCover(data: Uint8Array) {
  const ext = imageExt(data);
  if (!ext || data.length > 10 * 1024 * 1024) return;
  const name = `${randomUUID()}.${ext}`;
  await writeFile(path.join(COVER_DIR, name), data);
  return name;
}
