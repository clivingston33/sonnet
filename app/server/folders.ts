import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { kindOf } from "../formats";
import { DATA_DIR, LIBRARY_DIR, db, type BookData } from "./db";
import { deleteBook, ingest } from "./ingest";

/**
 * Library folders: folders on the server's own disk that the admin points the library at, as in
 * Jellyfin. Their files are read where they lie, never copied, changed or deleted. Each file found
 * gets a stored name (the `linked` table), and under that name the rest of the app treats it
 * exactly like an uploaded file.
 */
export const folders = (): string[] =>
  JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key = 'folders'").get()?.value ?? "[]"));

const save = (list: string[]) =>
  db
    .prepare("INSERT INTO settings (key, value) VALUES ('folders', ?) ON CONFLICT DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(list));

/** True when `file` is `folder` itself or anywhere under it. */
const inside = (folder: string, file: string) => {
  const rel = path.relative(folder, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Adds a folder to the library. Returns what is wrong with it, or null. */
export async function addFolder(input: string) {
  if (!input.trim()) return "Enter the folder’s path.";
  const folder = path.resolve(input.trim());
  if (!(await stat(folder).catch(() => null))?.isDirectory())
    return "The server can’t find that folder. It must be on the computer the server runs on.";
  // Its own storage scanned as a library would list every uploaded book twice.
  if ([LIBRARY_DIR, DATA_DIR].some((own) => inside(path.resolve(own), folder) || inside(folder, path.resolve(own))))
    return "That folder is where Sonnet keeps its own files. Choose the folder your books are in.";
  const list = folders();
  if (list.some((f) => inside(f, folder))) return "That folder is already in the library.";
  save([...list.filter((f) => !inside(folder, f)), folder]); // it takes over any folder inside it
  return null;
}

/** Takes a folder out of the library, and with it the books that came from it. The files stay. */
export async function removeFolder(folder: string) {
  save(folders().filter((f) => f !== folder));
  const gone = new Set(
    db
      .prepare("SELECT name, path FROM linked")
      .all()
      .filter((row) => inside(folder, String(row.path)))
      .map((row) => String(row.name)),
  );
  for (const row of db.prepare("SELECT id, data FROM books").all()) {
    const book: BookData = JSON.parse(String(row.data));
    const parts = Array.isArray(book.files) ? book.files.map((f) => (f as { file?: unknown }).file) : [];
    if ([book.file, ...parts].some((file) => typeof file === "string" && gone.has(file)))
      await deleteBook(String(row.id), book);
  }
  // Forgotten, so adding the folder again brings every book in it back, removed ones too.
  for (const name of gone) db.prepare("DELETE FROM linked WHERE name = ?").run(name);
}

const state = { running: false, added: 0, last: 0 };
/** How the scan is going: `added` counts the books of the scan running now, or of the last one. */
export const scanState = () => ({ ...state });

/**
 * Looks through the library folders for files it hasn't seen and adds them as books. Runs in the
 * background: a first scan hashes and reads every file, which takes a while for audiobooks.
 * ponytail: a file deleted from a folder keeps its book until the book is removed by hand;
 * check `linked` paths here and drop the missing ones if that proves annoying.
 */
export function scan() {
  if (state.running) return;
  state.running = true;
  state.added = 0;
  const known = db.prepare("SELECT 1 FROM linked WHERE path = ?");
  const link = db.prepare("INSERT INTO linked (name, path) VALUES (?, ?)");
  (async () => {
    for (const folder of folders()) {
      // A folder that is unplugged or unreadable right now is skipped, not an error.
      const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !kindOf(entry.name)) continue;
        const file = path.join(entry.parentPath, entry.name);
        if (known.get(file)) continue;
        const name = `${randomUUID()}.${entry.name.split(".").pop()!.toLowerCase()}`;
        link.run(name, file);
        // A file that can't be read stays linked, so it is not tried again on every scan.
        const result = await ingest(name, entry.name).catch(() => null);
        if (result && !result.duplicate) state.added++;
      }
    }
  })().finally(() => {
    state.running = false;
    state.last = Date.now();
  });
}

/** Scans again when the last scan is old: called when someone opens the library. */
export function scanIfStale() {
  if (Date.now() - state.last > 15 * 60_000 && folders().length) scan();
}
