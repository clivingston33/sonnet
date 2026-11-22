import { authorizeAdmin } from "../../server/auth";
import { addFolder, folders, removeFolder, scan, scanState } from "../../server/folders";

/** GET: the library folders and how the scan of them is going. Admin only, like everything here. */
export async function GET(req: Request) {
  const user = authorizeAdmin(req);
  if (user instanceof Response) return user;
  return Response.json({ folders: folders(), scan: scanState() });
}

/** POST { action: "add" | "remove", path } or { action: "scan" }. Adding a folder scans it. */
export async function POST(req: Request) {
  const user = authorizeAdmin(req, true);
  if (user instanceof Response) return user;
  const body: Record<string, unknown> = await req.json().catch(() => ({}));
  const path = typeof body.path === "string" ? body.path : "";
  if (body.action === "add") {
    const error = await addFolder(path);
    if (error) return Response.json({ error }, { status: 400 });
  } else if (body.action === "remove") await removeFolder(path);
  else if (body.action !== "scan") return Response.json({ error: "Unknown action" }, { status: 400 });
  if (body.action !== "remove") scan();
  return Response.json({ folders: folders(), scan: scanState() });
}
