/** The library as the browser holds it, and the diff that is sent to the server when it changes. */

export type Kind = "book" | "audiobook" | "pdf" | "comic";

/** Best-match record from the online lookup. `v` is the lookup's version: older records are refreshed once. */
type Info = {
  rating?: number;
  ratings?: number;
  year?: number;
  pages?: number;
  genre?: string;
  v?: number;
};
export const INFO_VERSION = 2;
/** How a comic's pages are turned. */
export type PageMode = "ltr" | "rtl" | "scroll";

/** A book from an online catalogue that is not (yet) in this library. */
export type Found = {
  key: string; // Open Library work key, or `anilist:<id>` for manga
  title: string;
  author: string;
  year?: number;
  cover?: string; // image URL
  rating?: number;
  ratings?: number;
};

export type Mark = { at: string; label: string; added: number };
/** `color` is a key of the reader's highlight colours; without one it is yellow. */
export type Highlight = { cfi: string; text: string; note?: string; color?: string; added: number };

export type Book = {
  id: string;
  // Shared by everyone on the server.
  title: string;
  author: string;
  kind: Kind;
  cover: [string, string]; // gradient used until a real cover exists
  coverFile?: string; // stored name of the cover image
  added: string; // ISO date
  blurb?: string;
  info?: Info | null; // null = looked up, nothing found
  file?: string; // stored name in the server's library folder
  files?: { file: string; duration: number; name: string }[]; // audiobook files, in order
  chapters?: { title: string; start: number }[]; // audiobook chapters, seconds from the start
  duration?: number; // audiobook length in seconds
  narrator?: string;
  isbn?: string;
  series?: string;
  seriesIndex?: number; // position within the series
  tags?: string[];
  olKey?: string; // catalogue entry this was added from in Discover (Open Library work or `anilist:<id>`); such a book has no file
  rtl?: boolean; // comic whose file says it reads right to left
  // Per user.
  want?: boolean;
  finished?: string; // ISO date
  rating?: number;
  progress?: number; // 0–1
  mode?: PageMode; // comic page turning, when changed from the book's default
  position?: number; // audiobook playback position in seconds
  cfi?: string; // EPUB reading position
  page?: number; // PDF / comic page
  opened?: number; // epoch ms of the last read/listen
  bookmarks?: Mark[];
  highlights?: Highlight[];
};

type Collection = { id: string; name: string; bookIds: string[] };
type Layout = "Grid" | "List";
export const SORTS = ["Recent", "Title", "Author", "Manual"] as const;
type Sort = (typeof SORTS)[number];
export type ReaderPrefs = {
  fontSize: number;
  theme: "dark" | "dusk" | "sepia" | "light";
  /** A key of the reader's fonts; without one, the default. */
  font?: string;
  /** How much of the page's height the text takes, in percent: 100, 80, 60 or 40. */
  fill?: number;
  // Lighting, each in percent. Light and contrast rest at 100; warmth and grain at 0.
  light?: number;
  warmth?: number;
  grain?: number;
  contrast?: number;
  /** A gap between a comic's pages in the scrolling strip. On unless turned off. */
  gaps?: boolean;
};

export type Saved = {
  books: Book[]; // in the user's manual order
  log: Record<string, number>; // seconds read per local day
  collections: Collection[];
  layouts: Record<string, Layout>;
  sort: Sort;
  recents: string[]; // recent searches
  viewed: (string | Found)[]; // recently viewed: library book ids and catalogue books, newest first
  dailyGoal: number; // minutes
  yearlyGoal: number; // books
  lookups: boolean; // fetch covers, descriptions and ratings online
  stack: boolean; // collapse the books of a series into one stack on the library shelves
  share: boolean; // let the other people on the server see what this profile is reading
  reader: ReaderPrefs;
};

/** Book fields that belong to the signed-in user rather than to the server's copy of the book. */
export const USER_FIELDS = [
  "want",
  "finished",
  "rating",
  "progress",
  "position",
  "cfi",
  "page",
  "opened",
  "bookmarks",
  "highlights",
  "mode",
] as const;

/** Shared book fields a user may edit. Editing one locks it against online lookups. */
export const EDITABLE_FIELDS = ["title", "author", "blurb", "series", "seriesIndex", "tags", "kind"] as const;

/** Per-user settings, each replaced as a whole when it changes. */
export const PREF_KEYS = [
  "collections",
  "layouts",
  "sort",
  "recents",
  "viewed",
  "dailyGoal",
  "yearlyGoal",
  "lookups",
  "stack",
  "share",
  "reader",
] as const;

export const DEFAULT_PREFS: Pick<Saved, (typeof PREF_KEYS)[number]> = {
  collections: [],
  layouts: {},
  sort: "Manual",
  recents: [],
  viewed: [],
  dailyGoal: 5,
  yearlyGoal: 3,
  lookups: true,
  stack: false,
  share: true,
  reader: { fontSize: 100, theme: "dark" },
};

