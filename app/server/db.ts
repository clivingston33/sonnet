import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Database and cover images. Back this folder up together with LIBRARY_DIR. */
export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
/** The imported book and audio files. */
export const LIBRARY_DIR = process.env.LIBRARY_DIR ?? path.join(process.cwd(), "library");
export const COVER_DIR = path.join(DATA_DIR, "covers");

/** Only names the server generated are ever opened or deleted, so a request can't reach other paths. */
export const STORED = /^[0-9a-f-]{36}\.[a-z0-9]+$/;

function open() {
  mkdirSync(COVER_DIR, { recursive: true });
  mkdirSync(LIBRARY_DIR, { recursive: true });
  // Wait instead of failing when another process (a backup, a second server) holds the lock.
  const db = new DatabaseSync(path.join(DATA_DIR, "library.db"), { timeout: 5000 });
  // Book metadata is shared by everyone on the server; shelves, ratings, progress,
  // goals and reading time belong to a user. JSON columns are updated with json_patch,
  // so two devices changing different fields of the same row don't overwrite each other.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      first TEXT NOT NULL,
      last TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0,
      prefs TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      expires INTEGER NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reviews (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      hash TEXT PRIMARY KEY, -- SHA-256 of an imported file, so the same file isn't stored twice
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shared_shelves (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      owner INTEGER REFERENCES users(id) ON DELETE SET NULL,
      books TEXT NOT NULL DEFAULT '[]' -- book ids, in the order they were added
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      PRIMARY KEY (to_user, from_user, book_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_books (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS reading_days (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      seconds REAL NOT NULL,
      PRIMARY KEY (user_id, day)
    );
  `);
  // Columns added after the first release; older databases lack them.
  for (const column of [
    "owner INTEGER REFERENCES users(id) ON DELETE CASCADE", // profiles: shares the owner's sign-in
    "pin TEXT", // optional profile PIN, hashed like a password
  ])
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
    } catch {
      // already there
    }
  return db;
}

// Dev hot-reload re-evaluates this module; keep one connection per process.
const holder = globalThis as typeof globalThis & { libraryDb?: DatabaseSync };
/** Opened on first use, not on import: `next build` imports every route in parallel workers. */
export const db = {
  prepare: (sql: string) => (holder.libraryDb ??= open()).prepare(sql),
};
/** Closes the database so its file can be replaced (restore); the next query opens it again. */
export function closeDb() {
  holder.libraryDb?.close();
  holder.libraryDb = undefined;
}

/** Shared (per-server) fields of a book as stored in `books.data`. */
export type BookData = Record<string, unknown>;

export function getBook(id: string): BookData | null {
  const row = db.prepare("SELECT data FROM books WHERE id = ?").get(id);
  return row ? (JSON.parse(String(row.data)) as BookData) : null;
}

/** Merges fields into a book (RFC 7396: a null value removes the key). */
export function patchBook(id: string, patch: BookData) {
  db.prepare("UPDATE books SET data = json_patch(data, ?) WHERE id = ?").run(
    JSON.stringify(patch),
    id,
  );
}
