"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { Book as EpubBook, Location, Rendition } from "epubjs";
import { ACCEPT, AUDIO, EBOOK, kindOf } from "./formats";
import { addSession, clock, dayKey, streaks } from "./reading";

type Kind = "book" | "audiobook" | "pdf";

/** Best-match Open Library record. */
type Info = { rating?: number; ratings?: number; year?: number; pages?: number };

type Book = {
  id: string;
  title: string;
  author: string;
  kind: Kind;
  cover: [string, string]; // placeholder gradient
  added: string; // ISO date
  want?: boolean;
  finished?: string; // ISO date
  rating?: number;
  isNew?: boolean;
  cloud?: boolean;
  blurb?: string;
  info?: Info | null; // null = looked up, nothing found
  file?: string; // stored name in the server's library folder
  series?: string;
  seriesIndex?: number; // position within the series
  tags?: string[];
  progress?: number; // 0–1; set by the audio player and the EPUB reader, or by hand
  position?: number; // audiobook playback position in seconds
  cfi?: string; // EPUB reading position
  opened?: number; // epoch ms of the last read/listen, orders Continue Reading
};

type Collection = { id: string; name: string; bookIds: string[] };
type Layout = "Grid" | "List";

const SORTS = ["Recent", "Title", "Author", "Manual"] as const;
type Sort = (typeof SORTS)[number];

type Saved = {
  books: Book[];
  collections: Collection[];
  layouts: Record<string, Layout>;
  sort: Sort;
  recents: string[];
  dailyGoal: number; // minutes
  yearlyGoal: number; // books
  log: Record<string, number>; // seconds read per local day
  lookups: boolean; // fetch other readers' ratings from Open Library
};

// Set in .env.local; replaced by the signed-in account once auth exists.
const USER = process.env.NEXT_PUBLIC_USER_NAME;

// ponytail: library state lives in localStorage until the server backend exists.
const STORAGE_KEY = "library-v1";

const INITIAL: Saved = {
  collections: [],
  layouts: {},
  sort: "Manual",
  recents: [],
  dailyGoal: 5,
  yearlyGoal: 3,
  log: {},
  lookups: true,
  // Placeholder data until the backend exists.
  books: [
    {
      id: "nophek",
      title: "Nophek Gloss",
      author: "Essa Hansen",
      kind: "book",
      cover: ["#23254d", "#07070c"],
      added: "2026-11-10",
      finished: "2026-11-15",
      isNew: true,
      cloud: true,
    },
    {
      id: "children",
      title: "Children of Time",
      author: "Adrian Tchaikovsky",
      kind: "book",
      cover: ["#2f9d5c", "#04201f"],
      added: "2026-11-12",
      finished: "2026-11-18",
      isNew: true,
      cloud: true,
    },
    {
      id: "dune",
      title: "Dune",
      progress: 0.35,
      author: "Frank Herbert",
      kind: "book",
      cover: ["#f0a030", "#8a3a14"],
      added: "2026-11-14",
      want: true,
      blurb:
        "Without Frank Herbert’s fantastical and foreboding masterpiece, there might never have been A Game of Thrones. His epic went beyond the whiz-bang space operatics of robots and rocket ships to present a cast of compelling, fully realized characters at each other’s throats over wealth, territory, and drugs. Set on the parched planet of Arrakis, Dune mixes Machiavellian intrigue, complex systems of religion, politics, and power, and an ecological message that still resonates today. The saga of Paul Atreides—a young, exiled prince destined to become a messianic leader—expanded readers’ notions of what science fiction could deliver and inspired writers and filmmakers to match Herbert’s enthralling vision of the future.",
    },
    {
      id: "sunrise",
      title: "Sunrise on the Reaping (The Hunger Games)",
      author: "Suzanne Collins",
      kind: "book",
      cover: ["#e9e6dc", "#aeb3a6"],
      added: "2026-11-16",
      want: true,
      finished: "2026-11-20",
      blurb:
        "Prepare to dive headfirst once again into the dystopian nation of Panem for this profound prequel to the Hunger Games series. The novel takes us back to the 50th Hunger Games competition, where we meet Katniss and Peeta’s mentor, Haymitch Abernathy. He’s just a young man from District 12 when he’s pulled into the games on his 16th birthday, changing his life forever. Suzanne Collins brilliantly uses this novel’s placement in the series to explore the true impact of the tragic events that follow. After all, we already know that Haymitch will win—and that it will cost him absolutely everything. That preordained aspect of the tale fills each twist with brutally profound meaning, not to mention tension and dread. And the series’ themes of censorship and propaganda become especially strong as key events unfold that we realize were erased from Panem’s history. We were completely immersed in this grim, gorgeously rendered world.",
    },
    {
      id: "attention",
      title: "Attention Is All You Need",
      author: "Vaswani et al.",
      kind: "pdf",
      cover: ["#f4f4f1", "#f4f4f1"],
      added: "2026-11-19",
    },
    {
      id: "dune-audio",
      title: "Dune",
      author: "Frank Herbert",
      kind: "audiobook",
      cover: ["#f0a030", "#7a2f3a"],
      added: "2026-11-20",
      isNew: true,
    },
  ],
};

const KIND_LABEL: Record<Kind, string> = {
  book: "Book",
  audiobook: "Audiobook",
  pdf: "PDF",
};

const FILTERS: Record<string, (b: Book) => boolean> = {
  all: () => true,
  want: (b) => !!b.want,
  finished: (b) => !!b.finished,
  books: (b) => b.kind === "book",
  audiobooks: (b) => b.kind === "audiobook",
  pdfs: (b) => b.kind === "pdf",
};

const EMPTY: Record<string, [string, string]> = {
  all: ["No Books", "Books, audiobooks and PDFs you add to your library will appear here."],
  want: ["No Books", "To add to Want to Read, choose Add to Want to Read from a book menu."],
  finished: ["No Books", "To add to Finished, choose Mark as Finished from a book menu."],
  books: ["No Books", "Books in your library will automatically be added to this shelf."],
  audiobooks: ["No Audiobooks", "Audiobooks in your library will automatically be added to this shelf."],
  pdfs: ["No PDFs", "PDFs in your library will automatically be added to this shelf."],
  collection: ["No Books", "To add to this shelf, choose Add to Shelf from a book or audiobook menu."],
};

const newestFirst = (a: Book, b: Book) => b.added.localeCompare(a.added);
const bySeriesIndex = (a: Book, b: Book) => (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9);
const compact = new Intl.NumberFormat("en", { notation: "compact" }).format;

// ponytail: title/author search from the browser, so it can pick the wrong edition;
// move server-side and match on ISBN once files are ingested.
async function lookup(b: Book): Promise<Info | null> {
  const query = new URLSearchParams({
    title: b.title.replace(/\s*\(.*\)$/, ""),
    limit: "1",
    fields: "ratings_average,ratings_count,first_publish_year,number_of_pages_median",
  });
  if (b.author !== UNKNOWN_AUTHOR) query.set("author", b.author);
  const res = await fetch(`https://openlibrary.org/search.json?${query}`);
  if (!res.ok) throw new Error(`Open Library ${res.status}`);
  const doc = (await res.json()).docs?.[0];
  if (!doc) return null;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    rating: num(doc.ratings_average),
    ratings: num(doc.ratings_count),
    year: num(doc.first_publish_year),
    pages: num(doc.number_of_pages_median),
  };
}

type DetailState = { ids: string[]; id: string }; // ids = the list the arrows step through

type Lib = {
  s: Saved;
  set: (fn: (prev: Saved) => Partial<Saved>) => void;
  patch: (id: string, p: Partial<Book>) => void;
  newCollection: (bookId?: string) => void;
  toggleWant: (b: Book) => void;
  toggleFinished: (b: Book) => void;
  toast: (title: string, text: string) => void;
  setView: (view: string) => void;
  setDetail: (d: DetailState | null) => void;
  openImport: () => void;
  importFiles: (files: File[]) => void;
  /** Drag-to-reorder props for a book's element; empty unless the shelf is in Manual sort. */
  drag: (id: string) => HTMLAttributes<HTMLDivElement>;
  /** True when the open shelf is in Manual sort and can be reordered. */
  sortable: boolean;
  /** Keyboard/touch alternative to dragging: swap with the previous or next book on the shelf. */
  move: (id: string, by: -1 | 1) => void;
  play: (id: string) => void;
  edit: (id: string) => void;
  /** Opens a file in the in-app reader (EPUB, PDF, text). */
  read: (id: string) => void;
};
const LibCtx = createContext<Lib>(null!);

const ICONS = {
  x: "M6 6l12 12M18 6 6 18",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 21 21",
  home: "M4 10.5 12 4l8 6.5V20h-5.500v-5.500h-5V20H4Z",
  headphones:
    "M4 15v-3a8 8 0 0 1 16 0v3M4 14.500h2.500V20H6a2 2 0 0 1-2-2ZM20 14.500h-2.500V20H18a2 2 0 0 0 2-2Z",
  shelf: "M4 5h4v15H4ZM8 8h4v12H8ZM13.500 6.500l3.500-1 3.500 13.500-3.500 1Z",
  want: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12h8M13 9l3 3-3 3",
  minus: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12h8",
  finished: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.500l2.700 2.700L16 9.500",
  book: "M12 7C10 5.500 7 5 3 5.500V18c4-.5 7 0 9 1.500 2-1.500 5-2 9-1.500V5.500C17 5 14 5.500 12 7ZM12 7v12.500",
  doc: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v5h5M9 13h6M9 16.500h6",
  lines: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
  cloud:
    "M7 18a4 4 0 0 1-.5-7.970A5.500 5.500 0 0 1 17.200 9.500 4.300 4.300 0 0 1 17 18Z",
  chevronDown: "M6 9l6 6 6-6",
  check: "M5 12.500l4.500 4.500L19 7",
  grid: "M5 5h5v5H5ZM14 5h5v5h-5ZM5 14h5v5H5ZM14 14h5v5h-5Z",
  list: "M9 7h11M9 12h11M9 17h11M4.500 7h.01M4.500 12h.01M4.500 17h.01",
  trash: "M5 7h14M10 7V4.500h4V7M7 7l1 13h8l1-13",
  star: "M12 3.500l2.600 5.400 5.900.8-4.300 4.100 1 5.900L12 16.900l-5.200 2.800 1-5.900L3.500 9.700l5.900-.8Z",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4",
  import: "M12 4v10M8 10l4 4 4-4M5 18h14",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.7.4-1 .9-1 1.700M12 16.500h.01",
  logout: "M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M14 8l4 4-4 4M18 12H9",
  tag: "M4 4h7l9 9-7 7-9-9ZM8 8h.01",
  play: "M7 5v14l12-7Z",
  pause: "M8 5v14M16 5v14",
  moon: "M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500Z",
  chart: "M5 20V10M12 20V4M19 20v-7",
  pencil: "M4 20h4L19 9l-4-4L4 16ZM13.500 6.500l4 4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.500 20a7.500 7.500 0 0 1 15 0",
};
type IconName = keyof typeof ICONS;

