import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { kindOf } from "../../formats";

const DIR = process.env.LIBRARY_DIR ?? path.join(process.cwd(), "library");
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 2048) * 1024 * 1024;

/** Only names this route generated are ever read or deleted, so a request can't reach other paths. */
const STORED = /^[0-9a-f-]{36}\.[a-z0-9]+$/;

// Everything else is sent as a download, so an uploaded file can never run as a page on this origin.
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
};

// ponytail: there are no accounts yet, so anyone on the network can still import and
// delete. This only stops other websites from doing it through a visitor's browser.
function crossSite(req: Request) {
  const origin = req.headers.get("origin");
  return !!origin && new URL(origin).host !== req.headers.get("host");
}

/** PUT /api/import?name=<original file name>, raw file as the body. Streams to LIBRARY_DIR. */
export async function PUT(req: Request) {
  if (crossSite(req)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!kindOf(name) || !req.body)
    return Response.json({ error: "Unsupported file type" }, { status: 415 });
  const tooLarge = Response.json({ error: "File too large" }, { status: 413 });
  if (Number(req.headers.get("content-length")) > MAX_BYTES) return tooLarge;

  // The client's name only supplies the (allow-listed) extension, never the path.
  const file = `${randomUUID()}.${name.split(".").pop()!.toLowerCase()}`;
  const target = path.join(DIR, file);
  await mkdir(DIR, { recursive: true });
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      done(size > MAX_BYTES ? new Error("File too large") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as never), limit, createWriteStream(target));
  } catch {
    await rm(target, { force: true }); // don't leave a truncated file behind
    return size > MAX_BYTES
      ? tooLarge
      : Response.json({ error: "Upload failed" }, { status: 500 });
  }
  return Response.json({ file });
}

/** GET /api/import?file=<stored name>. Supports Range so audio can seek. */
export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file") ?? "";
  if (!STORED.test(file)) return new Response(null, { status: 400 });
  const target = path.join(DIR, file);
  const info = await stat(target).catch(() => null);
  if (!info) return new Response(null, { status: 404 });

  const type = TYPES[file.split(".").pop()!];
  const headers: Record<string, string> = {
    "Content-Type": type ?? "application/octet-stream",
    "Content-Disposition": type ? "inline" : "attachment",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
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

/** DELETE /api/import?file=<stored name>. */
export async function DELETE(req: Request) {
  if (crossSite(req)) return new Response(null, { status: 403 });
  const file = new URL(req.url).searchParams.get("file") ?? "";
  if (!STORED.test(file)) return new Response(null, { status: 400 });
  await rm(path.join(DIR, file), { force: true });
  return new Response(null, { status: 204 });
}
