import { randomUUID } from "node:crypto";
import { copyFile, link, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { kindOf } from "../formats";
import { DATA_DIR, LIBRARY_DIR, db } from "./db";
import { ingest } from "./ingest";

/** The folder on the server that is checked for new books, or "" when none is set. */
export const watchedFolder = () =>
  String(db.prepare("SELECT value FROM settings WHERE key = 'watch'").get()?.value ?? "");

/** Sets (or with "" clears) the watched folder. Returns an error message, or null when it was accepted. */
export async function setWatchedFolder(folder: string) {
  if (folder) {
    const full = path.resolve(folder);
    if (!(await stat(full).catch(() => null))?.isDirectory()) return "That folder doesn’t exist on the server.";
    // The app's own folders would feed its copies back to it.
    for (const own of [LIBRARY_DIR, DATA_DIR])
      if (!path.relative(path.resolve(own), full).startsWith("..") || !path.relative(full, path.resolve(own)).startsWith(".."))
        return "Choose a folder outside the app’s own library and data folders.";
    folder = full;
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('watch', ?) ON CONFLICT DO UPDATE SET value = excluded.value",
  ).run(folder);
  return null;
}

async function walk(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && kindOf(entry.name)) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); // audiobook parts in order
}

const state = globalThis as typeof globalThis & { watchBusy?: boolean; watchTimer?: unknown };

/**
 * Brings every new or changed file in the watched folder into the library. The originals are
 * left where they are: each is hard-linked into the library folder (no extra disk space), or
 * copied when the two are on different drives.
 */
export async function scanWatched() {
  const folder = watchedFolder();
  if (!folder || state.watchBusy) return { added: 0, found: 0 };
  state.watchBusy = true;
  let added = 0;
  try {
    const files = await walk(folder);
    const seen = db.prepare("SELECT stamp FROM watched WHERE path = ?");
    const mark = db.prepare(
      "INSERT INTO watched (path, stamp) VALUES (?, ?) ON CONFLICT DO UPDATE SET stamp = excluded.stamp",
    );
    for (const source of files) {
      const info = await stat(source).catch(() => null);
      if (!info) continue;
      // A file still being copied in keeps changing; it is picked up on a later pass.
      if (Date.now() - info.mtimeMs < 10_000) continue;
      const stamp = `${info.size}:${Math.round(info.mtimeMs)}`;
      if (seen.get(source)?.stamp === stamp) continue;
      const stored = `${randomUUID()}${path.extname(source).toLowerCase()}`;
      const target = path.join(LIBRARY_DIR, stored);
      try {
        await link(source, target).catch(() => copyFile(source, target));
        const result = await ingest(stored, path.basename(source));
        if (!result.duplicate) added++;
        mark.run(source, stamp);
      } catch (e) {
        console.error(`Watched folder: couldn’t import ${source}:`, e);
      }
    }
    return { added, found: files.length };
  } finally {
    state.watchBusy = false;
  }
}

/** Checks the watched folder every five minutes for as long as the server runs. Safe to call repeatedly. */
export function startWatching() {
  state.watchTimer ??= setInterval(() => scanWatched().catch(() => {}), 5 * 60_000);
}