type Fields = Record<string, unknown>;
export type Batch = {
  /** Changed fields per book id; null removes a field. `info: null` asks for a fresh lookup. */
  books?: Record<string, { shared?: Fields; mine?: Fields }>;
  removed?: string[];
  prefs?: Fields; // includes `order`, the book ids in manual order
  time?: Record<string, number>; // seconds to ADD per day, so two devices never overwrite each other
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** What changed between two states, or null when nothing the server stores did. */
export function diff(prev: Saved, next: Saved): Batch | null {
  const batch: Batch = {};

  const before = new Map(prev.books.map((b) => [b.id, b]));
  for (const book of next.books) {
    const old: Fields | undefined = before.get(book.id);
    before.delete(book.id);
    if (!old || old === book) continue; // new books come from the server, never from here
    const now: Fields = book;
    const changed = (keys: readonly string[]) => {
      const out: Fields = {};
      for (const key of keys) if (!same(old[key], now[key])) out[key] = now[key] ?? null;
      return Object.keys(out).length ? out : undefined;
    };
    const mine = changed(USER_FIELDS);
    const shared = changed(EDITABLE_FIELDS);
    // Clearing the lookup result (after a title or author edit) asks the server to look it up again.
    const reset = old.info !== undefined && now.info === undefined;
    if (mine || shared || reset)
      (batch.books ??= {})[book.id] = {
        mine,
        shared: reset ? { ...shared, info: null } : shared,
      };
  }
  if (before.size) batch.removed = [...before.keys()];

  const prefs: Fields = {};
  for (const key of PREF_KEYS) if (!same(prev[key], next[key])) prefs[key] = next[key];
  const order = next.books.map((b) => b.id);
  if (!same(prev.books.map((b) => b.id), order)) prefs.order = order;
  if (Object.keys(prefs).length) batch.prefs = prefs;

  for (const [day, seconds] of Object.entries(next.log)) {
    const added = seconds - (prev.log[day] ?? 0);
    if (added > 0) (batch.time ??= {})[day] = added;
  }

  return Object.keys(batch).length ? batch : null;
}

/** Two batches as one: later fields win, reading time adds up. For changes that waited offline across visits. */
export function mergeBatch(first: Batch | null, then: Batch | null): Batch | null {
  if (!first || !then) return first ?? then;
  const books = { ...first.books };
  for (const [id, change] of Object.entries(then.books ?? {}))
    books[id] = {
      mine: { ...books[id]?.mine, ...change.mine },
      shared: { ...books[id]?.shared, ...change.shared },
    };
  const time = { ...first.time };
  for (const [day, seconds] of Object.entries(then.time ?? {})) time[day] = (time[day] ?? 0) + seconds;
  return {
    books,
    removed: [...new Set([...(first.removed ?? []), ...(then.removed ?? [])])],
    prefs: { ...first.prefs, ...then.prefs },
    time,
  };
}

/**
 * A state with a waiting batch's book and settings changes laid over it, so an offline visit
 * shows what was done on the last one. Reading time is left out: it is only ever sent as an addition.
 */
export function applyBatch(state: Saved, batch: Batch): Saved {
  const removed = new Set(batch.removed);
  const books = state.books
    .filter((b) => !removed.has(b.id))
    .map((b) => {
      const change = batch.books?.[b.id];
      if (!change) return b;
      const next: Fields = { ...b };
      for (const [key, value] of Object.entries({ ...change.shared, ...change.mine }))
        if (value === null) delete next[key];
        else next[key] = value;
      return next as Book;
    });
  const { order: _order, ...prefs } = batch.prefs ?? {};
  return { ...state, ...prefs, books };
}

/**
 * What someone reading without an account keeps outside the server (in the browser, and in a
 * folder they chose): everything that is theirs, so it can be put back if the server forgets them.
 */
export type Backup = {
  user: number; // the guest it was taken from
  books: Fields[]; // id, title and the per-user fields of each book that has any
  prefs: Fields;
  log: Record<string, number>;
};

export function backupOf(user: number, state: Saved): Backup {
  const books: Fields[] = [];
  for (const book of state.books) {
    const mine = Object.fromEntries(USER_FIELDS.flatMap((key) => (book[key] === undefined ? [] : [[key, book[key]]])));
    if (Object.keys(mine).length) books.push({ id: book.id, title: book.title, ...mine });
  }
  return {
    user,
    books,
    prefs: Object.fromEntries(PREF_KEYS.map((key) => [key, state[key]])),
    log: state.log,
  };
}

/** A state with a backup laid over it. Books the library no longer has are skipped. */
export function restore(state: Saved, backup: Backup): Saved {
  const kept = new Map(backup.books.map((b) => [b.id, b]));
  const log = { ...state.log };
  // The larger of the two, not the sum: restoring the same backup twice must not double the time.
  for (const [day, seconds] of Object.entries(backup.log ?? {})) log[day] = Math.max(log[day] ?? 0, seconds);
  return {
    ...state,
    ...Object.fromEntries(PREF_KEYS.flatMap((key) => (key in (backup.prefs ?? {}) ? [[key, backup.prefs[key]]] : []))),
    books: state.books.map((book) => {
      const { id: _id, title: _title, ...mine } = kept.get(book.id) ?? {};
      return { ...book, ...mine };
    }),
    log,
  };
}
