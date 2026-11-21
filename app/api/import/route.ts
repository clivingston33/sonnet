import { randomUUID } from "node:crypto";
import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { kindOf } from "../../formats";
import { authorize } from "../../server/auth";
import { LIBRARY_DIR } from "../../server/db";
import { saveBody } from "../../server/files";
import { ingest } from "../../server/ingest";

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 2048) * 1024 * 1024;

/**
 * PUT /api/import?name=<original file name>&upload=<id>&offset=<bytes>[&last=1], a piece of the
 * file as the body. Files arrive in pieces because the Cloudflare tunnel refuses any single
 * request over 100 MB. The piece marked `last` completes the file and returns the book it
 * became (see `ingest`).
 */
export async function PUT(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const params = new URL(req.url).searchParams;
  const name = params.get("name") ?? "";
  if (!kindOf(name) || !req.body)
    return Response.json({ error: "Unsupported file type" }, { status: 415 });
  const upload = params.get("upload") ?? "";
  const offset = Number(params.get("offset") ?? 0);
  if (!/^[0-9a-f]{32}$/.test(upload) || !Number.isSafeInteger(offset) || offset < 0)
    return Response.json({ error: "Bad upload" }, { status: 400 });
  const tooLarge = Response.json({ error: "File too large" }, { status: 413 });
  if (offset + Number(req.headers.get("content-length")) > MAX_BYTES) return tooLarge;

  // The unfinished file; the id comes from the client, so it is checked above and tied to the user.
  const part = path.join(LIBRARY_DIR, `upload-${user.id}-${upload}.part`);
  if (offset && ((await stat(part).catch(() => null))?.size ?? -1) < offset)
    return Response.json({ error: "Upload interrupted. Try again." }, { status: 409 });
  const saved = await saveBody(req, part, MAX_BYTES - offset, offset);
  if (saved !== "ok")
    return saved === "too-large" ? tooLarge : Response.json({ error: "Upload failed" }, { status: 500 });
  if (params.get("last") !== "1") return Response.json({ ok: true });

  // The client's name only supplies the (allow-listed) extension, never the path.
  const file = `${randomUUID()}.${name.split(".").pop()!.toLowerCase()}`;
  await rename(part, path.join(LIBRARY_DIR, file));
  return Response.json(await ingest(file, name));
}
