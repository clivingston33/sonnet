import { randomUUID } from "node:crypto";
import path from "node:path";
import { kindOf } from "../../formats";
import { authorize } from "../../server/auth";
import { LIBRARY_DIR } from "../../server/db";
import { saveBody } from "../../server/files";
import { ingest } from "../../server/ingest";

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 2048) * 1024 * 1024;

/**
 * PUT /api/import?name=<original file name>, raw file as the body.
 * Stores the file and returns the book it became (see `ingest`).
 */
export async function PUT(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!kindOf(name) || !req.body)
    return Response.json({ error: "Unsupported file type" }, { status: 415 });
  const tooLarge = Response.json({ error: "File too large" }, { status: 413 });
  if (Number(req.headers.get("content-length")) > MAX_BYTES) return tooLarge;

  // The client's name only supplies the (allow-listed) extension, never the path.
  const file = `${randomUUID()}.${name.split(".").pop()!.toLowerCase()}`;
  const saved = await saveBody(req, path.join(LIBRARY_DIR, file), MAX_BYTES);
  if (saved !== "ok")
    return saved === "too-large" ? tooLarge : Response.json({ error: "Upload failed" }, { status: 500 });
  return Response.json(await ingest(file, name));
}
