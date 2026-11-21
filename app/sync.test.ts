// Run: node --test app/sync.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PREFS, diff, type Book, type Saved } from "./sync.ts";

const book = (id: string, extra: Partial<Book> = {}): Book => ({
  id,
  title: id,
  author: "A",
  kind: "book",
  cover: ["#000", "#111"],
  added: "2026-01-01",
  ...extra,
});
const state = (extra: Partial<Saved> = {}): Saved => ({
  ...DEFAULT_PREFS,
  books: [book("a"), book("b")],
  log: { "2026-01-01": 60 },
  ...extra,
});

test("no change, and books that only exist on one side, send nothing", () => {
  const s = state();
  assert.equal(diff(s, s), null);
  assert.equal(diff(s, { ...s, books: [...s.books] }), null);
  // an imported book arrives from the server: only the new order is sent
  assert.deepEqual(diff(s, { ...s, books: [...s.books, book("c")] }), {
    prefs: { order: ["a", "b", "c"] },
  });
});

test("book edits are split into shared and per-user fields; cleared fields become null", () => {
  const prev = state({ books: [book("a", { rating: 4, info: { rating: 3 } }), book("b")] });
  const next = {
    ...prev,
    books: [{ ...book("a"), title: "New", progress: 0.5 }, prev.books[1]],
  };
  assert.deepEqual(diff(prev, next), {
    books: {
      a: { mine: { rating: null, progress: 0.5 }, shared: { title: "New", info: null } },
    },
  });
});

test("removal, reorder, settings and added reading time", () => {
  const prev = state();
  const next = {
    ...prev,
    books: [prev.books[1]],
    dailyGoal: 20,
    log: { "2026-01-01": 75, "2026-01-02": 5 },
  };
  assert.deepEqual(diff(prev, next), {
    removed: ["a"],
    prefs: { dailyGoal: 20, order: ["b"] },
    time: { "2026-01-01": 15, "2026-01-02": 5 },
  });
});