function Icon({
  name,
  className = "size-[22px]",
  fill = "none",
  strokeWidth = 1.7,
}: {
  name: IconName;
  className?: string;
  fill?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

const DOTS = (
  <svg viewBox="0 0 18 6" className="w-[18px]" fill="currentColor" aria-hidden>
    <circle cx="3" cy="3" r="1.7" />
    <circle cx="9" cy="3" r="1.7" />
    <circle cx="15" cy="3" r="1.7" />
  </svg>
);

/** Button that toggles a floating menu; any click inside or outside the menu closes it. */
function Popover({
  label,
  button,
  buttonClass,
  panelClass,
  children,
}: {
  label: string;
  button: ReactNode;
  buttonClass: string;
  panelClass: string; // position + width
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      <button
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`relative ${open ? "z-30" : ""} ${buttonClass}`}
      >
        {button}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            role="menu"
            onClick={() => setOpen(false)}
            className={`absolute z-30 rounded-xl border border-white/15 bg-[#222] p-[5px] font-sans font-normal text-[#f2f2f2] shadow-2xl ${panelClass}`}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}

/** `checked` (even false) reserves the checkmark gutter so a group of items lines up. */
function MenuItem({
  label,
  icon,
  checked,
  onClick,
}: {
  label: string;
  icon?: IconName;
  checked?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex h-[25.500px] w-full items-center rounded-lg px-[6px] text-left text-[13px] hover:bg-white/10"
    >
      {checked !== undefined && (
        <span className="w-[22px]">
          {checked && <Icon name="check" className="size-[14px]" strokeWidth={2.4} />}
        </span>
      )}
      {icon && (
        <span className="w-[22px] text-[#b4b4b4]">
          <Icon name={icon} className="size-[14px]" />
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

const MENU_RULE = <hr className="mx-2 my-[5px] border-white/10" />;

function BookMenu({ book, align = "right-0" }: { book: Book; align?: string }) {
  const { s, set, toggleWant, toggleFinished, toast, newCollection, edit, sortable, move } =
    useContext(LibCtx);
  return (
    <Popover
      label={`Options for ${book.title}`}
      button={DOTS}
      buttonClass="block py-1 text-[#b4b4b4] hover:text-white"
      // ponytail: opens downward only; flip upward near the viewport bottom if it gets annoying
      panelClass={`top-5 ${align} w-[230px]`}
    >
      <MenuItem
        icon={book.want ? "minus" : "want"}
        label={book.want ? "Remove from Want to Read" : "Add to Want to Read"}
        onClick={() => toggleWant(book)}
      />
      <MenuItem
        icon="finished"
        label={book.finished ? "Mark as Unfinished" : "Mark as Finished"}
        onClick={() => toggleFinished(book)}
      />
      <MenuItem icon="pencil" label="Edit Details…" onClick={() => edit(book.id)} />
      {sortable && (
        <>
          <MenuItem icon="chevronLeft" label="Move Earlier" onClick={() => move(book.id, -1)} />
          <MenuItem icon="chevronRight" label="Move Later" onClick={() => move(book.id, 1)} />
        </>
      )}
      {MENU_RULE}
      <p className="px-[6px] pt-1 pb-[3px] text-[11px] font-bold text-[#777]">
        Add to Shelf
      </p>
      {s.collections.map((c) => (
        <MenuItem
          key={c.id}
          label={c.name}
          checked={c.bookIds.includes(book.id)}
          onClick={() => {
            const has = c.bookIds.includes(book.id);
            set((prev) => ({
              collections: prev.collections.map((x) =>
                x.id !== c.id
                  ? x
                  : {
                      ...x,
                      bookIds: has
                        ? x.bookIds.filter((id) => id !== book.id)
                        : [...x.bookIds, book.id],
                    },
              ),
            }));
            toast(
              has ? "Removed" : "Added",
              `“${book.title}” was ${has ? "removed from" : "added to"} ${c.name}.`,
            );
          }}
        />
      ))}
      <MenuItem
        icon="plus"
        label="New Shelf"
        onClick={() => newCollection(book.id)}
      />
      {MENU_RULE}
      <MenuItem
        icon="trash"
        label="Remove…"
        onClick={() => {
          const warning = book.file ? " Its file will be deleted from the server." : "";
          if (!confirm(`Remove “${book.title}” from your library?${warning}`)) return;
          // ponytail: a failed delete just leaves an orphan file in the library folder
          if (book.file)
            fetch(`/api/import?file=${book.file}`, { method: "DELETE" }).catch(() => {});
          set((prev) => ({
            books: prev.books.filter((b) => b.id !== book.id),
            collections: prev.collections.map((c) => ({
              ...c,
              bookIds: c.bookIds.filter((id) => id !== book.id),
            })),
          }));
        }}
      />
    </Popover>
  );
}

/** Click a star to rate; click it again for half a star less; a third click clears the rating. */
function Stars({ book, className }: { book: Book; className: string }) {
  const { patch } = useContext(LibCtx);
  const rating = book.rating ?? 0;
  return (
    <div className="flex" aria-label={rating ? `Your rating: ${rating} of 5` : "Not rated"}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = Math.min(1, Math.max(0, rating - (n - 1))); // 0, 0.5 or 1 of this star
        return (
          <button
            key={n}
            aria-label={`Rate ${n} of 5`}
            onClick={() =>
              patch(book.id, {
                rating: rating === n ? n - 0.5 : rating === n - 0.5 ? undefined : n,
              })
            }
            className="relative text-[#8c8c8c] hover:text-white"
          >
            <Icon name="star" className={className} strokeWidth={1.4} />
            <span
              className="absolute inset-0 text-white"
              style={{ clipPath: `inset(0 ${100 - filled * 100}% 0 0)` }}
            >
              <Icon name="star" className={className} strokeWidth={1.4} fill="currentColor" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Placeholder cover art: ebooks and PDFs are always 2:3, audiobooks square. */
function Cover({ book, w }: { book: Book; w: number }) {
  const size = {
    width: w,
    height: book.kind === "audiobook" ? w : w * 1.5,
    fontSize: w * 0.07,
  };
  const frame =
    "relative flex shrink-0 flex-col overflow-hidden rounded-[2px] shadow-[0_8px_18px_rgba(0,0,0,0.55)]";

  // Stand-in for the rendered first page of the PDF.
  if (book.kind === "pdf")
    return (
      <div
        className={`${frame} gap-[0.5em] bg-[#f4f4f1] px-[1.4em] py-[2em] text-[#222]`}
        style={size}
      >
        <span className="text-center font-serif font-bold leading-tight">
          {book.title}
        </span>
        <span className="mb-[0.6em] text-center text-[0.6em]">{book.author}</span>
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="h-px shrink-0 bg-black/20" />
        ))}
      </div>
    );

  const light = book.cover[0] > "#c"; // crude: light placeholder gets dark text
  return (
    <div
      className={`${frame} items-center justify-between px-[0.6em] py-[1.15em] text-center ${light ? "text-[#2b3140]" : "text-white/90"}`}
      style={{
        ...size,
        background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})`,
      }}
    >
      <span className="absolute inset-y-0 left-0 w-[3%] bg-gradient-to-r from-white/25 to-transparent" />
      <span className="mt-[2.5em] font-semibold uppercase leading-snug tracking-[0.18em]">
        {book.title}
      </span>
      <span className="text-[0.6em] font-medium uppercase tracking-[0.2em]">
        {book.author}
      </span>
    </div>
  );
}

/** Read-only average from other readers (Open Library). */
function CommunityRating({ book }: { book: Book }) {
  const { rating, ratings = 0 } = book.info ?? {};
  if (!rating)
    return <p className="text-[13px] text-[#8c8c8c]">No ratings yet</p>;
  return (
    <div
      className="flex items-center gap-1"
      aria-label={`Rated ${rating.toFixed(1)} of 5 by ${ratings} readers`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="relative">
          <Icon name="star" className="size-5" strokeWidth={1.4} />
          <span
            className="absolute inset-0"
            style={{
              clipPath: `inset(0 ${100 - Math.min(1, Math.max(0, rating - i)) * 100}% 0 0)`,
            }}
          >
            <Icon name="star" className="size-5" fill="currentColor" />
          </span>
        </span>
      ))}
      <span className="text-[13px] text-[#a0a0a0]">({compact(ratings)})</span>
    </div>
  );
}

/** With `group`, two or more books of one series collapse into a stack that opens the series. */
function Grid({ books, group = false }: { books: Book[]; group?: boolean }) {
  const { drag, setView } = useContext(LibCtx);
  const ids = books.map((b) => b.id);
  return (
    <div className="flex flex-wrap items-end gap-x-[27px] gap-y-10 max-md:[zoom:0.86]">
      {books.map((b) => {
        const stack = group && b.series ? books.filter((x) => x.series === b.series) : [];
        if (stack.length > 1) {
          if (stack[0] !== b) return null; // one stack per series, where its first book sits
          return (
            <button
              key={b.id}
              onClick={() => setView(`s:${b.series}`)}
              className="w-[188px] text-left"
            >
              <div className="relative">
                <span className="absolute inset-x-4 -top-[10px] h-4 rounded-[2px] bg-white/10" />
                <span className="absolute inset-x-2 -top-[5px] h-4 rounded-[2px] bg-white/20" />
                <Cover book={stack.toSorted(bySeriesIndex)[0]} w={188} />
              </div>
              <div className="mt-[10px] flex h-5 items-center justify-between gap-2 text-[13px]">
                <span className="truncate font-bold">{b.series}</span>
                <span className="shrink-0 text-[#a8a8a8]">{stack.length} books</span>
              </div>
            </button>
          );
        }
        return (
          <div key={b.id} className="w-[188px]" {...drag(b.id)}>
            <CoverButton book={b} w={188} ids={ids} />
            <div className="mt-[10px] flex h-5 items-center gap-[6px] text-[#a8a8a8]">
              {b.kind === "audiobook" && <Icon name="headphones" className="size-4" />}
              {b.isNew && (
                <span className="rounded-full bg-[#1f3b68] px-[7px] py-[2px] text-[11px] font-bold leading-[14px] tracking-wide text-[#cfe0ff]">
                  NEW
                </span>
              )}
              <span className="grow" />
              {b.cloud && <Icon name="cloud" className="size-5" strokeWidth={1.3} />}
              <BookMenu book={b} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** `community` forces other readers' ratings; otherwise finished books show your own. */
function List({ books, community }: { books: Book[]; community: boolean }) {
  const { drag } = useContext(LibCtx);
  const ids = books.map((b) => b.id);
  return (
    <div className="flex flex-col gap-3 md:gap-[66px]">
      {books.map((b) => (
        <div
          key={b.id}
          className="flex items-center gap-4 max-md:rounded-lg max-md:bg-[#2e2e2e] max-md:p-3 md:gap-[29px]"
          {...drag(b.id)}
        >
          {/* a compact card on phones, the full row on wider screens */}
          <div className="md:hidden">
            <CoverButton book={b} w={64} ids={ids} />
          </div>
          <div className="max-md:hidden">
            <CoverButton book={b} w={160} ids={ids} />
          </div>
          <div className="min-w-0 grow">
            <h2 className="font-serif text-[16px] font-bold md:text-[20px]">{b.title}</h2>
            <p className="mt-[5px] text-[13px]">
              {b.author}
              {b.series && (
                <span className="text-[#9a9a9a]">
                  {" "}
                  • {b.series}
                  {b.seriesIndex ? ` #${b.seriesIndex}` : ""}
                </span>
              )}
            </p>
            <div className="mt-[6px]">
              {community || !b.finished ? (
                <CommunityRating book={b} />
              ) : (
                <Stars book={b} className="size-5" />
              )}
            </div>
            {b.tags && b.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-[6px]">
                {b.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-[#1f3b68] px-2 py-[1px] text-[11px] font-bold text-[#cfe0ff]"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            {b.blurb && (
              <p className="mt-5 max-w-[985px] text-[13px] leading-[16.500px] text-[#a6a6a6] max-md:hidden">
                {b.blurb}
              </p>
            )}
          </div>
          <div className="shrink-0 md:mr-[33px]">
            <BookMenu book={b} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ books }: { books: Book[] }) {
  const ids = books.map((b) => b.id);
  return (
    <div className="-mt-[13px]">
      {books.map((b, i) => (
        <div key={b.id} className="flex h-[247px] items-center">
          <span className="w-[38px] text-[12px] whitespace-nowrap text-[#9a9a9a] md:ml-4">
            {new Date(b.finished!).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </span>
          <div className="relative ml-[10px] w-[11px] self-stretch">
            <span
              className="absolute left-[5px] w-px bg-[#444]"
              style={{
                top: i === 0 ? "50%" : 0,
                bottom: i === books.length - 1 ? "50%" : 0,
              }}
            />
            <span className="absolute top-1/2 size-[11px] -translate-y-1/2 rounded-full bg-[#484848]" />
          </div>
          <div className="ml-3 md:ml-[37px]">
            <CoverButton book={b} w={140} ids={ids} />
          </div>
          <div className="ml-4 min-w-0 md:ml-[54px]">
            <h2 className="font-serif text-[20px] font-bold">{b.title}</h2>
            <p className="mt-[9px] text-[13px]">{b.author}</p>
            {/* spacing goes on the buttons: a margin on the icon would skew the half-star clip */}
            <div className="mt-[14px] [&_button]:mr-1">
              <Stars book={b} className="size-6" />
            </div>
            <div className="mt-[18px] flex items-center gap-[10px] text-[#a8a8a8]">
              <BookMenu book={b} align="left-0" />
              {b.cloud && <Icon name="cloud" className="size-5" strokeWidth={1.3} />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto mt-[150px] max-w-[290px] text-center text-[#8e8e8e]">
      <h2 className="font-serif text-[21px] font-bold">{title}</h2>
      <p className="mt-[10px] text-[14.500px] leading-[18px]">{text}</p>
    </div>
  );
}

function Section({
  title,
  onClear,
  children,
}: {
  title: string;
  onClear?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mb-[34px]">
      <div className="mb-[14px] flex items-end justify-between border-b border-white/10 pb-[10px] md:mr-[33px]">
        <h2 className="font-serif text-[20px] font-bold">{title}</h2>
        {onClear && (
          <button onClick={onClear} className="text-[13px] font-medium hover:underline">
            Clear
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

const panelClass = "relative rounded-2xl bg-[#2e2e2e] md:mr-[33px]";

const fieldClass =
  "h-[36px] w-full rounded-lg border border-white/15 bg-white/5 px-3 text-[14px] outline-none focus:border-white/50";
const primaryClass =
  "rounded-full bg-white text-[13px] font-bold text-black hover:bg-white/85";
const sheetClass = "rounded-[28px] bg-[#2c2c2e] px-8 pt-[76px] pb-8 shadow-2xl";

function GoalSheet({
  title,
  text,
  unit,
  max,
  presets,
  value,
  onSave,
  onClose,
}: {
  title: string;
  text: string;
  unit: string;
  max: number;
  presets: number[];
  value: number;
  onSave: (n: number) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label={title} onClose={onClose} className="w-[420px] max-w-[calc(100%-32px)]">
      <form
        className={sheetClass}
        onSubmit={(e) => {
          e.preventDefault();
          // min/max/required on the input already block anything out of range
          onSave(Math.round(Number(new FormData(e.currentTarget).get("goal"))));
          onClose();
        }}
      >
        <button type="button" aria-label="Close" onClick={onClose} className={closeClass}>
          <Icon name="x" className="size-5" />
        </button>
        <h2 className="font-serif text-[24px] font-bold">{title}</h2>
        <p className="mt-1 text-[14px] text-[#a0a0a0]">{text}</p>
        <label className="mt-6 flex items-center gap-3">
          <input
            name="goal"
            type="number"
            min={1}
            max={max}
            defaultValue={value}
            required
            autoFocus
            className={`${fieldClass} !w-[110px] text-center text-[18px] font-bold`}
          />
          <span className="text-[14px] text-[#a0a0a0]">
            {unit}s (1–{max})
          </span>
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          {presets.map((n) => (
            <button
              type="button"
              key={n}
              onClick={() => {
                onSave(n);
                onClose();
              }}
              className={controlClass}
            >
              {n}
            </button>
          ))}
        </div>
        <button className={`${primaryClass} mt-7 h-[36px] w-full`}>Save</button>
      </form>
    </Sheet>
  );
}

const DAILY_OPTIONS = [5, 10, 15, 20, 30, 45, 60];
const YEARLY_OPTIONS = [1, 3, 5, 10, 12, 20, 24, 36, 52];

/** Stand-in for an open-book preview until real pages can be rendered. */
function Spread({ book }: { book: Book }) {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => (
      <span
        key={i}
        className="h-[2px] shrink-0 rounded bg-black/15"
        style={{ width: `${72 + ((i * 37) % 28)}%` }}
      />
    ));
  const page = "flex w-1/2 flex-col justify-between bg-[#f4f4f1] px-[6%] py-[7%] text-[#222]";
  return (
    <div className="flex aspect-[3/2] w-full gap-[2px] rounded-[3px] bg-[#111] p-[5px] shadow-[0_10px_24px_rgba(0,0,0,0.55)]">
      <div className={page}>
        <span className="text-center font-serif text-[clamp(13px,2vw,22px)] leading-tight font-bold">
          {book.title}
        </span>
        <span className="text-center text-[11px]">{book.author}</span>
        {lines(8)}
      </div>
      <div className={page}>{lines(14)}</div>
    </div>
  );
}

function Home() {
  const { s, set, setView, setDetail, play, read: openReader } = useContext(LibCtx);
  const [goalEdit, setGoalEdit] = useState<"daily" | "yearly" | null>(null);

  const now = new Date();
  const today = dayKey(now);
  // Filled in by the reader and the audio player while a book is open.
  const log = { [today]: 0, ...s.log };
  const goal = s.dailyGoal * 60;
  const { current: streak, record } = streaks(log, goal, now);

  const read = s.books
    .filter((b) => b.finished?.startsWith(`${now.getFullYear()}`))
    .sort((a, b) => b.finished!.localeCompare(a.finished!));
  const left = Math.max(0, s.yearlyGoal - read.length);
  const shown = read.slice(0, 100); // the card never draws more than 100 covers
  const want = s.books.filter(FILTERS.want);
  const reading = s.books
    .filter((b) => !b.finished && (b.progress ?? 0) > 0 && b.progress! < 1)
    .sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0));
  const current: Book | undefined = reading[0]; // most recently opened leads the page
  const readingIds = reading.map((b) => b.id);
  const open = (b: Book) =>
    b.kind === "audiobook" && b.file
      ? play(b.id)
      : b.file && READABLE.test(b.file)
        ? openReader(b.id)
        : setDetail({ ids: readingIds, id: b.id });
  const percent = (b: Book) => `${Math.round(b.progress! * 100)}%`;
  // Up to 100 slots: covers shrink as the goal grows so the card stays compact.
  const slots = Math.min(100, Math.max(s.yearlyGoal, read.length));
  const w = slots <= 5 ? 150 : slots <= 10 ? 110 : slots <= 24 ? 76 : slots <= 50 ? 54 : 40;
  const big = w >= 110; // only large covers have room for the blue check
  // Small covers wrap as before, but in a centred band narrower than the card (100 slots = 5 rows of 20).
  const blockWidth = big ? undefined : 960;
  const arc = "M12 208A198 198 0 0 1 408 208";
  const linkClass = "flex items-center gap-1 rounded-lg px-2 py-[2px] hover:bg-white/5";
  const gearClass = "absolute top-5 right-5 text-[#b4b4b4] hover:text-white";
  const chevron = <Icon name="chevronRight" className="size-3 text-[#8c8c8c]" strokeWidth={2.4} />;

  return (
    <>
      {current && (
        <section className="mb-[34px] md:mr-[33px]">
          <div className="max-w-[560px]">
            <div
              role="button"
              tabIndex={0}
              aria-label={`Continue ${current.title}`}
              onClick={() => open(current)}
              onKeyDown={(e) => e.key === "Enter" && open(current)}
              className="cursor-pointer"
            >
              {current.kind === "audiobook" ? (
                <Cover book={current} w={240} />
              ) : (
                <Spread book={current} />
              )}
            </div>
            <p className="mt-4 text-[17px]">{current.title}</p>
            <div className="mt-1 flex items-center justify-between text-[13px] text-[#9a9a9a]">
              {percent(current)}
              <BookMenu book={current} />
            </div>
          </div>
          {reading.length > 1 && (
            <>
              <h2 className="mt-6 mb-4 border-t border-white/10 pt-5 text-[13px] tracking-[0.12em] text-[#c8c8c8] uppercase">
                Recently Opened
              </h2>
              <div className="flex flex-wrap gap-x-6 gap-y-5">
                {reading.slice(1).map((b) => (
                  <div key={b.id} className="w-[112px]">
                    <CoverButton book={b} w={112} ids={readingIds} />
                    <div className="mt-2 flex items-center justify-between text-[13px] text-[#9a9a9a]">
                      {percent(b)}
                      <BookMenu book={b} align="left-0" />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <section className={`${panelClass} mb-[34px] flex flex-col items-center px-4 pt-9 pb-10`}>
        <button
          aria-label="Daily reading goal"
          onClick={() => setGoalEdit("daily")}
          className={gearClass}
        >
          <Icon name="settings" />
        </button>
        <h2 className="font-serif text-[22px] font-bold">Reading Goals</h2>
        <p className="mt-1 max-w-[300px] text-center text-[14px] text-[#a0a0a0]">
          Read every day, see your stats soar, and finish more books.
        </p>
        <div className="relative mt-6 flex w-[420px] max-w-full flex-col items-center pt-[72px]">
          <svg
            viewBox="0 0 420 216"
            className="absolute inset-x-0 top-0 w-full"
            fill="none"
            strokeWidth="14"
            strokeLinecap="round"
            aria-hidden
          >
            <path d={arc} stroke="rgba(255,255,255,0.08)" />
            {log[today] > 0 && (
              <path
                d={arc}
                stroke="#1c9be6"
                pathLength={1}
                strokeDasharray={`${Math.min(1, log[today] / goal)} 1`}
              />
            )}
          </svg>
          <h3 className="relative font-serif text-[17px] font-bold">Today’s Reading</h3>
          <p className="relative font-serif text-[64px] leading-[70px]">{clock(log[today])}</p>
          <button
            onClick={() => setGoalEdit("daily")}
            className={`${linkClass} relative text-[14px]`}
          >
            of your {s.dailyGoal}-minute goal
            {chevron}
          </button>
        </div>
        <button
          onClick={() => (current ? open(current) : setView("all"))}
          className={`${primaryClass} mt-7 flex h-[56px] w-[340px] max-w-full flex-col items-center justify-center`}
        >
          <span className="text-[15px]">
            {current ? "Keep Reading" : "Browse Your Library"}
          </span>
          {current && (
            <span className="max-w-[90%] truncate text-[12px] font-normal">{current.title}</span>
          )}
        </button>
        <div className="mt-6 flex gap-[10px]">
          {[..."SMTWTFS"].map((d, i) => {
            const date = new Date(now);
            date.setDate(now.getDate() - now.getDay() + i);
            const met = (log[dayKey(date)] ?? 0) >= goal;
            const isToday = i === now.getDay();
            const state = met
              ? "bg-[#1c9be6]"
              : isToday
                ? ""
                : i > now.getDay()
                  ? "border border-white/20 text-white/40"
                  : "bg-white/20 text-white/60";
            return (
              <span
                key={i}
                className={`relative flex size-8 items-center justify-center rounded-full text-[12px] font-bold ${state}`}
              >
                {/* today's ring fills as the day's reading approaches the goal */}
                {isToday && !met && (
                  <svg
                    viewBox="0 0 32 32"
                    className="absolute inset-0 -rotate-90"
                    fill="none"
                    strokeWidth="2.5"
                    aria-hidden
                  >
                    <circle cx="16" cy="16" r="14.500" stroke="rgba(255,255,255,0.2)" />
                    {log[today] > 0 && (
                      <circle
                        cx="16"
                        cy="16"
                        r="14.500"
                        stroke="#1c9be6"
                        strokeLinecap="round"
                        pathLength={1}
                        strokeDasharray={`${log[today] / goal} 1`}
                      />
                    )}
                  </svg>
                )}
                {d}
              </span>
            );
          })}
        </div>
        <button onClick={() => setView("stats")} className={`${linkClass} mt-3 text-[15px]`}>
          {streak ? `${streak}-day streak` : "Start a new streak"}
          {chevron}
        </button>
        <p className="text-[15px] text-[#a0a0a0]">
          Your record is {record} day{record === 1 ? "" : "s"}.
        </p>

      </section>

      <section className={`${panelClass} mb-[34px] flex flex-col items-center px-4 pt-9 pb-10`}>
        <button
          aria-label="Yearly reading goal"
          onClick={() => setGoalEdit("yearly")}
          className={gearClass}
        >
          <Icon name="settings" />
        </button>
        <h3 className="font-serif text-[18px] font-bold">Books Read This Year</h3>
        <div
          className={`mt-6 flex flex-wrap items-end justify-center ${big ? "gap-5" : "gap-2"}`}
          style={{ maxWidth: blockWidth }}
        >
          {shown.map((b) => (
            <div key={b.id} className="relative">
              <Cover book={b} w={w} />
              {big && (
                <span className="absolute -right-2 -bottom-2 flex size-8 items-center justify-center rounded-full bg-[#1c9be6]">
                  <Icon name="check" className="size-5" strokeWidth={2.6} />
                </span>
              )}
            </div>
          ))}
          {Array.from({ length: slots - shown.length }, (_, i) => (
            <div
              key={i}
              className="flex items-center justify-center rounded-[2px] border border-dashed border-white/15 font-serif text-white/15"
              style={{ width: w, height: w * 1.5, fontSize: w * 0.27 }}
            >
              {read.length + i + 1}
            </div>
          ))}
        </div>
        <p className="mt-7 text-[15px] font-bold">
          {left ? `${left} more to reach your goal of ${s.yearlyGoal}` : "Yearly Goal Achieved"}
        </p>
        <p className="text-[15px] text-[#a0a0a0]">
          {read.length} book{read.length === 1 ? "" : "s"} finished. Keep reading!
        </p>
      </section>

      {s.books.length > 0 && (
        <Section title="Recently Added">
          <Grid books={s.books.toSorted(newestFirst).slice(0, 6)} />
        </Section>
      )}
      {want.length > 0 && (
        <Section title="Want to Read">
          <Grid books={want} />
        </Section>
      )}
      {goalEdit === "daily" && (
        <GoalSheet
          title="Daily Reading Goal"
          text="Minutes to read each day. A day counts toward your streak once you reach it."
          unit="minute"
          max={1440}
          presets={DAILY_OPTIONS}
          value={s.dailyGoal}
          onSave={(dailyGoal) => set(() => ({ dailyGoal }))}
          onClose={() => setGoalEdit(null)}
        />
      )}
      {goalEdit === "yearly" && (
        <GoalSheet
          title="Yearly Reading Goal"
          text="Books to finish this year."
          unit="book"
          max={100}
          presets={YEARLY_OPTIONS}
          value={s.yearlyGoal}
          onSave={(yearlyGoal) => set(() => ({ yearlyGoal }))}
          onClose={() => setGoalEdit(null)}
        />
      )}
    </>
  );
}

/** Compact cover + title/author/meta on the search page; opens the detail sheet. */
function Result({ book, w, ids }: { book: Book; w: number; ids: string[] }) {
  const { setDetail } = useContext(LibCtx);
  const info = book.info;
  return (
    <button
      onClick={() => setDetail({ ids, id: book.id })}
      className="flex w-full items-center gap-[18px] rounded-lg p-2 text-left hover:bg-white/5"
    >
      <Cover book={book} w={w} />
      <div className="min-w-0 text-[13px] leading-[19.500px]">
        <p className="truncate font-semibold">{book.title}</p>
        <p className="truncate">{book.author}</p>
        <p className="text-[#9a9a9a]">
          {KIND_LABEL[book.kind]}
          {info?.rating
            ? ` • ★ ${info.rating.toFixed(1)} (${compact(info.ratings ?? 0)})`
            : null}
        </p>
      </div>
    </button>
  );
}

const closeClass =
  "absolute top-5 left-5 flex size-[38px] items-center justify-center rounded-full border border-white/15 hover:bg-white/10";

/** Modal over the blurred page (the sidebar stays usable on desktop). Escape or a click outside closes it. */
function Sheet({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  className: string; // size of the content box
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-2xl md:left-[221px]"
    >
      <div onClick={(e) => e.stopPropagation()} className={`relative ${className}`}>
        {children}
      </div>
    </div>
  );
}

const FORMATS = `Books: ${EBOOK.join(", ").toUpperCase()}. Audiobooks: ${AUDIO.join(", ").toUpperCase()}.`;

function ImportSheet({ onClose }: { onClose: () => void }) {
  const { importFiles } = useContext(LibCtx);
  return (
    <Sheet label="Import" onClose={onClose} className="w-[560px] max-w-[calc(100%-32px)]">
      <div className="rounded-[28px] bg-[#2c2c2e] px-8 pt-[76px] pb-8 shadow-2xl">
        <button aria-label="Close" onClick={onClose} className={closeClass}>
          <Icon name="x" className="size-5" />
        </button>
        <h2 className="font-serif text-[24px] font-bold">Import</h2>
        <p className="mt-1 text-[14px] text-[#a0a0a0]">
          Add books, audiobooks and PDFs to your library.
        </p>
        <label className="mt-6 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-white/20 bg-white/5 px-6 py-12 text-center focus-within:border-white/50 hover:bg-white/10">
          <Icon name="import" className="size-9 text-[#a0a0a0]" />
          <span className="text-[15px] font-bold">Drop files here or click to choose</span>
          <span className="text-[13px] text-[#a0a0a0]">
            You can also drop files anywhere in the window.
          </span>
          <input
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              importFiles([...(e.target.files ?? [])]);
              onClose();
            }}
          />
        </label>
        <p className="mt-5 text-[12px] leading-[17px] text-[#8c8c8c]">{FORMATS}</p>
      </div>
    </Sheet>
  );
}

function SettingRow({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-white/10 px-5 py-4 last:border-0">
      <div className="min-w-0">
        <p className="text-[14px] font-bold">{title}</p>
        <p className="text-[13px] text-[#a0a0a0]">{text}</p>
      </div>
      {children}
    </div>
  );
}

const controlClass =
  "h-[30px] shrink-0 rounded-lg bg-white/10 px-3 text-[13px] font-bold hover:bg-white/15 [&>option]:bg-[#2e2e2e]";

const HELP: [string, string][] = [
  [
    "Importing",
    `Drop files anywhere in the window, or use Import on Home or in the profile menu. ${FORMATS} Files are copied to the server’s library folder; the title comes from the file name, and Edit Details in a book’s ••• menu fixes the rest.`,
  ],
  [
    "Shelves, series and tags",
    "Use the ••• menu on any book to add it to Want to Read, mark it finished, or put it on a shelf. Create shelves from the sidebar; double-click one to rename it. Series and tags are set in Edit Details.",
  ],
  [
    "Sorting",
    "The ••• button at the top right of a shelf switches between grid and list and changes the sort order. In Manual sort, drag a book onto another, or use Move Earlier and Move Later in its menu.",
  ],
  [
    "Ratings",
    "Want to Read shows what other readers think, from Open Library. Once you finish a book the stars are yours: click one to rate, click it again for half a star less, and a third time to clear.",
  ],
  [
    "Reading goals",
    "Time counts on its own while a book or PDF is open in the reader, or an audiobook is playing. Days that reach your daily goal build your streak.",
  ],
  [
    "Your data",
    "Shelves, ratings, progress and goals are saved in this browser only. Imported files live on the server.",
  ],
];

const SETTINGS_TABS: [id: string, label: string, icon: IconName][] = [
  ["profile", "Profile", "user"],
  ["goals", "Reading Goals", "finished"],
  ["online", "Online", "cloud"],
  ["library", "Library", "shelf"],
  ["help", "Help", "help"],
];

function SettingsSheet({
  tab,
  onTab,
  onClose,
}: {
  tab: string;
  onTab: (tab: string) => void;
  onClose: () => void;
}) {
  const { s, set, openImport, toast } = useContext(LibCtx);
  const goalInput = (label: string, value: number, max: number, onPick: (n: number) => void) => (
    <input
      aria-label={label}
      type="number"
      min={1}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Math.round(Number(e.target.value));
        if (n >= 1 && n <= max) onPick(n);
      }}
      className={`${controlClass} w-[84px] text-center`}
    />
  );
  const body: Record<string, ReactNode> = {
    profile: (
      <SettingRow title="Name" text="Set NEXT_PUBLIC_USER_NAME in .env.local on the server.">
        <span className="text-[13px] font-bold">{NAME}</span>
      </SettingRow>
    ),
    goals: (
      <>
        <SettingRow
          title="Daily goal"
          text="Minutes a day (1–1440). A day counts toward your streak once you read this long."
        >
          {goalInput("Daily goal", s.dailyGoal, 1440, (dailyGoal) => set(() => ({ dailyGoal })))}
        </SettingRow>
        <SettingRow title="Yearly goal" text="Books to finish this year (1–100).">
          {goalInput("Yearly goal", s.yearlyGoal, 100, (yearlyGoal) =>
            set(() => ({ yearlyGoal })),
          )}
        </SettingRow>
      </>
    ),
    online: (
      <SettingRow
        title="Reader ratings"
        text="Look up other readers’ ratings on Open Library by title and author."
      >
        <input
          type="checkbox"
          aria-label="Reader ratings"
          checked={s.lookups}
          onChange={(e) => set(() => ({ lookups: e.target.checked }))}
          className="size-[18px] accent-[#1c9be6]"
        />
      </SettingRow>
    ),
    library: (
      <>
        <SettingRow title="Import" text={FORMATS}>
          <button onClick={openImport} className={controlClass}>
            Import Files
          </button>
        </SettingRow>
        <SettingRow
          title="Recent searches"
          text={`${s.recents.length} saved on the Search page.`}
        >
          <button
            onClick={() => {
              set(() => ({ recents: [] }));
              toast("Cleared", "Your recent searches were cleared.");
            }}
            className={controlClass}
          >
            Clear
          </button>
        </SettingRow>
        <SettingRow
          title="Reset library"
          text="Forget every book, shelf, rating and goal saved in this browser. Imported files stay on the server."
        >
          <button
            onClick={() => {
              if (!confirm("Reset the library in this browser? This can’t be undone.")) return;
              localStorage.removeItem(STORAGE_KEY);
              location.reload();
            }}
            className={`${controlClass} text-[#ff6b61]`}
          >
            Reset
          </button>
        </SettingRow>
      </>
    ),
    help: HELP.map(([title, text]) => (
      <div key={title} className="border-b border-white/10 px-5 py-4 last:border-0">
        <p className="text-[14px] font-bold">{title}</p>
        <p className="mt-1 text-[13px] leading-[19px] text-[#a0a0a0]">{text}</p>
      </div>
    )),
  };
  return (
    <Sheet
      label="Settings"
      onClose={onClose}
      className="h-[640px] max-h-[calc(100%-32px)] w-[920px] max-w-[calc(100%-32px)]"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[18px] border border-white/10 bg-[#1e1e1e] shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 py-3 pr-3 pl-5">
          <h2 className="text-[15px] font-bold">Settings</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-white/10"
          >
            <Icon name="x" className="size-5" />
          </button>
        </header>
        <div className="flex min-h-0 grow max-md:flex-col">
          <nav className="flex shrink-0 overflow-auto border-white/10 bg-[#1b1b1b] p-[9px] max-md:gap-1 max-md:border-b md:w-[210px] md:flex-col md:border-r">
            {SETTINGS_TABS.map(([id, label, icon]) => (
              <button
                key={id}
                onClick={() => onTab(id)}
                className={`${itemClass} max-md:w-auto max-md:shrink-0 ${tab === id ? "bg-[#737373]" : "hover:bg-white/5"}`}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 grow overflow-y-auto py-3">
            <h3 className="px-5 py-2 text-[15px] font-bold">
              {SETTINGS_TABS.find(([id]) => id === tab)?.[1]}
            </h3>
            {body[tab]}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function Detail({ ids, id }: DetailState) {
  const { s, setDetail, toggleWant, toggleFinished, setView, patch, play, read } =
    useContext(LibCtx);

  const book = s.books.find((b) => b.id === id);
  if (!book) return null; // removed from the library while open

  const i = ids.indexOf(id);
  const prev = i > 0 ? ids[i - 1] : undefined;
  const next = i >= 0 ? ids[i + 1] : undefined;
  const twin = s.books.find(
    (b) => b.id !== id && b.title === book.title && b.author === book.author,
  );
  const info = book.info;
  const card = "rounded-2xl bg-[#3a393c] p-[17px]";
  const arrow = "absolute top-1/2 -translate-y-1/2 text-[#8c8c8c] hover:text-white";

  return (
    <Sheet
      label={book.title}
      onClose={() => setDetail(null)}
      className="h-full w-[922px] max-w-full md:h-[calc(100%-70px)] md:max-w-[calc(100%-110px)]"
    >
        {prev && (
          <button
            aria-label="Previous"
            onClick={() => setDetail({ ids, id: prev })}
            className={`${arrow} -left-[48px] max-md:hidden`}
          >
            <Icon name="chevronLeft" className="size-9" strokeWidth={1.2} />
          </button>
        )}
        {next && (
          <button
            aria-label="Next"
            onClick={() => setDetail({ ids, id: next })}
            className={`${arrow} -right-[48px] max-md:hidden`}
          >
            <Icon name="chevronRight" className="size-9" strokeWidth={1.2} />
          </button>
        )}

        <div className="h-full overflow-y-auto bg-[#2c2c2e] shadow-2xl md:rounded-[28px]">
          <div className="relative bg-[#262527] px-5 pt-[68px] pb-[34px] md:px-[74px]">
            <button
              aria-label="Close"
              onClick={() => setDetail(null)}
              className={closeClass}
            >
              <Icon name="x" className="size-5" />
            </button>
            <div className="absolute top-5 right-5 flex h-[38px] items-center gap-4 rounded-full border border-white/15 px-4">
              <button
                aria-label={book.want ? "Remove from Want to Read" : "Add to Want to Read"}
                onClick={() => toggleWant(book)}
                className="hover:text-white/70"
              >
                <Icon name={book.want ? "check" : "plus"} className="size-5" />
              </button>
              <BookMenu book={book} />
            </div>

            <div className="flex flex-col gap-6 md:flex-row md:gap-[34px]">
              <Cover book={book} w={190} />
              <div className="min-w-0 grow">
                {book.series && (
                  <button
                    onClick={() => setView(`s:${book.series}`)}
                    className="mb-2 flex items-center gap-1 border-b-2 border-white/40 pb-[2px] text-[11px] font-bold tracking-[0.12em] uppercase hover:border-white"
                  >
                    {book.seriesIndex ? `Book ${book.seriesIndex}, ` : ""}
                    {book.series}
                    <Icon name="chevronRight" className="size-3" strokeWidth={2.4} />
                  </button>
                )}
                <h2 className="font-serif text-[28px] leading-tight font-bold">
                  {book.title}
                </h2>
                <p className="mt-[6px] text-[14px]">{book.author}</p>
                <p className="mt-2 text-[13px] text-[#a8a8a8]">
                  {[
                    info?.rating &&
                      `★ ${info.rating.toFixed(1)} (${compact(info.ratings ?? 0)})`,
                    info?.year && `First published ${info.year}`,
                  ]
                    .filter(Boolean)
                    .join(" • ")}
                </p>
                <div className={`${card} mt-5 flex items-center justify-between gap-4`}>
                  <div>
                    <p className="text-[16px] font-bold">{KIND_LABEL[book.kind]}</p>
                    <p className="text-[13px] text-[#c8c8c8]">
                      {[
                        `Added ${new Date(book.added).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
                        info?.pages && `${info.pages} Pages`,
                      ]
                        .filter(Boolean)
                        .join(" • ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    {book.file && (
                      <button
                        onClick={() => {
                          if (book.kind === "audiobook") return play(book.id);
                          if (READABLE.test(book.file!)) return read(book.id);
                          window.open(`/api/import?file=${book.file}`, "_blank", "noopener");
                        }}
                        className={`${primaryClass} h-[30px] w-[150px]`}
                      >
                        {book.kind === "audiobook"
                          ? "Listen"
                          : READABLE.test(book.file)
                            ? "Read"
                            : "Download"}
                      </button>
                    )}
                    <button
                      onClick={() => toggleFinished(book)}
                      className={`h-[30px] w-[150px] ${book.file ? "rounded-full bg-white/10 text-[13px] font-bold hover:bg-white/15" : primaryClass}`}
                    >
                      {book.finished ? "Mark as Unfinished" : "Mark as Finished"}
                    </button>
                  </div>
                </div>
                {twin && (
                  <button
                    onClick={() => setDetail({ ids, id: twin.id })}
                    className={`${card} mt-[11px] flex w-full items-center gap-3 text-left hover:bg-[#444346]`}
                  >
                    <Cover book={twin} w={42} />
                    <span>
                      <span className="block font-serif text-[16px] font-bold">
                        View the {KIND_LABEL[twin.kind]}
                      </span>
                      <span className="text-[13px] text-[#c8c8c8]">
                        Also in your library
                      </span>
                    </span>
                  </button>
                )}
                {book.tags && book.tags.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {book.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => setView(`t:${t}`)}
                        className="rounded-lg bg-white/10 px-3 py-1 text-[12px] font-bold hover:bg-white/15"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="px-5 py-8 md:px-[74px]">
            <h3 className="font-serif text-[17px] font-bold">Description</h3>
            <p className="mt-3 font-serif text-[15px] leading-[18px]">
              {book.blurb ?? "No description yet."}
            </p>
            <hr className="my-7 border-white/10" />
            <h3 className="font-serif text-[17px] font-bold">Ratings</h3>
            <div className="mt-3 grid gap-4 md:grid-cols-2 md:gap-[26px]">
              <div className={card}>
                <p className="mb-2 text-[13px] font-bold">Other Readers</p>
                <CommunityRating book={book} />
              </div>
              <div className={card}>
                <p className="mb-2 text-[13px] font-bold">Your Rating</p>
                {book.finished ? (
                  <Stars book={book} className="size-5" />
                ) : (
                  <p className="text-[13px] text-[#8c8c8c]">
                    Mark it as finished to rate it.
                  </p>
                )}
              </div>
            </div>
            <hr className="my-7 border-white/10" />
            <h3 className="font-serif text-[17px] font-bold">Progress</h3>
            <div className={`${card} mt-3 flex items-center gap-4`}>
              <input
                type="range"
                aria-label="Progress"
                min={0}
                max={100}
                value={Math.round((book.progress ?? 0) * 100)}
                disabled={book.kind === "audiobook" && !!book.file}
                onChange={(e) =>
                  patch(book.id, {
                    progress: Number(e.target.value) / 100,
                    opened: Date.now(),
                  })
                }
                className="grow accent-[#3b9be0]"
              />
              <span className="w-10 text-right text-[13px] font-bold">
                {Math.round((book.progress ?? 0) * 100)}%
              </span>
            </div>
            <p className="mt-2 text-[12px] text-[#8c8c8c]">
              {book.kind === "audiobook" && book.file
                ? "Updates as you listen."
                : "Drag to record how far you are. Anything between 0 and 100% shows under Continue Reading on Home."}
            </p>
          </div>
        </div>
    </Sheet>
  );
}

function Search() {
  const { s, set } = useContext(LibCtx);
  const [q, setQ] = useState("");
  const term = q.trim();
  const results = s.books.filter((b) =>
    `${b.title} ${b.author} ${b.series ?? ""} ${(b.tags ?? []).join(" ")}`
      .toLowerCase()
      .includes(term.toLowerCase()),
  );
  const rows = (books: Book[]) => {
    const ids = books.map((b) => b.id);
    return (
      <div className="grid gap-x-[25px] md:mr-[33px] md:grid-cols-2">
        {books.map((b) => (
          <div key={b.id} className="border-b border-white/10 py-[2px]">
            <Result book={b} w={56} ids={ids} />
          </div>
        ))}
      </div>
    );
  };
  const recent = s.books.toSorted(newestFirst).slice(0, 3);

  return (
    <>
      <form
        className="mt-2 mb-[38px] flex justify-center md:-mt-[38px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (term)
            set((prev) => ({
              recents: [term, ...prev.recents.filter((r) => r !== term)].slice(0, 8),
            }));
        }}
      >
        <label className="flex h-[36px] w-[345px] max-w-full items-center gap-2 rounded-full border border-white/15 px-[14px] text-[#9a9a9a] focus-within:border-white/40">
          <Icon name="search" className="size-4" strokeWidth={2} />
          <input
            autoFocus
            type="search"
            aria-label="Search library"
            placeholder="Search Library"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full bg-transparent text-[13.500px] text-[#f2f2f2] outline-none placeholder:text-[#9a9a9a] [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQ("")}
              className="hover:text-[#c8c8c8]"
            >
              <Icon name="x" className="size-4" strokeWidth={2} />
            </button>
          )}
        </label>
      </form>

      {term ? (
        results.length ? (
          <Section title="Results">{rows(results)}</Section>
        ) : (
          <EmptyState title="No Results" text={`Nothing in your library matches “${term}”.`} />
        )
      ) : (
        <>
          {s.recents.length > 0 && (
            <Section title="Recently Searched" onClear={() => set(() => ({ recents: [] }))}>
              <div className="flex flex-wrap gap-2">
                {s.recents.map((r) => (
                  <button
                    key={r}
                    onClick={() => setQ(r)}
                    className="flex h-10 items-center gap-2 rounded-lg bg-[#3a3a3a] px-4 text-[14px] hover:bg-[#444]"
                  >
                    <Icon name="search" className="size-[14px] text-[#b4b4b4]" strokeWidth={2} />
                    {r}
                  </button>
                ))}
              </div>
            </Section>
          )}
          <Section title="Recently Added">
            <div className="grid gap-x-6 gap-y-1 py-1 md:grid-cols-3">
              {recent.map((b) => (
                <Result key={b.id} book={b} w={72} ids={recent.map((r) => r.id)} />
              ))}
            </div>
          </Section>
          <Section title="In Your Library">{rows(s.books)}</Section>
        </>
      )}
    </>
  );
}

/** A cover that opens the detail sheet. A div, not a button, so the tile around it stays draggable. */
function CoverButton({ book, w, ids }: { book: Book; w: number; ids: string[] }) {
  const { setDetail } = useContext(LibCtx);
  const open = () => setDetail({ ids, id: book.id });
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Details for ${book.title}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
      className="w-fit shrink-0 cursor-pointer"
    >
      <Cover book={book} w={w} />
    </div>
  );
}

function EditSheet({ book, onClose }: { book: Book; onClose: () => void }) {
  const { patch, toast } = useContext(LibCtx);
  const field = (label: string, name: string, value: string | number = "", wide = true) => (
    <label className={wide ? "md:col-span-2" : ""}>
      <span className="mb-1 block text-[12px] font-bold text-[#a0a0a0]">{label}</span>
      <input
        name={name}
        defaultValue={value}
        type={name === "seriesIndex" ? "number" : "text"}
        min={1}
        className={fieldClass}
      />
    </label>
  );
  return (
    <Sheet label="Edit Details" onClose={onClose} className="w-[560px] max-w-[calc(100%-32px)]">
      <form
        className={`${sheetClass} max-h-[calc(100vh-32px)] overflow-y-auto`}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const text = (name: string) => String(form.get(name) ?? "").trim();
          const title = text("title") || book.title;
          const author = text("author") || UNKNOWN_AUTHOR;
          patch(book.id, {
            title,
            author,
            series: text("series") || undefined,
            seriesIndex: Number(text("seriesIndex")) || undefined,
            tags: [...new Set(text("tags").split(",").map((t) => t.trim()).filter(Boolean))],
            blurb: text("blurb") || undefined,
            // a new title or author means the Open Library match is stale: look it up again
            ...((title !== book.title || author !== book.author) && { info: undefined }),
          });
          toast("Saved", `“${title}” was updated.`);
          onClose();
        }}
      >
        <button type="button" aria-label="Close" onClick={onClose} className={closeClass}>
          <Icon name="x" className="size-5" />
        </button>
        <h2 className="font-serif text-[24px] font-bold">Edit Details</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {field("Title", "title", book.title)}
          {field("Author", "author", book.author === UNKNOWN_AUTHOR ? "" : book.author)}
          {field("Series", "series", book.series, false)}
          {field("Number in series", "seriesIndex", book.seriesIndex, false)}
          {field("Tags (comma separated)", "tags", book.tags?.join(", "))}
          <label className="md:col-span-2">
            <span className="mb-1 block text-[12px] font-bold text-[#a0a0a0]">
              Description
            </span>
            <textarea
              name="blurb"
              defaultValue={book.blurb}
              rows={4}
              className={`${fieldClass} !h-auto py-2`}
            />
          </label>
        </div>
        <button className={`${primaryClass} mt-7 h-[36px] w-full`}>Save</button>
      </form>
    </Sheet>
  );
}

const RATES = [0.75, 1, 1.25, 1.5, 2];
const SLEEP_MINUTES = [0, 15, 30, 45, 60];

/**
 * While `active`, credits wall-clock time to today's reading in 5-second slices.
 * `onSlice` runs with each slice (and once more when it stops) so progress can be saved.
 */
function useReadingClock(active: boolean, onSlice?: () => void) {
  const { set } = useContext(LibCtx);
  const slice = useRef(onSlice);
  useEffect(() => {
    slice.current = onSlice;
  });
  useEffect(() => {
    if (!active) return;
    let from = Date.now();
    const tick = () => {
      const start = from;
      const end = (from = Date.now());
      slice.current?.();
      set((prev) => ({ log: addSession(prev.log, start, end) }));
    };
    const timer = setInterval(tick, 5000);
    return () => {
      clearInterval(timer);
      tick();
    };
    // set only wraps a state setter, so the first closure stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** Formats the in-app reader can show; anything else is offered as a download. */
const READABLE = /\.(epub|pdf|txt)$/;

/**
 * In-app reader: EPUB through epub.js, PDF and text in the browser's own viewer.
 * The time it is open and on screen counts as reading.
 */
function Reader({ book, onClose }: { book: Book; onClose: () => void }) {
  const { patch } = useContext(LibCtx);
  const src = `/api/import?file=${book.file}`;
  const isEpub = book.file!.endsWith(".epub");
  const stage = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition | null>(null);
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useReadingClock(visible);

  useEffect(() => {
    patch(book.id, { opened: Date.now() });
    if (!isEpub) return;
    let epub: EpubBook | undefined;
    let cancelled = false;
    const turn = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") rendition.current?.prev();
      if (e.key === "ArrowRight") rendition.current?.next();
    };
    import("epubjs")
      .then(({ default: ePub }) => {
        if (cancelled) return;
        // The URL has no .epub extension to sniff, so say what it is.
        epub = ePub(src, { openAs: "epub" });
        const r = epub.renderTo(stage.current!, { width: "100%", height: "100%" });
        rendition.current = r;
        r.themes.default({
          body: { color: "#e6e6e6 !important", background: "#1e1e1e !important" },
          a: { color: "#4a9ee0 !important" },
        });
        r.on("keyup", turn); // key presses while focus is inside the book
        r.on("relocated", (at: Location) => {
          // Chapter position plus the page within it: close enough without indexing the whole book.
          const { index, cfi, displayed } = at.start;
          const chapters = epub!.spine.last().index + 1;
          patch(book.id, {
            cfi,
            progress: Math.min(1, (index + displayed.page / displayed.total) / chapters),
          });
        });
        return r.display(book.cfi);
      })
      .catch(() => setFailed(true));
    window.addEventListener("keydown", turn);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", turn);
      rendition.current = null;
      epub?.destroy();
    };
    // Opens once per book; later progress updates must not restart the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const button = "rounded-lg p-1 hover:bg-white/10";
  return (
    <Sheet
      label={`Reading ${book.title}`}
      onClose={onClose}
      className="h-full w-[1100px] max-w-full md:h-[calc(100%-32px)] md:max-w-[calc(100%-32px)]"
    >
      <div className="flex h-full flex-col overflow-hidden border-white/10 bg-[#1e1e1e] shadow-2xl md:rounded-[18px] md:border">
        <header className="flex items-center gap-2 border-b border-white/10 py-2 pr-3 pl-5">
          <h2 className="min-w-0 grow truncate text-[14px] font-bold">{book.title}</h2>
          {isEpub && (
            <>
              <span className="mr-2 text-[12px] text-[#a0a0a0]">
                {Math.round((book.progress ?? 0) * 100)}%
              </span>
              <button
                aria-label="Previous page"
                onClick={() => rendition.current?.prev()}
                className={button}
              >
                <Icon name="chevronLeft" className="size-5" />
              </button>
              <button
                aria-label="Next page"
                onClick={() => rendition.current?.next()}
                className={button}
              >
                <Icon name="chevronRight" className="size-5" />
              </button>
            </>
          )}
          <button aria-label="Close" onClick={onClose} className={button}>
            <Icon name="x" className="size-5" />
          </button>
        </header>
        {failed ? (
          <EmptyState
            title="Can’t Open This Book"
            text="The file couldn’t be read. It may be damaged or protected."
          />
        ) : isEpub ? (
          <div ref={stage} className="min-h-0 grow px-2 md:px-10" />
        ) : (
          <iframe title={book.title} src={src} className="min-h-0 grow bg-white" />
        )}
      </div>
    </Sheet>
  );
}

/** Audiobook bar pinned to the bottom of the window while a book plays. */
function Player({ book, onClose }: { book: Book; onClose: () => void }) {
  const { patch } = useContext(LibCtx);
  const audio = useRef<HTMLAudioElement>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(book.position ?? 0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [sleep, setSleep] = useState(0); // minutes; 0 = off

  // While playing, the listening time counts as reading and the position is saved with it.
  useReadingClock(!paused, () => {
    const a = audio.current;
    if (a)
      patch(book.id, {
        position: a.currentTime,
        progress: a.duration ? a.currentTime / a.duration : 0,
        opened: Date.now(),
      });
  });

  useEffect(() => {
    if (!sleep) return;
    const a = audio.current!;
    const timer = setTimeout(() => {
      a.pause();
      setSleep(0);
    }, sleep * 60_000);
    return () => clearTimeout(timer);
  }, [sleep]);

  const seek = (to: number) => {
    const a = audio.current!;
    a.currentTime = Math.max(0, Math.min(to, a.duration || 0));
  };
  const skipClass =
    "h-[30px] rounded-lg px-2 text-[12px] font-bold text-[#c8c8c8] hover:bg-white/10";
  const timeClass = "w-[52px] text-[12px] text-[#a0a0a0] tabular-nums";

  return (
    <div className="fixed right-3 bottom-3 left-3 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-[#2a2a2a] p-3 shadow-2xl max-md:bottom-[76px] md:left-[233px]">
      <audio
        ref={audio}
        src={`/api/import?file=${book.file}`}
        autoPlay
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          setDuration(a.duration);
          // resume where it stopped, unless that was the very end
          if ((book.position ?? 0) < a.duration - 5) a.currentTime = book.position ?? 0;
        }}
        onEnded={() => patch(book.id, { progress: 1, position: 0 })}
      />
      <Cover book={book} w={44} />
      <div className="w-[150px] min-w-0">
        <p className="truncate text-[13px] font-bold">{book.title}</p>
        <p className="truncate text-[12px] text-[#a0a0a0]">{book.author}</p>
      </div>
      <div className="flex items-center gap-1">
        <button aria-label="Back 15 seconds" onClick={() => seek(time - 15)} className={skipClass}>
          −15
        </button>
        <button
          aria-label={paused ? "Play" : "Pause"}
          onClick={() => (paused ? audio.current!.play() : audio.current!.pause())}
          className={`${primaryClass} flex size-10 items-center justify-center`}
        >
          <Icon
            name={paused ? "play" : "pause"}
            className="size-5"
            fill={paused ? "currentColor" : "none"}
            strokeWidth={paused ? 1.7 : 3}
          />
        </button>
        <button
          aria-label="Forward 30 seconds"
          onClick={() => seek(time + 30)}
          className={skipClass}
        >
          +30
        </button>
      </div>
      <span className={`${timeClass} text-right`}>{clock(time)}</span>
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={duration || 1}
        value={time}
        onChange={(e) => seek(Number(e.target.value))}
        className="min-w-[120px] grow accent-[#3b9be0]"
      />
      <span className={timeClass}>{clock(duration)}</span>
      <button
        aria-label="Playback speed"
        onClick={() => {
          const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
          audio.current!.playbackRate = next;
          setRate(next);
        }}
        className={`${controlClass} w-[58px]`}
      >
        {rate}×
      </button>
      <Popover
        label="Sleep timer"
        button={
          <>
            <Icon name="moon" className="size-4" />
            {sleep > 0 && `${sleep}m`}
          </>
        }
        buttonClass={`${controlClass} flex items-center gap-1`}
        panelClass="bottom-full right-0 mb-2 w-[150px]"
      >
        {SLEEP_MINUTES.map((m) => (
          <MenuItem
            key={m}
            label={m ? `${m} minutes` : "Off"}
            checked={sleep === m}
            onClick={() => setSleep(m)}
          />
        ))}
      </Popover>
      <button
        aria-label="Close player"
        onClick={onClose}
        className="text-[#a0a0a0] hover:text-white"
      >
        <Icon name="x" className="size-5" />
      </button>
    </div>
  );
}

function Stats() {
  const { s } = useContext(LibCtx);
  const now = new Date();
  const [chart, setChart] = useState<"Bar" | "Line">("Bar");
  const [year, setYear] = useState(now.getFullYear());
  const [tip, setTip] = useState<{ x: number; y: number; date: Date; seconds: number } | null>(
    null,
  );
  const goal = s.dailyGoal * 60;
  const day = (offset: number) => {
    const date = new Date(now);
    date.setDate(now.getDate() + offset);
    return { date, seconds: s.log[dayKey(date)] ?? 0 };
  };
  const span = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.round(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  const describe = ({ date, seconds }: { date: Date; seconds: number }) =>
    `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${span(seconds)}`;

  const days = Array.from({ length: 30 }, (_, i) => day(i - 29));
  const allTime = Object.values(s.log).reduce((sum, seconds) => sum + seconds, 0);
  // Chart ceiling in minutes, a multiple of 4 so the five axis ticks are whole numbers.
  const top = Math.max(4, Math.ceil(Math.max(...days.map((d) => d.seconds)) / 60 / 4) * 4);
  const height = (seconds: number) => `${(seconds / 60 / top) * 100}%`;
  // Activity grid: 53 weeks ending with this one, each a Sunday-first column.
  const weeks = Array.from({ length: 53 }, (_, week) =>
    Array.from({ length: 7 }, (_, d) => day((week - 52) * 7 + d - now.getDay())),
  );
  const shade = (seconds: number) =>
    seconds <= 0
      ? "bg-white/10"
      : seconds < goal / 2
        ? "bg-[#0e4429]"
        : seconds < goal
          ? "bg-[#006d32]"
          : seconds < goal * 2
            ? "bg-[#26a641]"
            : "bg-[#39d353]";

  const { current, record } = streaks(s.log, goal, now);
  const finished = s.books.filter(FILTERS.finished);
  const months = Array.from(
    { length: 12 },
    (_, m) =>
      finished.filter((b) =>
        b.finished!.startsWith(`${year}-${String(m + 1).padStart(2, "0")}`),
      ).length,
  );
  const tiles: [IconName, string | number, string][] = [
    ["book", finished.length, "Books read"],
    ["grid", span(allTime), "Total reading time"],
    ["clock", current, "Reading streak (days)"],
    ["chart", span(days.reduce((sum, d) => sum + d.seconds, 0) / 30), "Daily average"],
    ["shelf", s.books.length, "In library"],
    ["want", s.books.filter(FILTERS.want).length, "Want to read"],
    ["headphones", s.books.filter((b) => (b.progress ?? 0) > 0 && !b.finished).length, "Reading now"],
    ["finished", record, "Longest streak (days)"],
  ];
  const card = "rounded-2xl bg-[#2e2e2e] p-5";
  const heading = "text-[15px] font-bold";
  const yearButton = "rounded-lg p-1 hover:bg-white/10 disabled:opacity-30";

  return (
    <div className="flex flex-col gap-6 md:mr-[33px]">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([icon, value, label]) => (
          <div key={label} className={card}>
            <Icon name={icon} className="size-6" />
            <p className="mt-2 text-[22px] leading-tight font-bold">{value}</p>
            <p className="text-[12px] text-[#a0a0a0]">{label}</p>
          </div>
        ))}
      </div>

      <section className={card}>
        <h2 className={heading}>Last 30 Days</h2>
        <div className="mt-3 flex gap-2">
          {(["Bar", "Line"] as const).map((kind) => (
            <button
              key={kind}
              aria-pressed={chart === kind}
              onClick={() => setChart(kind)}
              className={`${controlClass} aria-pressed:bg-white/25`}
            >
              {kind} Chart
            </button>
          ))}
        </div>
        <div className="mt-5 flex gap-3 text-[11px] text-[#a0a0a0]">
          <div className="flex h-[150px] flex-col justify-between text-right leading-none">
            {[4, 3, 2, 1, 0].map((tick) => (
              <span key={tick}>{(top * tick) / 4}m</span>
            ))}
          </div>
          <div className="min-w-0 grow">
            <div className="relative h-[150px]">
              {[0, 1, 2, 3, 4].map((line) => (
                <span
                  key={line}
                  className="absolute inset-x-0 border-t border-white/5"
                  style={{ top: `${line * 25}%` }}
                />
              ))}
              {chart === "Bar" ? (
                <div className="absolute inset-0 flex items-end gap-[3px]">
                  {days.map((d) => (
                    <div
                      key={dayKey(d.date)}
                      title={describe(d)}
                      className={`grow rounded-t-[3px] ${d.seconds >= goal ? "bg-[#1c9be6]" : "bg-white/30"}`}
                      style={{ height: height(d.seconds) }}
                    />
                  ))}
                </div>
              ) : (
                <svg
                  viewBox="0 0 29 100"
                  preserveAspectRatio="none"
                  className="absolute inset-0 size-full overflow-visible"
                  fill="none"
                  aria-hidden
                >
                  <polyline
                    points={days
                      .map((d, i) => `${i},${100 - (d.seconds / 60 / top) * 100}`)
                      .join(" ")}
                    stroke="#1c9be6"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
            </div>
            <div className="mt-2 flex justify-between">
              {days
                .filter((_, i) => i % 5 === 0)
                .map(({ date }) => (
                  <span key={dayKey(date)}>
                    {date.getMonth() + 1}/{date.getDate()}
                  </span>
                ))}
            </div>
          </div>
        </div>
      </section>

      <section className={`${card} relative`} onMouseLeave={() => setTip(null)}>
        <h2 className={heading}>Reading Activity</h2>
        <div className="mt-3 text-[10px] text-[#a0a0a0]">
          <div className="ml-8 grid grid-cols-[repeat(53,minmax(0,1fr))] gap-[2px] md:gap-[3px]">
            {weeks.map(([sunday]) => (
              <span key={dayKey(sunday.date)} className="h-4 whitespace-nowrap">
                {sunday.date.getDate() <= 7 &&
                  sunday.date.toLocaleDateString("en-US", { month: "short" })}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="grid w-6 grid-rows-7 gap-[2px] leading-none md:gap-[3px]">
              {["", "Mon", "", "Wed", "", "Fri", ""].map((name, i) => (
                <span key={i} className="flex items-center">
                  {name}
                </span>
              ))}
            </div>
            {/* 1fr columns, so the year always fits the card: no scrolling at any width */}
            <div className="grid min-w-0 grow grid-flow-col grid-cols-[repeat(53,minmax(0,1fr))] grid-rows-7 gap-[2px] md:gap-[3px]">
              {weeks.flat().map((d) => {
                const show = (e: { currentTarget: HTMLElement }) => {
                  const cell = e.currentTarget.getBoundingClientRect();
                  const box = e.currentTarget.closest("section")!.getBoundingClientRect();
                  setTip({
                    ...d,
                    // keep the bubble inside the card at the edges
                    x: Math.min(
                      Math.max(cell.left - box.left + cell.width / 2, 95),
                      box.width - 95,
                    ),
                    y: cell.top - box.top - 6,
                  });
                };
                return (
                  <span
                    key={dayKey(d.date)}
                    onMouseEnter={show}
                    onClick={show}
                    className={`aspect-square rounded-[20%] hover:ring-1 hover:ring-white/60 ${d.date > now ? "invisible" : shade(d.seconds)}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-[3px]">
            Less
            {[0, goal / 4, goal * 0.75, goal, goal * 2].map((seconds) => (
              <span key={seconds} className={`size-[10px] rounded-[20%] ${shade(seconds)}`} />
            ))}
            More
          </div>
        </div>
        {tip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 w-[180px] -translate-x-1/2 -translate-y-full rounded-lg border border-white/15 bg-[#1b1b1b] px-3 py-2 text-center text-[12px] shadow-2xl"
            style={{ left: tip.x, top: tip.y }}
          >
            <p className="font-bold">
              {tip.seconds ? `${span(tip.seconds)} read` : "No reading"}
            </p>
            <p className="text-[#a0a0a0]">
              {tip.date.toLocaleDateString("en-US", {
                weekday: "short",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
            {tip.seconds > 0 && (
              <p className="text-[#a0a0a0]">
                {Math.round((tip.seconds / goal) * 100)}% of your {s.dailyGoal}-minute goal
              </p>
            )}
          </div>
        )}
      </section>

      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={heading}>Books Finished per Month</h2>
          <div className="flex items-center gap-2 text-[13px] font-bold">
            <button
              aria-label="Previous year"
              onClick={() => setYear(year - 1)}
              className={yearButton}
            >
              <Icon name="chevronLeft" className="size-4" />
            </button>
            {year}
            <button
              aria-label="Next year"
              disabled={year >= now.getFullYear()}
              onClick={() => setYear(year + 1)}
              className={yearButton}
            >
              <Icon name="chevronRight" className="size-4" />
            </button>
          </div>
        </div>
        <div className="mt-4 flex h-[150px] gap-2 text-center text-[11px] text-[#a0a0a0]">
          {months.map((n, m) => (
            <div key={m} className="flex grow basis-0 flex-col justify-end gap-1">
              {n}
              <span
                className={`rounded-[4px] ${n ? "bg-[#1c9be6]" : "bg-white/15"}`}
                style={{ height: n ? `${(n / Math.max(...months)) * 70}%` : 3 }}
              />
              {new Date(2000, m).toLocaleDateString("en-US", { month: "short" })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

type NavItem = { id: string; label: string; icon: IconName };

const TOP_NAV: NavItem[] = [
  { id: "search", label: "Search", icon: "search" },
  { id: "home", label: "Home", icon: "home" },
  { id: "stats", label: "Reading Stats", icon: "chart" },
];

/** Bottom tab bar on phones; everything else is in the sidebar drawer behind "More". */
const MOBILE_TABS: NavItem[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "all", label: "Library", icon: "shelf" },
  { id: "stats", label: "Stats", icon: "chart" },
  { id: "search", label: "Search", icon: "search" },
];

const LIBRARY_NAV: NavItem[] = [
  { id: "all", label: "All", icon: "shelf" },
  { id: "want", label: "Want to Read", icon: "want" },
  { id: "finished", label: "Finished", icon: "finished" },
  { id: "books", label: "Books", icon: "book" },
  { id: "audiobooks", label: "Audiobooks", icon: "headphones" },
  { id: "pdfs", label: "PDFs", icon: "doc" },
];

// 32px + 2px gap keeps the 34px pitch without hover touching the selected row.
const itemClass =
  "mb-[2px] flex h-[32px] w-full items-center gap-[10px] rounded-lg px-[10px] text-left text-[13.500px] font-medium";
const headingClass = "mt-[15px] mb-[7px] px-[7px] text-[13.500px] font-bold";
const NAME = USER ?? "Guest";
const UNKNOWN_AUTHOR = "Unknown Author";
const PALETTE: Book["cover"][] = [
  ["#23254d", "#07070c"],
  ["#2f9d5c", "#04201f"],
  ["#f0a030", "#8a3a14"],
  ["#7a2f3a", "#1c0a10"],
  ["#2b5d8a", "#0a1a2a"],
  ["#5a3d8a", "#150d24"],
];

export default function Page() {
  const [s, setS] = useState(INITIAL);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("home"); // nav id, or `c:<collection id>`
  const [renaming, setRenaming] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [hud, setHud] = useState<{ title: string; text: string } | null>(null);
  const requested = useRef(new Set<string>());
  const [navOpen, setNavOpen] = useState(false); // sidebar drawer on narrow windows
  const [importing, setImporting] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [progress, setProgress] = useState<{ done: number; failed: number; total: number } | null>(null);
  const dragId = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null); // audiobook in the player
  const [editing, setEditing] = useState<string | null>(null); // book in Edit Details
  const [readingId, setReadingId] = useState<string | null>(null); // book open in the reader
  const [settingsTab, setSettingsTab] = useState<string | null>(null); // open settings modal

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) setS({ ...INITIAL, ...JSON.parse(raw) });
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }, [s, loaded]);

  useEffect(() => {
    if (!hud) return;
    const timer = setTimeout(() => setHud(null), 2200);
    return () => clearTimeout(timer);
  }, [hud]);

  const set: Lib["set"] = (fn) => setS((prev) => ({ ...prev, ...fn(prev) }));
  const patch: Lib["patch"] = (id, p) =>
    set((prev) => ({
      books: prev.books.map((b) => (b.id === id ? { ...b, ...p } : b)),
    }));
  const toast: Lib["toast"] = (title, text) => setHud({ title, text });
  const go = (v: string) => {
    setView(v);
    setDetail(null);
    setNavOpen(false);
  };

  const importFiles: Lib["importFiles"] = async (files) => {
    let done = 0;
    let failed = 0;
    for (const f of files) {
      setProgress({ done, failed, total: files.length });
      const kind = kindOf(f.name);
      try {
        if (!kind) throw new Error("Unsupported file type");
        const res = await fetch(`/api/import?name=${encodeURIComponent(f.name)}`, {
          method: "PUT",
          body: f,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { file } = await res.json();
        const book: Book = {
          id: file,
          file,
          kind,
          title: f.name.replace(/\.[^.]+$/, "").replace(/_+/g, " ").trim(),
          author: UNKNOWN_AUTHOR,
          cover: PALETTE[f.name.length % PALETTE.length],
          added: dayKey(new Date()),
          isNew: true,
        };
        set((prev) => ({ books: [...prev.books, book] }));
        done++;
      } catch {
        failed++;
      }
    }
    setProgress(null);
    toast(
      done ? "Imported" : "Import Failed",
      `${done} of ${files.length} file${files.length === 1 ? "" : "s"} added to your library.${failed ? ` ${failed} failed or had an unsupported type.` : ""}`,
    );
  };

  // Files dropped anywhere on the window are imported; in-app drags (manual sort) carry no files.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(true);
    };
    const leave = (e: DragEvent) => !e.relatedTarget && setDropping(false);
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      setImporting(false);
      importFiles([...e.dataTransfer!.files]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
    // importFiles only touches state setters, so the first render's closure stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shelf views: a nav id, `c:<collection id>`, `s:<series>` or `t:<tag>`.
  const collection = s.collections.find((c) => `c:${c.id}` === view);
  const series = view.startsWith("s:") ? view.slice(2) : null;
  const tag = view.startsWith("t:") ? view.slice(2) : null;
  const isShelf = view in FILTERS || !!collection || !!series || !!tag;
  const sortable = isShelf && s.sort === "Manual" && view !== "finished" && !series;

  /** Moves `from` next to `to`: after it when moving later in the order, before it otherwise. */
  const reorder = (from: string, to: string) =>
    set((prev) => {
      const moved = prev.books.find((b) => b.id === from)!;
      const rest = prev.books.filter((b) => b.id !== from);
      const forward = prev.books.indexOf(moved) < prev.books.findIndex((b) => b.id === to);
      rest.splice(rest.findIndex((b) => b.id === to) + (forward ? 1 : 0), 0, moved);
      return { books: rest };
    });

  // Fetch other readers' ratings once per book; the result is saved with the book.
  useEffect(() => {
    if (!loaded || !s.lookups) return;
    for (const b of s.books) {
      // keyed on title/author too, so editing either triggers a fresh lookup
      const key = `${b.id}|${b.title}|${b.author}`;
      if (b.kind === "pdf" || b.info !== undefined || requested.current.has(key)) continue;
      requested.current.add(key);
      lookup(b).then(
        (info) => patch(b.id, { info }),
        () => {}, // offline or Open Library down: try again next visit
      );
    }
  });

  const lib: Lib = {
    s,
    set,
    patch,
    toast,
    setView: go,
    setDetail,
    openImport: () => setImporting(true),
    importFiles,
    sortable,
    move: (id, by) => {
      const to = books[books.findIndex((b) => b.id === id) + by];
      if (to) reorder(id, to.id);
    },
    play: (id) => {
      if (!s.books.find((b) => b.id === id)?.file)
        return toast("No File", "Import the audiobook file to listen to it.");
      setPlaying(id);
      setDetail(null);
    },
    read: (id) => {
      setReadingId(id);
      setDetail(null);
    },
    edit: setEditing,
    drag: (id) =>
      !sortable
        ? {}
        : {
            draggable: true,
            onDragStart: (e) => {
              dragId.current = id;
              e.dataTransfer.effectAllowed = "move";
            },
            onDragEnd: () => {
              dragId.current = null;
            },
            onDragOver: (e) => {
              if (dragId.current) e.preventDefault();
            },
            onDrop: (e) => {
              e.preventDefault();
              const from = dragId.current;
              if (!from || from === id) return;
              reorder(from, id);
            },
          },
    toggleWant: (b) => {
      patch(b.id, { want: !b.want });
      toast(
        b.want ? "Removed" : "Added",
        `“${b.title}” was ${b.want ? "removed from" : "added to"} your Want to Read list.`,
      );
    },
    toggleFinished: (b) => {
      patch(b.id, {
        finished: b.finished ? undefined : dayKey(new Date()),
      });
      toast(
        b.finished ? "Unfinished" : "Finished",
        `“${b.title}” was ${b.finished ? "removed from" : "added to"} your Finished list.`,
      );
    },
    newCollection: (bookId) => {
      const id = Date.now().toString(36);
      set((prev) => ({
        collections: [
          ...prev.collections,
          { id, name: "Untitled Shelf", bookIds: bookId ? [bookId] : [] },
        ],
      }));
      go(`c:${id}`);
      setRenaming(id);
    },
  };

  const title =
    collection?.name ??
    series ??
    tag ??
    [...TOP_NAV, ...LIBRARY_NAV].find((n) => n.id === view)?.label;
  const tags = [...new Set(s.books.flatMap((b) => b.tags ?? []))].sort();
  const playingBook = s.books.find((b) => b.id === playing && b.file);
  const editingBook = s.books.find((b) => b.id === editing);
  const readingBook = s.books.find((b) => b.id === readingId && b.file);

  const deleteShelf = (id: string) => {
    set((prev) => ({ collections: prev.collections.filter((c) => c.id !== id) }));
    if (view === `c:${id}`) setView("all");
  };

  const books = isShelf
    ? s.books.filter(
        collection
          ? (b) => collection.bookIds.includes(b.id)
          : series
            ? (b) => b.series === series
            : tag
              ? (b) => !!b.tags?.includes(tag)
              : FILTERS[view],
      )
    : [];
  if (s.sort === "Title") books.sort((a, b) => a.title.localeCompare(b.title));
  else if (s.sort === "Author") books.sort((a, b) => a.author.localeCompare(b.author));
  else if (view === "finished") books.sort((a, b) => b.finished!.localeCompare(a.finished!));
  else if (s.sort === "Recent") books.sort(newestFirst);
  else if (series) books.sort(bySeriesIndex);

  // Want to Read is list-only.
  const layout =
    view === "want"
      ? "List"
      : (s.layouts[view] ?? (view === "finished" ? "List" : "Grid"));
  const empty = EMPTY[collection ? "collection" : view] ?? EMPTY.all;

  const count = (kind: Kind, noun: string) => {
    const n = books.filter((b) => b.kind === kind).length;
    return n ? [`${n} ${noun}${n === 1 ? "" : "s"}`] : [];
  };

  const navButton = (id: string, label: string, icon: IconName) => (
    <button
      key={id}
      onClick={() => go(id)}
      onDoubleClick={() => id.startsWith("c:") && setRenaming(id.slice(2))}
      className={`${itemClass} ${view === id ? "bg-[#737373]" : "hover:bg-white/5"}`}
    >
      <Icon name={icon} />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <LibCtx value={lib}>
      <div className="flex h-full">
        {navOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/50 md:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}
        <aside
          className={`my-[9px] mt-[13px] ml-[9px] flex w-[212px] shrink-0 flex-col rounded-[18px] border border-white/10 bg-[#1b1b1b] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform ${navOpen ? "" : "max-md:-translate-x-[240px]"}`}
        >
          <nav className="grow overflow-y-auto px-[9px] pt-[13px]">
            {TOP_NAV.map((n) => navButton(n.id, n.label, n.icon))}
            <h3 className={headingClass}>Library</h3>
            {LIBRARY_NAV.map((n) => navButton(n.id, n.label, n.icon))}
            <h3 className={headingClass}>My Shelves</h3>
            {s.collections.map((c) =>
              renaming === c.id ? (
                <div key={c.id} className={`${itemClass} bg-[#737373]`}>
                  <Icon name="lines" />
                  <input
                    autoFocus
                    aria-label="Shelf name"
                    defaultValue={c.name}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    onBlur={(e) => {
                      const name = e.target.value.trim() || c.name;
                      set((prev) => ({
                        collections: prev.collections.map((x) =>
                          x.id === c.id ? { ...x, name } : x,
                        ),
                      }));
                      setRenaming(null);
                    }}
                    className="w-full min-w-0 bg-[#1e1e1e] px-1 outline-none"
                  />
                </div>
              ) : (
                <div key={c.id} className="group relative [&>button]:pr-8">
                  {navButton(`c:${c.id}`, c.name, "lines")}
                  <div className="absolute top-[6px] right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-md:opacity-100">
                    <Popover
                      label={`Options for ${c.name}`}
                      button={DOTS}
                      buttonClass="block py-[7px] text-[#d0d0d0] hover:text-white"
                      panelClass="top-6 right-0 w-[150px]"
                    >
                      <MenuItem icon="pencil" label="Rename" onClick={() => setRenaming(c.id)} />
                      <MenuItem icon="trash" label="Delete" onClick={() => deleteShelf(c.id)} />
                    </Popover>
                  </div>
                </div>
              ),
            )}
            <button
              onClick={() => lib.newCollection()}
              className={`${itemClass} hover:bg-white/5`}
            >
              <Icon name="plus" />
              New Shelf
            </button>
            {tags.length > 0 && <h3 className={headingClass}>Tags</h3>}
            {tags.map((t) => navButton(`t:${t}`, t, "tag"))}
          </nav>
            <div className="p-[9px]">
              <Popover
                label="Account menu"
                buttonClass="flex w-full items-center gap-[9px] rounded-lg p-[10px] text-left hover:bg-white/5 aria-expanded:bg-white/10"
                button={
                  <>
                    <span className="flex size-[38px] items-center justify-center rounded-full bg-[#4a4a4a] text-[16px] font-bold">
                      {NAME[0].toUpperCase()}
                    </span>
                    <span className="truncate text-[13.500px] font-bold">{NAME}</span>
                  </>
                }
                panelClass="bottom-full left-0 mb-1 w-full"
              >
                <p className="truncate px-[6px] py-1 text-[12px] text-[#9a9a9a]">{NAME}</p>
                <MenuItem
                  icon="settings"
                  label="Settings"
                  onClick={() => {
                    setNavOpen(false);
                    setSettingsTab("profile");
                  }}
                />
                <MenuItem
                  icon="import"
                  label="Import Books"
                  onClick={() => {
                    setNavOpen(false);
                    setImporting(true);
                  }}
                />
                <MenuItem
                  icon="help"
                  label="Get Help"
                  onClick={() => {
                    setNavOpen(false);
                    setSettingsTab("help");
                  }}
                />
              </Popover>
            </div>
        </aside>

        <main
          className={`relative flex min-w-0 grow flex-col overflow-y-auto px-4 pt-6 md:pt-[52px] md:pr-[10px] md:pl-[43px] ${playingBook ? "pb-[130px] max-md:pb-[250px]" : "pb-[27px] max-md:pb-[90px]"}`}
        >
          {!loaded ? null : view === "search" ? (
            <Search />
          ) : (
            <>
              <div className="mb-8 flex items-center justify-between gap-4 md:mr-[33px] md:mb-[44px]">
                <h1 className="font-serif text-[36px] leading-[52px] font-bold">{title}</h1>
                {view === "home" && (
                  <button
                    onClick={() => setImporting(true)}
                    className="flex h-[36px] shrink-0 items-center gap-2 rounded-lg border border-white/10 px-4 text-[13px] font-bold hover:bg-white/5"
                  >
                    <Icon name="import" className="size-4" strokeWidth={2} />
                    Import
                  </button>
                )}
              </div>
              {view === "home" ? (
                <Home />
              ) : view === "stats" ? (
                <Stats />
              ) : books.length === 0 ? (
                <EmptyState title={empty[0]} text={empty[1]} />
              ) : layout === "Grid" ? (
                <Grid
                  books={books}
                  group={["all", "books", "audiobooks", "pdfs"].includes(view)}
                />
              ) : view === "finished" ? (
                <Timeline books={books} />
              ) : (
                <List books={books} community={view === "want"} />
              )}
            </>
          )}

          {isShelf && (
            <>
              <div className="fixed top-[13px] right-[10px] z-10">
                <Popover
                  label="View options"
                  buttonClass="flex h-[37px] w-[50px] items-center justify-center gap-[2px] rounded-full border border-white/10 bg-[#1e1e1e] hover:bg-[#2a2a2a] aria-expanded:bg-[#4a4a4a]"
                  button={
                    <>
                      <svg viewBox="0 0 18 6" className="w-4" fill="currentColor">
                        <circle cx="3" cy="3" r="1.600" />
                        <circle cx="9" cy="3" r="1.600" />
                        <circle cx="15" cy="3" r="1.600" />
                      </svg>
                      <Icon name="chevronDown" className="size-3" strokeWidth={2.4} />
                    </>
                  }
                  panelClass="top-[35px] right-[-2px] w-[223px]"
                >
                  {view !== "want" && (
                    <>
                      {(["Grid", "List"] as const).map((l) => (
                        <MenuItem
                          key={l}
                          label={l}
                          icon={l === "Grid" ? "grid" : "list"}
                          checked={layout === l}
                          onClick={() =>
                            set((prev) => ({ layouts: { ...prev.layouts, [view]: l } }))
                          }
                        />
                      ))}
                      {MENU_RULE}
                    </>
                  )}
                  <p className="px-7 pt-[9px] pb-1 text-[11px] font-bold text-[#777]">
                    Sort by...
                  </p>
                  {SORTS.map((sort) => (
                    <MenuItem
                      key={sort}
                      label={sort}
                      checked={s.sort === sort}
                      onClick={() => set(() => ({ sort }))}
                    />
                  ))}
                  {collection && (
                    <>
                      {MENU_RULE}
                      <MenuItem
                        label="Delete Shelf"
                        icon="trash"
                        checked={false}
                        onClick={() => deleteShelf(collection.id)}
                      />
                    </>
                  )}
                </Popover>
              </div>

              <footer className="mt-auto pt-12 text-center text-[13.500px] leading-[19px] text-[#9a9a9a] md:pr-[33px]">
                {[
                  ...count("book", "book"),
                  ...count("audiobook", "audiobook"),
                  ...count("pdf", "PDF"),
                ].join(", ")}
              </footer>
            </>
          )}
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/10 bg-[#1b1b1b]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          {MOBILE_TABS.map((n) => (
            <button
              key={n.id}
              onClick={() => go(n.id)}
              className={`flex grow basis-0 flex-col items-center gap-[2px] py-2 text-[10px] font-medium ${view === n.id ? "text-white" : "text-[#8c8c8c]"}`}
            >
              <Icon name={n.icon} className="size-6" />
              {n.label}
            </button>
          ))}
          <button
            onClick={() => setNavOpen(true)}
            className="flex grow basis-0 flex-col items-center gap-[2px] py-2 text-[10px] font-medium text-[#8c8c8c]"
          >
            <Icon name="lines" className="size-6" />
            More
          </button>
        </nav>
        {settingsTab && (
          <SettingsSheet
            tab={settingsTab}
            onTab={setSettingsTab}
            onClose={() => setSettingsTab(null)}
          />
        )}
        {detail && <Detail {...detail} />}
        {editingBook && <EditSheet book={editingBook} onClose={() => setEditing(null)} />}
        {readingBook && (
          <Reader key={readingBook.id} book={readingBook} onClose={() => setReadingId(null)} />
        )}
        {playingBook && (
          <Player key={playingBook.id} book={playingBook} onClose={() => setPlaying(null)} />
        )}
        {importing && <ImportSheet onClose={() => setImporting(false)} />}
        {dropping && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-[28px] border-2 border-dashed border-white/30 text-center">
              <Icon name="import" className="size-12 text-[#a0a0a0]" />
              <p className="font-serif text-[24px] font-bold">Drop to Import</p>
              <p className="max-w-[520px] text-[13px] text-[#a0a0a0]">{FORMATS}</p>
            </div>
          </div>
        )}
        {progress && (
          <p
            role="status"
            className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#3a3a3c] px-5 py-2 text-[13.500px] shadow-2xl max-md:bottom-[76px] md:left-[calc(50%+110px)]"
          >
            Importing: {progress.done + progress.failed + 1} of {progress.total}. Failed:{" "}
            {progress.failed}
          </p>
        )}
        {hud && (
          <div
            role="status"
            className="pointer-events-none fixed top-1/2 left-1/2 z-50 w-[258px] -translate-x-1/2 -translate-y-1/2 rounded-[22px] bg-[#3a3a3c]/75 px-6 pt-10 pb-7 text-center backdrop-blur-2xl md:left-[calc(50%+110px)]"
          >
            <Icon
              name="finished"
              className="mx-auto size-[64px] text-[#b9b9b9]"
              strokeWidth={1.2}
            />
            <p className="mt-6 font-serif text-[21px] font-bold text-[#c9c9c9]">
              {hud.title}
            </p>
            <p className="mt-3 text-[13.500px] leading-[20px]">{hud.text}</p>
          </div>
        )}
      </div>
    </LibCtx>
  );
}
