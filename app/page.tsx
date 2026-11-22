"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ACCEPT, AUDIO, EBOOK, kindOf } from "./formats";
import { addSession, clock, dayKey, streaks } from "./reading";
import {
  DOTS,
  EmptyState,
  Icon,
  MENU_RULE,
  MenuItem,
  Popover,
  Sheet,
  ask,
  closeClass,
  controlClass,
  fieldClass,
  panelClass,
  primaryClass,
  sheetClass,
  type IconName,
} from "./ui";
import { Reader, READABLE, extOf, pdfCover, warmReader } from "./reader";
import {
  canWorkOffline,
  download,
  downloadedFiles,
  forgetLibrary,
  loadPending,
  registerWorker,
  removeDownloads,
  savePending,
} from "./offline";
import {
  DEFAULT_PREFS,
  INFO_VERSION,
  SORTS,
  diff,
  type Book,
  type Found,
  type Kind,
  type Batch,
  type Saved,
  applyBatch,
  mergeBatch,
} from "./sync";

const INITIAL: Saved = { ...DEFAULT_PREFS, books: [], log: {} };

const KIND_LABEL: Record<Kind, string> = {
  book: "Book",
  audiobook: "Audiobook",
  pdf: "PDF",
  comic: "Comic",
};

const FILTERS: Record<string, (b: Book) => boolean> = {
  all: () => true,
  want: (b) => !!b.want,
  finished: (b) => !!b.finished,
  books: (b) => b.kind === "book",
  audiobooks: (b) => b.kind === "audiobook",
  pdfs: (b) => b.kind === "pdf",
  comics: (b) => b.kind === "comic",
};

const EMPTY: Record<string, [string, string]> = {
  all: ["No Books", "Books, audiobooks and PDFs you add to your library will appear here."],
  want: ["No Books", "To add to Want to Read, choose Add to Want to Read from a book menu."],
  finished: ["No Books", "To add to Finished, choose Mark as Finished from a book menu."],
  books: ["No Books", "Books in your library will automatically be added to this shelf."],
  audiobooks: ["No Audiobooks", "Audiobooks in your library will automatically be added to this shelf."],
  pdfs: ["No PDFs", "PDFs in your library will automatically be added to this shelf."],
  comics: ["No Manga or Comics", "Manga, manhwa and comics (CBZ files) in your library will automatically be added to this shelf."],
  collection: ["No Books", "To add to this shelf, choose Add to Shelf from a book or audiobook menu."],
};

const newestFirst = (a: Book, b: Book) => b.added.localeCompare(a.added);
const bySeriesIndex = (a: Book, b: Book) => (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9);
const compact = new Intl.NumberFormat("en", { notation: "compact" }).format;
/** On a book that is only on your lists: there is no file on the server to open. */
const NOT_OWNED = (
  <span
    data-tip="On your lists only. There is no file to read or listen to yet."
    className="shrink-0 rounded-full bg-[#4a3a1c] px-[7px] py-[2px] text-[11px] font-bold leading-[14px] tracking-wide whitespace-nowrap text-[#ffd9a0]"
  >
    NOT OWNED
  </span>
);

type DetailState = { ids: string[]; id: string }; // ids = the list the arrows step through

type Social = {
  people: { id: number; name: string }[]; // everyone else in the family
  // mine: may rename and delete. owned: made it, so chooses who sees it. members: null = whole family.
  shelves: { id: number; name: string; bookIds: string[]; mine: boolean; owned: boolean; members: number[] | null }[];
  activity: { name: string; book: string; progress?: number; finished?: string; rating?: number }[];
  recs: { book: string; name: string }[];
};
const NO_SOCIAL: Social = { people: [], shelves: [], activity: [], recs: [] };

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
  /** Opens the info page of a catalogue book that is not in the library. */
  preview: (f: Found) => void;
  /** Opens the "Who's reading?" profile picker. */
  pickProfile: () => void;
  /** What the people on this server share: shared shelves, their reading, recommendations to you. */
  social: Social;
  /** Calls the social API and refreshes `social`; resolves to the answer, or null when it failed. */
  socialCall: (body: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  /** Stored names of the book files kept on this device for offline reading. */
  offline: Set<string>;
  /** Ids of the books being downloaded right now. */
  downloading: Set<string>;
  /** Downloads the book to this device, or removes it when it is already here. */
  keepOffline: (book: Book) => Promise<void>;
  clearOffline: () => Promise<void>;
  openImport: () => void;
  importFiles: (files: File[]) => void;
  /** Puts a book the server just created or changed into the library. */
  addBook: (book: Book) => void;
  /** Drag-to-reorder props for a book's element; empty unless the shelf is in Manual sort. */
  drag: (id: string) => HTMLAttributes<HTMLDivElement>;
  /** True when the open shelf is in Manual sort and can be reordered. */
  sortable: boolean;
  /** Keyboard/touch alternative to dragging: swap with the previous or next book on the shelf. */
  move: (id: string, by: -1 | 1) => void;
  play: (id: string) => void;
  edit: (id: string) => void;
  /** Opens a file in the in-app reader. */
  read: (id: string) => void;
  user: Account;
  logout: () => void;
};
const LibCtx = createContext<Lib>(null!);

function BookMenu({ book }: { book: Book }) {
  const {
    s,
    set,
    toggleWant,
    toggleFinished,
    toast,
    newCollection,
    edit,
    sortable,
    move,
    user,
    setDetail,
    social,
    socialCall,
  } = useContext(LibCtx);
  return (
    <Popover
      label={`Options for ${book.title}`}
      button={DOTS}
      buttonClass="block shrink-0 py-1 text-[#b4b4b4] hover:text-white max-md:p-2"
      panelClass="w-[230px] max-md:w-[270px]"
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
      <MenuItem icon="book" label="View Details" onClick={() => setDetail({ ids: [book.id], id: book.id })} />
      <MenuItem icon="pencil" label="Edit Details…" onClick={() => edit(book.id)} />
      {book.file && <MenuItem icon="cloudDown" label="Save a Copy…" onClick={() => saveCopy(book)} />}
      {/* Manga in EPUB form that wasn't recognised as such, or a book that was mistaken for one. */}
      {/\.(epub|cbz)$/.test(book.file ?? "") && (
        <MenuItem
          icon={book.kind === "comic" ? "book" : "panels"}
          label={book.kind === "comic" ? "Move to Books" : "Move to Manga & Comics"}
          onClick={() =>
            set((prev) => ({
              books: prev.books.map((b) =>
                b.id === book.id ? { ...b, kind: book.kind === "comic" ? "book" : "comic" } : b,
              ),
            }))
          }
        />
      )}
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
      {social.shelves.length > 0 && (
        <p className="px-[6px] pt-2 pb-[3px] text-[11px] font-bold text-[#777]">Shared with Family</p>
      )}
      {social.shelves.map((c) => (
        <MenuItem
          key={c.id}
          label={c.name}
          checked={c.bookIds.includes(book.id)}
          onClick={() => socialCall({ action: "toggleBook", id: c.id, book: book.id })}
        />
      ))}
      {social.people.length > 0 && (
        <>
          {MENU_RULE}
          <p className="px-[6px] pt-1 pb-[3px] text-[11px] font-bold text-[#777]">Recommend To</p>
          {social.people.map((p) => (
            <MenuItem
              key={p.id}
              icon="user"
              label={p.name}
              onClick={async () => {
                if (await socialCall({ action: "recommend", to: p.id, book: book.id }))
                  toast("Recommended", `${p.name} will see “${book.title}” on their Home page.`);
              }}
            />
          ))}
        </>
      )}
      {/* Removing deletes the book and its files for everyone, so only the admin can.
          A book without a file (added from Discover) only leaves your own lists. */}
      {(user.admin || !book.file) && (
        <>
          {MENU_RULE}
          <MenuItem
            icon="trash"
            label="Remove…"
            onClick={async () => {
              const gone = await ask({
                title: `Remove “${book.title}”?`,
                text: book.file
                  ? "Its file is deleted from the server, for everyone."
                  : "It is taken off your lists.",
                action: "Remove",
                danger: true,
              });
              if (gone === null) return;
              set((prev) => ({
                books: prev.books.filter((b) => b.id !== book.id),
                collections: prev.collections.map((c) => ({
                  ...c,
                  bookIds: c.bookIds.filter((id) => id !== book.id),
                })),
              }));
            }}
          />
        </>
      )}
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

const filesOf = (book: Book) =>
  book.files?.length ? book.files.map((f) => f.file) : book.file ? [book.file] : [];

/** Saves a copy of the book's file (every part, for an audiobook) into the device's downloads. */
function saveCopy(book: Book) {
  const parts = filesOf(book);
  parts.forEach((file, i) => {
    const link = document.createElement("a");
    link.href = `/api/file?file=${file}`;
    // Named after the book rather than the stored id; parts are numbered.
    link.download = `${book.title.replace(/[\\/:*?"<>|]/g, " ").trim()}${parts.length > 1 ? ` ${i + 1}` : ""}.${extOf(file)}`;
    link.click();
  });
}

/**
 * Keeps the book on this device so it opens without a connection: a cloud with an arrow to
 * download, a tick once it is here (click again to remove it).
 */
function CloudButton({ book }: { book: Book }) {
  const { offline, downloading, keepOffline } = useContext(LibCtx);
  const parts = filesOf(book);
  if (!parts.length) return null;
  const here = parts.every((file) => offline.has(file));
  const busy = downloading.has(book.id);
  return (
    <button
      aria-label={
        busy
          ? `Downloading ${book.title}`
          : here
            ? `Remove download of ${book.title}`
            : `Download ${book.title} for offline reading`
      }
      data-tip={busy ? "Downloading…" : here ? "On this device. Click to remove." : "Download for offline reading"}
      disabled={busy}
      onClick={() => keepOffline(book)}
      className={`block hover:text-white max-md:p-1 ${busy ? "animate-pulse" : ""}`}
    >
      <Icon name={here ? "cloudDone" : "cloudDown"} className="size-5" strokeWidth={1.4} />
    </button>
  );
}

/** Cover art, or a generated stand-in: ebooks and PDFs are always 2:3, audiobooks square. */
function Cover({ book, w }: { book: Book; w: number }) {
  const size = {
    width: w,
    height: book.kind === "audiobook" ? w : w * 1.5,
    fontSize: w * 0.07,
  };
  const frame =
    "relative flex shrink-0 flex-col overflow-hidden rounded-[3px] shadow-[0_8px_18px_rgba(0,0,0,0.55)]";

  if (book.coverFile)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- served by the app's own file route, behind sign-in
      <img
        src={`/api/file?cover=${book.coverFile}`}
        alt=""
        loading="lazy"
        className={`${frame} bg-[#2e2e2e] object-cover`}
        style={size}
      />
    );

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
                <span className="absolute inset-x-4 -top-[10px] h-4 rounded-[3px] bg-white/10" />
                <span className="absolute inset-x-2 -top-[5px] h-4 rounded-[3px] bg-white/20" />
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
          // The halo of a selected book: the whole tile, from the cover down to its tag and menu.
          <div
            key={b.id}
            className="-m-2 w-[204px] rounded-lg p-2 focus-within:bg-white/15"
            {...drag(b.id)}
          >
            <CoverButton book={b} w={188} ids={ids} />
            <div className="mt-[10px] flex h-5 items-center gap-[6px] text-[#a8a8a8]">
              {b.kind === "audiobook" && <Icon name="headphones" className="size-4" />}
              {!b.file
                ? NOT_OWNED
                : !b.opened &&
                  !b.finished && (
                    <span className="rounded-full bg-[#1f3b68] px-[7px] py-[2px] text-[11px] font-bold leading-[14px] tracking-wide text-[#cfe0ff]">
                      NEW
                    </span>
                  )}
              <span className="grow" />
              <CloudButton book={b} />
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
          className="-m-2 flex items-center gap-4 rounded-lg p-2 focus-within:bg-white/10 max-md:bg-[#2e2e2e] max-md:p-3 md:gap-[29px]"
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
            {!b.file && <div className="mt-[6px] flex">{NOT_OWNED}</div>}
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
              <BookMenu book={b} />
              {!b.file ? NOT_OWNED : !b.opened && <span className="text-[12px]">Not opened yet</span>}
            </div>
          </div>
        </div>
      ))}
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

/** Number input with the app's own up/down arrows. Reports whole numbers from 1 to `max`. */
function NumberField({
  label,
  name,
  value,
  max,
  onPick,
  className,
}: {
  label: string;
  name?: string;
  value: number;
  max: number;
  onPick?: (n: number) => void;
  className: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = () => {
    const n = Math.round(Number(ref.current!.value));
    if (n >= 1 && n <= max) onPick?.(n);
  };
  return (
    <span className="relative inline-block shrink-0">
      <input
        ref={ref}
        name={name}
        aria-label={label}
        type="number"
        min={1}
        max={max}
        defaultValue={value}
        required
        onChange={pick}
        className={`${className} !pr-6 !pl-2 text-center`}
      />
      <span className="absolute inset-y-[3px] right-[3px] flex w-5 flex-col text-[#b4b4b4]">
        {([1, -1] as const).map((by) => (
          <button
            key={by}
            type="button"
            tabIndex={-1} // the arrow keys already do this from the field
            aria-label={`${by > 0 ? "Increase" : "Decrease"} ${label}`}
            onClick={() => {
              if (by > 0) ref.current!.stepUp();
              else ref.current!.stepDown();
              pick();
            }}
            className="flex min-h-0 flex-1 items-center justify-center rounded hover:bg-white/15 hover:text-white"
          >
            <Icon name={by > 0 ? "chevronUp" : "chevronDown"} className="size-3" strokeWidth={2.4} />
          </button>
        ))}
      </span>
    </span>
  );
}

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
          <NumberField
            label={title}
            name="goal"
            value={value}
            max={max}
            className={`${fieldClass} !w-[84px] text-[18px] font-bold`}
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

function Home() {
  const { s, set, setView, setDetail, play, read: openReader, social, socialCall } = useContext(LibCtx);
  const known = <T extends { book: string }>(items: T[]) =>
    items.flatMap((item) => {
      const book = s.books.find((b) => b.id === item.book);
      return book ? [{ ...item, book }] : [];
    });
  const recs = known(social.recs);
  const activity = known(social.activity);
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
      : canRead(b)
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
      {reading.length > 0 && (
        // Everything in progress, most recent first. Bottom-aligned, so a square audiobook
        // cover stands on the same line as the books and is only shorter at the top.
        // On phones: one row of smaller covers to swipe through, so the page below stays in reach.
        <section className="mb-[34px] flex shrink-0 items-end gap-x-[27px] gap-y-8 max-md:-mx-[22px] max-md:overflow-x-auto max-md:px-[22px] max-md:[zoom:0.72] md:mr-[33px] md:flex-wrap">
          {reading.map((b) => (
            <div key={b.id} className="w-[188px] shrink-0">
              <div
                role="button"
                tabIndex={0}
                aria-label={`Continue ${b.title}`}
                onClick={() => open(b)}
                onKeyDown={(e) => e.key === "Enter" && open(b)}
                className="cursor-pointer"
              >
                <Cover book={b} w={188} />
              </div>
              <p className="mt-3 truncate text-[15px]" data-tip={b.title}>
                {b.title}
              </p>
              <div className="mt-1 flex items-center justify-between text-[13px] text-[#9a9a9a]">
                {percent(b)}
                <BookMenu book={b} />
              </div>
            </div>
          ))}
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
              className="flex items-center justify-center rounded-[3px] border border-dashed border-white/15 font-serif text-white/15"
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

      {recs.length > 0 && (
        <Section title="Recommended to You">
          <div className="flex flex-wrap items-end gap-x-[27px] gap-y-8">
            {recs.map(({ book, name }) => (
              <div key={book.id + name} className="w-[140px]">
                <CoverButton book={book} w={140} ids={recs.map((r) => r.book.id)} />
                <p className="mt-2 truncate text-[13px] font-semibold">{book.title}</p>
                <div className="flex items-center justify-between gap-2 text-[12px] text-[#9a9a9a]">
                  <span className="truncate">From {name}</span>
                  <button
                    onClick={() => socialCall({ action: "dismiss", book: book.id })}
                    className="shrink-0 hover:text-white"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {activity.length > 0 && (
        <Section title="What Others Are Reading">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-[25px] md:mr-[33px] md:grid-cols-2">
            {activity.map(({ book, name, progress, finished, rating }) => (
              <div key={name + book.id + (finished ?? "")} className="border-b border-white/10 py-[2px]">
                <button
                  onClick={() => setDetail({ ids: [book.id], id: book.id })}
                  className="flex w-full items-center gap-[18px] rounded-lg p-2 text-left hover:bg-white/5"
                >
                  <Cover book={book} w={44} />
                  <span className="min-w-0 text-[13px] leading-[19.500px]">
                    <span className="block truncate">
                      <b>{name}</b> {finished ? "finished" : "is reading"}
                    </span>
                    <span className="block truncate font-semibold">{book.title}</span>
                    <span className="block text-[#9a9a9a]">
                      {finished
                        ? rating
                          ? `★ ${rating}`
                          : "Finished"
                        : `${Math.round((progress ?? 0) * 100)}%`}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
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
          {!book.file && <> {NOT_OWNED}</>}
        </p>
      </div>
    </button>
  );
}

const FORMATS = `Books: ${EBOOK.join(", ").toUpperCase()}. Audiobooks: ${AUDIO.join(", ").toUpperCase()}.`;

function ImportSheet({ onClose }: { onClose: () => void }) {
  const { importFiles } = useContext(LibCtx);
  return (
    <Sheet label="Import" onClose={onClose} className="w-[560px] max-w-[calc(100%-32px)]">
      <div className={sheetClass}>
        <button aria-label="Close" onClick={onClose} className={closeClass}>
          <Icon name="x" className="size-5" />
        </button>
        <h2 className="font-serif text-[24px] font-bold">Import</h2>
        <p className="mt-1 text-[14px] text-[#a0a0a0]">
          Add books, audiobooks and PDFs to your library.
        </p>
        <label className="mt-6 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-white/20 bg-white/5 px-6 py-12 text-center focus-within:border-white/50 hover:bg-white/10">
          <Icon name="import" className="size-9 text-[#a0a0a0]" />
          <span className="text-[15px] font-bold max-md:hidden">
            Drop files or folders here, or click to choose files
          </span>
          <span className="text-[13px] text-[#a0a0a0] max-md:hidden">
            You can also drop them anywhere in the window.
          </span>
          <span className="text-[15px] font-bold md:hidden">Tap to choose files</span>
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
        <label
          // Phones cannot pick a whole folder.
          className={`${controlClass} mt-3 flex w-fit cursor-pointer items-center gap-2 focus-within:bg-white/15 max-md:hidden`}
        >
          <Icon name="folder" className="size-4" />
          Choose a Folder…
          <input
            type="file"
            multiple
            // Not in React's types; picks a folder and everything inside it, subfolders included.
            {...{ webkitdirectory: "" }}
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
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4">
      <div className="min-w-0">
        <p className="text-[14px] font-bold">{title}</p>
        <p className="text-[13px] text-[#a0a0a0]">{text}</p>
      </div>
      {children}
    </div>
  );
}

const HELP: [string, string][] = [
  [
    "Importing",
    `Drop files or whole folders anywhere in the window, or use Import on Home or in the profile menu. A card in the bottom corner shows progress; open it to see each file. ${FORMATS} Other files in a folder are skipped. The title, author, description, series and cover are read from the file; anything missing is looked up online, and Edit Details in a book’s ••• menu fixes the rest. Audio files that share an album tag become one audiobook.`,
  ],
  [
    "Finding new books",
    "Search shows trending and new books from Open Library and manga and manhwa from AniList, and searches both as you type. Want to Read in a book’s ••• menu adds it to your Want to Read list without a file; removing it from the list takes it away again. On your shelves, click a book to select it and double-click to open it; View Details and Edit Details are in its ••• menu. Details you edit change the book for your profile only.",
  ],
  [
    "Manga and comics",
    "CBZ files go to Manga & Comics. Volumes named like “One Piece v03” are grouped into a series. In the reader, choose Left to Right, Right to Left (manga) or Scroll (webtoon); the choice is remembered per book.",
  ],
  [
    "Reviews",
    "Write a Review on a book’s page. Reviews are kept on this server and shown to everyone who uses it, with the stars you gave the book.",
  ],
  [
    "Profiles",
    "One sign-in can hold up to 8 profiles, each with its own shelves, progress, goals, stats and reviews. Add them under Settings → Account, and change who’s reading with Switch Profile in the account menu. A profile can set a PIN of 4 to 8 digits there; a forgotten PIN is cleared with the account password. Books of one series can be collapsed into a stack with Stack Series in a shelf’s ••• menu.",
  ],
  [
    "Sharing with the others",
    "New Shelf in the sidebar asks whether the shelf is just for you or shared with your family; a shelf’s ••• menu can share it later or stop sharing. Everyone in your family sees a shared shelf and can add books to it from a book’s ••• menu. Recommend To in the same menu puts a book on a family member’s Home page, and Home shows what they are reading and recently finished; turn off Share my reading under Settings → Account to keep yours private. Your family’s six-digit code is under Settings → Account: someone enters it when creating their account, or there, to join.",
  ],
  [
    "Reading offline",
    "The cloud button on a book downloads it to this device; a tick means it is here, and clicking again removes it. Downloaded books open without a connection, and your place, bookmarks and reading time are sent to the server when it is reachable again. On a phone or tablet, use the browser’s Add to Home Screen to install the app. This needs a secure (https) address; it is not available over a plain http address on your home network.",
  ],
  [
    "Forgotten password",
    "Choose Forgot password? on the sign-in page. This server can’t send email, so the reset code appears for the admin under Settings → Account, and in the server log. It works for 30 minutes.",
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
    "Reading",
    "EPUB, PDF, comic (CBZ) and text files open in the reader. In an EPUB you can search, jump by chapter, bookmark a page, change text size and theme, and select text to highlight it or add a note. Save a Copy in a book’s ••• menu puts its file in your downloads folder.",
  ],
  [
    "Reading goals",
    "Time counts on its own while a book or PDF is open in the reader, or an audiobook is playing. Days that reach your daily goal build your streak.",
  ],
  [
    "Your data",
    "Everything is saved on the server under your account, so any browser you sign in from shows the same library, progress and stats. Books are shared with everyone on the server; shelves, ratings, progress and goals are your own. Importing a file that is already in the library is skipped. The admin can download a backup, restore one and tidy the library under Settings → Library. After eight wrong passwords an account is locked for 15 minutes.",
  ],
];

const SETTINGS_TABS: [id: string, label: string, icon: IconName][] = [
  ["profile", "Account", "user"],
  ["goals", "Reading Goals", "finished"],
  ["online", "Online", "cloud"],
  ["library", "Library", "shelf"],
  ["help", "Help", "help"],
];

type Account = {
  id: number;
  account: number; // the profile that signs in; other profiles share its email and password
  name: string;
  email: string;
  admin: boolean;
  reset?: string | null;
};
type Profile = { id: number; name: string; locked?: number }; // locked: has a PIN

const loadProfiles = (): Promise<Profile[]> =>
  fetch("/api/auth")
    .then((res) => res.json())
    .then((body) => body.profiles ?? [])
    .catch(() => []);

type FamilyInfo = { code: string; members: { id: number; name: string }[] };

/** Your family: the code others enter to join it, who is in it, and joining someone else's. */
function Family() {
  const { user, toast } = useContext(LibCtx);
  const [family, setFamily] = useState<FamilyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    fetch("/api/auth")
      .then((res) => res.json())
      .then((body) => setFamily(body.family ?? null))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const others = family?.members.filter((m) => m.id !== user.id) ?? [];
  return (
    <>
      <SettingRow
        title="Family code"
        text={`Give this code to someone to add them to your family: they enter it when creating their account, or below in their own settings. ${
          others.length ? `In your family: ${others.map((m) => m.name).join(", ")}.` : "Nobody else has joined yet."
        }`}
      >
        <span
          aria-label="Family code"
          className="rounded-lg bg-white/10 px-4 py-[6px] font-mono text-[18px] font-bold tracking-[0.25em] select-all"
        >
          {family?.code ?? "······"}
        </span>
      </SettingRow>
      <SettingRow
        title="Join a family"
        text="Enter another family’s code to move into it. You leave your current family: its shared shelves stay with it."
      >
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const failed = await authCall({ action: "joinFamily", code: new FormData(form).get("code") });
            setError(failed);
            if (failed) return;
            form.reset();
            toast("Joined", "You are now in that family.");
            setTimeout(() => location.reload(), 1200); // shared shelves and activity are the new family's
          }}
        >
          <input
            name="code"
            aria-label="Family code to join"
            placeholder="6 digits"
            inputMode="numeric"
            pattern="\d{6}"
            data-tip="Six digits"
            maxLength={6}
            required
            className={`${fieldClass} !h-[30px] !w-[110px] text-center`}
          />
          <button className={controlClass}>Join</button>
          {others.length > 0 && (
            <button
              type="button"
              onClick={async () => {
                const leave = await ask({
                  title: "Leave this family?",
                  text: "You get a new family of your own with a new code.",
                  action: "Leave",
                  danger: true,
                });
                if (leave === null) return;
                setError(await authCall({ action: "leaveFamily" }));
                location.reload();
              }}
              className={`${controlClass} text-[#ff6b61]`}
            >
              Leave
            </button>
          )}
        </form>
      </SettingRow>
      {error && (
        <p role="alert" className="px-5 text-[13px] text-[#ff6b61]">
          {error}
        </p>
      )}
    </>
  );
}

/** The people sharing this sign-in. Each has their own shelves, progress, stats and reviews. */
function Profiles() {
  const { user, toast } = useContext(LibCtx);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => loadProfiles().then(setProfiles);
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      {profiles.map((p) => (
        <SettingRow
          key={p.id}
          title={p.name}
          text={`${p.id === user.id ? "In use now" : p.id === user.account ? "The account’s own profile" : "Profile"}${p.locked ? " • PIN" : ""}`}
        >
          <div className="flex gap-2">
            {/* Your own PIN is yours to set; someone else's forgotten PIN is cleared with the account password. */}
            {(p.id === user.id || !!p.locked) && (
              <button
                onClick={async () => {
                  const mine = p.id === user.id;
                  const pin =
                    mine && !p.locked
                      ? await ask({
                          title: "Set a PIN",
                          text: "Choose a PIN of 4 to 8 digits for this profile.",
                          action: "Set PIN",
                          input: {
                            type: "password",
                            inputMode: "numeric",
                            pattern: "\\d{4,8}",
                            maxLength: 8,
                            required: true,
                            autoComplete: "off",
                            "aria-label": "PIN",
                            ...{ "data-tip": "4 to 8 digits" },
                          },
                        })
                      : "";
                  if (pin === null) return;
                  const password = mine
                    ? undefined
                    : await ask({
                        title: `Clear ${p.name}’s PIN?`,
                        text: "Enter the account password to clear this PIN.",
                        action: "Clear PIN",
                        input: {
                          type: "password",
                          required: true,
                          autoComplete: "current-password",
                          "aria-label": "Account password",
                        },
                      });
                  if (password === null) return;
                  setError(await authCall({ action: "setPin", id: p.id, pin, password }));
                  load();
                }}
                className={controlClass}
              >
                {p.locked ? (p.id === user.id ? "Remove PIN" : "Clear PIN") : "Set PIN"}
              </button>
            )}
            {p.id !== user.id && p.id !== user.account && (
              <button
                onClick={async () => {
                  const gone = await ask({
                    title: `Remove ${p.name}?`,
                    text: "Their shelves, ratings and progress are deleted.",
                    action: "Remove",
                    danger: true,
                  });
                  if (gone === null) return;
                  setError(await authCall({ action: "removeProfile", id: p.id }));
                  load();
                }}
                className={`${controlClass} text-[#ff6b61]`}
              >
                Remove
              </button>
            )}
          </div>
        </SettingRow>
      ))}
      <SettingRow
        title="Add a profile"
        text="For someone who shares this sign-in. Pick who’s reading from the account menu."
      >
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const name = String(new FormData(form).get("name"));
            const failed = await authCall({ action: "addProfile", name });
            setError(failed);
            if (failed) return;
            form.reset();
            toast("Added", `${name} now has a profile.`);
            load();
          }}
        >
          <input
            name="name"
            aria-label="Profile name"
            placeholder="Name"
            required
            maxLength={40}
            className={`${fieldClass} !h-[30px] !w-[160px]`}
          />
          <button className={controlClass}>Add</button>
        </form>
      </SettingRow>
      {error && (
        <p role="alert" className="px-5 text-[13px] text-[#ff6b61]">
          {error}
        </p>
      )}
    </>
  );
}

/** "Who's reading?": choose which of the account's profiles to use. */
function ProfilePicker({
  auto,
  onPick,
  onClose,
  onManage,
}: {
  auto: boolean; // shown right after signing in: skipped when there is only one profile
  onPick: (id: number, pin?: string) => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const { user } = useContext(LibCtx);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  useEffect(() => {
    loadProfiles().then((list) => (auto && list.length < 2 ? onClose() : setProfiles(list)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!profiles) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose a profile"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-10 bg-[#1e1e1e] p-6"
    >
      <h1 className="font-serif text-[34px] font-bold">Who’s reading?</h1>
      <div className="flex flex-wrap justify-center gap-7">
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={async () => {
              if (p.id === user.id) return onClose();
              const pin = p.locked
                ? await ask({
                    title: `Enter ${p.name}’s PIN`,
                    action: "Continue",
                    input: {
                      type: "password",
                      inputMode: "numeric",
                      required: true,
                      autoComplete: "off",
                      "aria-label": "PIN",
                    },
                  })
                : undefined;
              if (pin !== null) onPick(p.id, pin);
            }}
            className="group flex w-[120px] flex-col items-center gap-3"
          >
            <span className="flex size-[120px] items-center justify-center rounded-2xl bg-[#3a3a3c] font-serif text-[48px] font-bold ring-white group-hover:ring-2 group-focus-visible:ring-2">
              {p.name[0]?.toUpperCase()}
            </span>
            <span className="w-full truncate text-center text-[14px] text-[#a0a0a0] group-hover:text-white">
              {p.name}
            </span>
          </button>
        ))}
      </div>
      <button onClick={onManage} className={controlClass}>
        Manage Profiles
      </button>
    </div>
  );
}

/** Calls the auth API; resolves to an error message, or null when it worked. */
async function authCall(body: Record<string, unknown>) {
  try {
    const res = await fetch("/api/auth", { method: "POST", body: JSON.stringify(body) });
    return res.ok ? null : String((await res.json()).error ?? "Something went wrong.");
  } catch {
    return "Can’t reach the server.";
  }
}

/** A name + password form; `onSubmit` resolves to an error message or null. */
function Credentials({
  labels,
  button,
  onSubmit,
}: {
  labels: [first: string, second: string];
  button: string;
  onSubmit: (first: string, second: string) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const secret = labels[0].includes("assword");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const failed = await onSubmit(String(data.get("first")), String(data.get("second")));
        setError(failed);
        if (!failed) form.reset();
      }}
    >
      <input
        name="first"
        type={secret ? "password" : "text"}
        autoComplete={secret ? "current-password" : "off"}
        aria-label={labels[0]}
        placeholder={labels[0]}
        required
        className={`${fieldClass} !h-[30px] !w-[150px]`}
      />
      <input
        name="second"
        type="password"
        autoComplete="new-password"
        aria-label={labels[1]}
        placeholder={labels[1]}
        required
        minLength={8}
        className={`${fieldClass} !h-[30px] !w-[150px]`}
      />
      <button className={controlClass}>{button}</button>
      {error && <p className="w-full text-[12px] text-[#ff6b61]">{error}</p>}
    </form>
  );
}

/** Admin only: the people who can sign in to this server. */
function Users() {
  const { user, toast } = useContext(LibCtx);
  const [users, setUsers] = useState<Account[]>([]);
  const [signups, setSignups] = useState(true);
  const load = () =>
    fetch("/api/auth")
      .then((res) => res.json())
      .then((body) => {
        setUsers(body.users ?? []);
        setSignups(body.signups);
      })
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <SettingRow
        title="Allow new accounts"
        text="Anyone who can open this server can create an account from the sign-in page. Turn this off once everyone has joined."
      >
        <input
          type="checkbox"
          aria-label="Allow new accounts"
          checked={signups}
          onChange={async (e) => {
            setSignups(e.target.checked);
            await authCall({ action: "signups", allow: e.target.checked });
          }}
        />
      </SettingRow>
      {users.map((u) => (
        <SettingRow
          key={u.id}
          title={u.name}
          text={`${u.email} • ${u.admin ? "Admin" : "Reader"}${u.reset ? ` • Forgot their password: give them reset code ${u.reset}` : ""}`}
        >
          <div className="flex gap-2">
            <button
              onClick={async () => {
                const password = await ask({
                  title: `New password for ${u.name}`,
                  text: "At least 8 characters.",
                  action: "Set Password",
                  input: {
                    type: "password",
                    minLength: 8,
                    required: true,
                    autoComplete: "new-password",
                    "aria-label": "New password",
                  },
                });
                if (!password) return;
                const failed = await authCall({ action: "setPassword", id: u.id, password });
                toast(failed ? "Not Changed" : "Saved", failed ?? `${u.name}’s password was changed.`);
                load();
              }}
              className={controlClass}
            >
              Set Password
            </button>
            {u.id !== user.account && (
              <button
                onClick={async () => {
                  const gone = await ask({
                    title: `Remove ${u.name}?`,
                    text: "Their shelves, ratings and progress are deleted.",
                    action: "Remove",
                    danger: true,
                  });
                  if (gone === null) return;
                  await authCall({ action: "removeUser", id: u.id });
                  load();
                }}
                className={`${controlClass} text-[#ff6b61]`}
              >
                Remove
              </button>
            )}
          </div>
        </SettingRow>
      ))}
    </>
  );
}

function SettingsSheet({
  tab,
  onTab,
  onClose,
}: {
  tab: string;
  onTab: (tab: string) => void;
  onClose: () => void;
}) {
  const { s, set, openImport, toast, user, logout, offline, clearOffline } = useContext(LibCtx);
  const goalInput = (label: string, value: number, max: number, onPick: (n: number) => void) => (
    <NumberField
      label={label}
      value={value}
      max={max}
      onPick={onPick}
      className={`${controlClass} w-[68px]`}
    />
  );
  const body: Record<string, ReactNode> = {
    profile: (
      <>
        <SettingRow
          title={user.name}
          text={`${user.email} • ${user.admin ? "Admin of this server" : "Reader"}`}
        >
          <button onClick={logout} className={controlClass}>
            Log Out
          </button>
        </SettingRow>
        <SettingRow title="Change password" text="At least 8 characters.">
          <Credentials
            labels={["Current password", "New password"]}
            button="Change"
            onSubmit={async (current, next) => {
              const failed = await authCall({ action: "password", current, next });
              if (!failed) toast("Saved", "Your password was changed.");
              return failed;
            }}
          />
        </SettingRow>
        <SettingRow
          title="Share my reading"
          text="Let the other people on this server see what you’re reading and what you finished, on their Home page."
        >
          <input
            type="checkbox"
            aria-label="Share my reading"
            checked={s.share}
            onChange={(e) => set(() => ({ share: e.target.checked }))}
          />
        </SettingRow>
        <h3 className="px-5 pt-5 pb-2 text-[15px] font-bold">Family</h3>
        <Family />
        <h3 className="px-5 pt-5 pb-2 text-[15px] font-bold">Profiles</h3>
        <Profiles />
        {user.admin && (
          <>
            <h3 className="px-5 pt-5 pb-2 text-[15px] font-bold">Accounts on This Server</h3>
            <Users />
          </>
        )}
      </>
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
      <>
        <SettingRow
          title="Online lookups"
          text="Fill in missing covers, descriptions and other readers’ ratings, and show new and trending books in Search, from Open Library. The server sends it the book’s ISBN, or its title and author."
        >
          <input
            type="checkbox"
            aria-label="Online lookups"
            checked={s.lookups}
            onChange={(e) => set(() => ({ lookups: e.target.checked }))}
          />
        </SettingRow>
      </>
    ),
    library: (
      <>
        <SettingRow title="Import" text={FORMATS}>
          <button onClick={openImport} className={controlClass}>
            Import Files
          </button>
        </SettingRow>
        <SettingRow
          title="Offline books"
          text={
            canWorkOffline()
              ? `${s.books.filter((b) => filesOf(b).length && filesOf(b).every((f) => offline.has(f))).length} kept on this device. Use the cloud button on a book to download it; downloaded books open without a connection.`
              : "Not available here: browsers only allow offline storage on a secure (https) address or on localhost."
          }
        >
          {offline.size > 0 && (
            <button
              onClick={async () => {
                await clearOffline();
                toast("Removed", "Downloaded books were removed from this device.");
              }}
              className={controlClass}
            >
              Remove All
            </button>
          )}
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
        {user.admin && (
          <>
            <SettingRow
              title="Tidy library"
              text="Go over every book again: move comics filed as books to Manga & Comics, clean download tags out of titles, and fingerprint files so the same file isn’t imported twice."
            >
              <button
                onClick={async () => {
                  const res = await fetch("/api/admin", { method: "POST" }).catch(() => null);
                  if (!res?.ok) return toast("Not Done", "The server couldn’t go over the library.");
                  const { changed } = await res.json();
                  toast("Done", `${changed} book${changed === 1 ? " was" : "s were"} updated.`);
                  if (changed) setTimeout(() => location.reload(), 1500);
                }}
                className={controlClass}
              >
                Tidy Now
              </button>
            </SettingRow>
            <SettingRow
              title="Backup"
              text="One zip with the database (accounts, shelves, progress, reviews) and the covers. The book files are not in it: copy the library folder for those."
            >
              <a href="/api/admin" download className={`${controlClass} flex items-center`}>
                Download Backup
              </a>
            </SettingRow>
            <SettingRow
              title="Restore"
              text="Replace this server’s database and covers with a backup. Everything changed since that backup is lost."
            >
              <label className={`${controlClass} flex cursor-pointer items-center text-[#ff6b61]`}>
                Restore…
                <input
                  type="file"
                  accept=".zip"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    const replace = await ask({
                      title: "Restore this backup?",
                      text: `Everything on this server is replaced with ${file.name}. Anything changed since that backup is lost.`,
                      action: "Restore",
                      danger: true,
                    });
                    if (replace === null) return;
                    const res = await fetch("/api/admin", { method: "PUT", body: file }).catch(() => null);
                    if (res?.ok) return location.reload();
                    toast("Not Restored", (await res?.json().catch(() => null))?.error ?? "The server couldn’t be reached.");
                  }}
                />
              </label>
            </SettingRow>
          </>
        )}
      </>
    ),
    help: HELP.map(([title, text]) => (
      <div key={title} className="px-5 py-4">
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
      <div className="flex h-full flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#1e1e1e] shadow-2xl">
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
          <nav className="no-scrollbar flex shrink-0 overflow-auto border-white/10 bg-[#1b1b1b] p-[9px] max-md:gap-1 max-md:border-b md:w-[210px] md:flex-col md:border-r">
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

/** A book's description; a long one is cut to a few lines with a More button. */
function Blurb({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  // ponytail: "long" is judged by length, not by measuring the rendered lines
  const long = text.length > 420;
  return (
    <>
      <p className={`mt-3 font-serif text-[15px] leading-[18px] ${long && !full ? "line-clamp-4" : ""}`}>
        {text}
      </p>
      {long && (
        <button
          onClick={() => setFull(!full)}
          className="mt-1 text-[13px] font-bold text-[#b4b4b4] hover:text-[#8a8a8a]"
        >
          {full ? "See Less" : "See More"}
        </button>
      )}
    </>
  );
}

function Detail({ ids, id }: DetailState) {
  const { s, setDetail, toggleWant, toggleFinished, setView, play, read } = useContext(LibCtx);

  const book = s.books.find((b) => b.id === id);
  if (!book) return null; // removed from the library while open

  const i = ids.indexOf(id);
  const prev = i > 0 ? ids[i - 1] : undefined;
  const next = i >= 0 ? ids[i + 1] : undefined;
  const twin = s.books.find(
    (b) => b.id !== id && b.title === book.title && b.author === book.author,
  );
  const info = book.info;
  const tracked = !!book.file && (book.kind === "audiobook" || canRead(book));
  const card = "rounded-2xl bg-[#3a393c] p-[17px]";
  const arrow = "absolute top-1/2 -translate-y-1/2 text-[#8c8c8c] hover:text-white";
  const series = book.series
    ? s.books.filter((b) => b.series === book.series && b.id !== id).toSorted(bySeriesIndex)
    : [];
  const section = (title: string, content: ReactNode) => (
    <>
      <hr className="my-7 border-white/10" />
      <h3 className="mb-4 font-serif text-[17px] font-bold">{title}</h3>
      {content}
    </>
  );

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
          <div className="relative isolate bg-[#262527] px-5 pt-[68px] pb-[34px] md:px-[74px]">
            {/* The cover, blown up and blurred until only its colours are left. */}
            <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
              <div
                className="size-full scale-150 bg-cover bg-center opacity-45 blur-[70px]"
                style={{
                  backgroundImage: book.coverFile
                    ? `url(/api/file?cover=${book.coverFile})`
                    : `linear-gradient(${book.cover[0]}, ${book.cover[1]})`,
                }}
              />
            </div>
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
              <CloudButton book={book} />
              <BookMenu book={book} />
            </div>

            <div className="flex flex-col gap-6 max-md:items-center max-md:pt-12 md:flex-row md:gap-[34px]">
              <Cover book={book} w={190} />
              <div className="min-w-0 grow max-md:w-full">
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
                <h2 className="font-serif text-[28px] leading-tight font-bold max-md:text-center">
                  {book.title}
                </h2>
                <p className="mt-[6px] text-[14px] max-md:text-center">
                  {book.author}
                  {book.narrator && (
                    <span className="text-[#a8a8a8]"> • Narrated by {book.narrator}</span>
                  )}
                </p>
                <p className="mt-2 text-[13px] text-[#a8a8a8] max-md:text-center">
                  {[
                    info?.rating &&
                      `★ ${info.rating.toFixed(1)} (${compact(info.ratings ?? 0)})`,
                    info?.genre,
                    info?.year && `First published ${info.year}`,
                  ]
                    .filter(Boolean)
                    .join(" • ")}
                </p>
                <div className={`${card} mt-5 flex items-center justify-between gap-4`}>
                  <div>
                    <p className="flex items-center gap-2 text-[16px] font-bold">
                      {KIND_LABEL[book.kind]}
                      {!book.file && NOT_OWNED}
                    </p>
                    <p className="text-[13px] text-[#c8c8c8]">
                      {[
                        `Added ${new Date(book.added).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
                        info?.pages && book.kind !== "audiobook" && `${info.pages} Pages`,
                        book.duration && clock(book.duration),
                      ]
                        .filter(Boolean)
                        .join(" • ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    {book.file && (
                      <button
                        onClick={() =>
                          book.kind === "audiobook" ? play(book.id) : read(book.id)
                        }
                        className={`${primaryClass} h-[30px] w-[150px]`}
                      >
                        {book.kind === "audiobook" ? "Listen" : "Read"}
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
            <Blurb key={book.id} text={book.blurb ?? "No description yet."} />
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
            <Reviews key={`reviews ${book.id}`} book={book} />
            {tracked && (
              <>
                <hr className="my-7 border-white/10" />
                <h3 className="font-serif text-[17px] font-bold">Progress</h3>
                {/* Shown, never set by hand: it is where the reader or player actually got to. */}
                <div className={`${card} mt-3 flex items-center gap-4`}>
                  <div
                    role="progressbar"
                    aria-label="Progress"
                    aria-valuenow={Math.round((book.progress ?? 0) * 100)}
                    className="h-[6px] grow overflow-hidden rounded-full bg-white/10"
                  >
                    <div
                      className="h-full rounded-full bg-[#1c9be6]"
                      style={{ width: `${(book.progress ?? 0) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-[13px] font-bold">
                    {Math.round((book.progress ?? 0) * 100)}%
                  </span>
                </div>
                <p className="mt-2 text-[12px] text-[#8c8c8c]">Updates as you read or listen.</p>
              </>
            )}
            {series.length > 0 &&
              section(
                "Other Books in This Series",
                <Scroller>
                  {series.map((b) => (
                    <div key={b.id} className="w-[120px] shrink-0 text-[13px] leading-[18px]">
                      <CoverButton book={b} w={120} ids={series.map((x) => x.id)} />
                      {b.seriesIndex !== undefined && (
                        <p className="mt-2 text-[11px] tracking-[0.12em] text-[#9a9a9a] uppercase">
                          Book {b.seriesIndex}
                        </p>
                      )}
                      <p className="mt-1 truncate font-semibold">{b.title}</p>
                      <p className="truncate text-[#9a9a9a]">{b.author}</p>
                    </div>
                  ))}
                </Scroller>,
              )}
            {s.lookups && book.author !== UNKNOWN_AUTHOR && (
              <FoundBooks
                key={`a${book.author}`}
                query={`author=${encodeURIComponent(book.author)}`}
                as="carousel"
                skip={book.title}
                wrap={(row) => section(`More Books by ${book.author}`, row)}
              />
            )}
            {s.lookups && info?.genre && (
              <FoundBooks
                key={`g${info.genre}`}
                query={`subject=${encodeURIComponent(info.genre)}`}
                as="carousel"
                skip={book.title}
                wrap={(row) => section(`Top Books in ${info.genre}`, row)}
              />
            )}
          </div>
        </div>
    </Sheet>
  );
}

type Review = { name: string; text: string; created: string; rating?: number; mine: boolean };

/** What people on this server wrote about the book, and a box for your own review. Mount with `key={book.id}`. */
function Reviews({ book }: { book: Book }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [writing, setWriting] = useState(false);
  const load = () =>
    fetch(`/api/reviews?book=${book.id}`)
      .then((res) => res.json())
      .then((body) => setReviews(body.reviews ?? []))
      .catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const mine = reviews.find((r) => r.mine);
  const save = async (text: string) => {
    await fetch("/api/reviews", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book: book.id, text }),
    }).catch(() => {});
    setWriting(false);
    load();
  };
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-serif text-[17px] font-bold">Reviews</h3>
        {!writing && (
          <button onClick={() => setWriting(true)} className={controlClass}>
            {mine ? "Edit Your Review" : "Write a Review"}
          </button>
        )}
      </div>
      {writing && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            save(String(new FormData(e.currentTarget).get("text")));
          }}
        >
          <textarea
            name="text"
            aria-label="Your review"
            placeholder="What did you think? Everyone on this server can read it."
            defaultValue={mine?.text}
            maxLength={4000}
            rows={4}
            required
            autoFocus
            className={`${fieldClass} !h-auto py-2`}
          />
          <div className="mt-2 flex gap-2">
            <button className={`${primaryClass} h-[30px] px-5`}>Save</button>
            <button type="button" onClick={() => setWriting(false)} className={controlClass}>
              Cancel
            </button>
            {mine && (
              <button type="button" onClick={() => save("")} className={`${controlClass} text-[#ff6b61]`}>
                Delete
              </button>
            )}
          </div>
        </form>
      )}
      {reviews.length > 0 ? (
        <div className="mt-3 grid gap-4 md:grid-cols-2 md:gap-[26px]">
          {reviews.map((r) => (
            <div key={r.name + r.created} className="rounded-2xl bg-[#3a393c] p-[17px]">
              <p className="max-h-[152px] overflow-y-auto text-[14px] leading-[19px] whitespace-pre-line">
                {r.text}
              </p>
              <p className="mt-3 text-[12px] text-[#a0a0a0]">
                {r.rating ? `★ ${r.rating} • ` : ""}
                {new Date(r.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                {" • "}
                {r.mine ? "You" : r.name}
              </p>
            </div>
          ))}
        </div>
      ) : (
        !writing && (
          <p className="mt-3 text-[13px] text-[#8c8c8c]">
            Nobody on this server has reviewed this yet.
          </p>
        )
      )}
    </>
  );
}

const GENRES = ["Fantasy", "Science Fiction", "Mystery", "Romance", "Thriller", "History", "Biography"];
const lower = (text: string) => text.toLowerCase();

/** Finds a catalogue book in the library, and puts it on (or takes it off) Want to Read. */
function useCatalogue() {
  const { s, addBook, toggleWant, toast } = useContext(LibCtx);
  const mineOf = (f: Found) =>
    s.books.find(
      (b) =>
        b.olKey === f.key ||
        (lower(b.title) === lower(f.title) && lower(b.author) === lower(f.author)),
    );
  /** Puts the book in the library (on Want to Read) and returns it; null when the catalogue can't be reached. */
  const add = async (f: Found): Promise<Book | null> => {
    const res = await fetch("/api/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: f.key }),
    }).catch(() => null);
    if (!res?.ok) {
      toast("Couldn’t Add", "The catalogue can’t be reached right now.");
      return null;
    }
    const { book } = await res.json();
    addBook(book);
    return book;
  };
  const toggle = async (f: Found) => {
    const mine = mineOf(f);
    if (mine) return toggleWant(mine);
    if (await add(f)) toast("Added", `“${f.title}” was added to your Want to Read list.`);
  };
  return { mineOf, toggle, add };
}

/** The ••• menu of a catalogue book. Once the book is in the library it is the regular book menu. */
function FoundMenu({ found }: { found: Found }) {
  const { s, set, preview, toast } = useContext(LibCtx);
  const { mineOf, toggle, add } = useCatalogue();
  const mine = mineOf(found);
  if (mine) return <BookMenu book={mine} />;
  return (
    <Popover
      label={`Options for ${found.title}`}
      button={DOTS}
      buttonClass="block shrink-0 py-1 text-[#b4b4b4] hover:text-white"
      panelClass="w-[230px]"
    >
      <MenuItem icon="want" label="Add to Want to Read" onClick={() => toggle(found)} />
      <MenuItem
        icon="finished"
        label="Mark as Finished"
        onClick={async () => {
          const book = await add(found);
          if (!book) return;
          set((prev) => ({
            books: prev.books.map((b) =>
              b.id === book.id ? { ...b, want: false, finished: dayKey(new Date()) } : b,
            ),
          }));
          toast("Finished", `“${found.title}” was added to your Finished list.`);
        }}
      />
      <MenuItem icon="book" label="View Details" onClick={() => preview(found)} />
      {s.collections.length > 0 && (
        <>
          {MENU_RULE}
          <p className="px-[6px] pt-1 pb-[3px] text-[11px] font-bold text-[#777]">Add to Shelf</p>
          {s.collections.map((c) => (
            <MenuItem
              key={c.id}
              label={c.name}
              checked={false}
              onClick={async () => {
                // A book without a file is kept by being on Want to Read, so it goes there too.
                const book = await add(found);
                if (!book) return;
                set((prev) => ({
                  collections: prev.collections.map((x) =>
                    x.id === c.id ? { ...x, bookIds: [...x.bookIds, book.id] } : x,
                  ),
                }));
                toast("Added", `“${found.title}” was added to ${c.name} and Want to Read.`);
              }}
            />
          ))}
        </>
      )}
    </Popover>
  );
}

/** A catalogue book's cover, `w` wide. Pulses grey until the image has arrived. */
function FoundCover({ found, w }: { found: Found; w: number }) {
  const [loaded, setLoaded] = useState(false);
  const size = { width: w, height: w * 1.5 };
  return found.cover ? (
    <span
      style={size}
      className={`block shrink-0 overflow-hidden rounded-[3px] bg-white/10 shadow-lg ${loaded ? "" : "animate-pulse"}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={found.cover}
        alt=""
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={`size-full object-cover transition-opacity ${loaded ? "" : "opacity-0"}`}
      />
    </span>
  ) : (
    <span
      style={size}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-[#3a3a3c] p-1 text-center font-serif text-[11px]"
    >
      {found.title}
    </span>
  );
}

function WantButton({ found, className }: { found: Found; className: string }) {
  const { mineOf, toggle } = useCatalogue();
  const wanted = !!mineOf(found)?.want;
  return (
    <button
      aria-pressed={wanted}
      aria-label={`${wanted ? "Remove" : "Add"} ${found.title} ${wanted ? "from" : "to"} Want to Read`}
      onClick={() => toggle(found)}
      className={`${controlClass} flex items-center justify-center gap-1 !px-2 ${className}`}
    >
      <Icon name={wanted ? "check" : "plus"} className="size-4" strokeWidth={2} />
      Want to Read
    </button>
  );
}

type About = { description?: string; genre?: string; facts?: string };
const abouts = new Map<string, Promise<About>>();
/**
 * The details of a catalogue book. Asked for once, and already when the pointer reaches the
 * book's cover, so its info page usually opens filled in.
 */
function loadAbout(key: string) {
  let about = abouts.get(key);
  if (!about) {
    about = fetch(`/api/discover?about=${encodeURIComponent(key)}`)
      .then((res) => res.json())
      .catch(() => {
        abouts.delete(key); // offline: ask again next time
        return {};
      });
    abouts.set(key, about);
  }
  return about;
}

/** Cover, title, author and rating of a catalogue book; opens it. Sized like `Result`. */
function FoundResult({ found, w, className = "" }: { found: Found; w: number; className?: string }) {
  const { setDetail, preview } = useContext(LibCtx);
  const mine = useCatalogue().mineOf(found);
  return (
    <button
      onClick={() => (mine ? setDetail({ ids: [mine.id], id: mine.id }) : preview(found))}
      onPointerEnter={() => loadAbout(found.key)}
      className={`flex min-w-0 grow items-center gap-[18px] p-2 text-left ${className}`}
    >
      <FoundCover found={found} w={w} />
      <div className="min-w-0 text-[13px] leading-[19.500px]">
        <p className="truncate font-semibold">{found.title}</p>
        <p className="truncate">{found.author}</p>
        <p className="text-[#9a9a9a]">
          {found.key.startsWith("anilist:") ? "Manga" : "Book"}
          {found.rating
            ? ` • ★ ${found.rating.toFixed(1)} (${compact(found.ratings ?? 0)})`
            : found.year
              ? ` • ${found.year}`
              : ""}
          {mine && !mine.file && <> {NOT_OWNED}</>}
        </p>
      </div>
    </button>
  );
}

/** Info page of a catalogue book that is not in the library yet. */
function FoundSheet({ found, onClose }: { found: Found; onClose: () => void }) {
  const { s } = useContext(LibCtx);
  const [loaded, setLoaded] = useState<{ key: string; about: About } | null>(null);
  useEffect(() => {
    let stale = false;
    loadAbout(found.key).then((about) => stale || setLoaded({ key: found.key, about }));
    return () => {
      stale = true;
    };
  }, [found.key]);
  const about = loaded?.key === found.key ? loaded.about : null; // null while loading
  const isManga = found.key.startsWith("anilist:");
  const bar = "animate-pulse rounded bg-white/10";
  const row = (title: string, query: string) => (
    <FoundBooks
      key={query}
      query={query}
      as="carousel"
      skip={found.title}
      wrap={(books) => (
        <>
          <hr className="my-7 border-white/10" />
          <h3 className="mb-4 font-serif text-[17px] font-bold">{title}</h3>
          {books}
        </>
      )}
    />
  );
  return (
    <Sheet
      label={found.title}
      onClose={onClose}
      className="h-full w-[922px] max-w-full md:h-[calc(100%-70px)] md:max-w-[calc(100%-110px)]"
    >
      <div className="h-full overflow-y-auto bg-[#2c2c2e] shadow-2xl md:rounded-[28px]">
        <div className="relative isolate bg-[#262527] px-5 pt-[68px] pb-[34px] md:px-[74px]">
          <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
            <div
              className="size-full scale-150 bg-cover bg-center opacity-45 blur-[70px]"
              style={{ backgroundImage: found.cover ? `url(${JSON.stringify(found.cover)})` : undefined }}
            />
          </div>
          <button aria-label="Close" onClick={onClose} className={closeClass}>
            <Icon name="x" className="size-5" />
          </button>
          <div className="flex flex-col gap-6 md:flex-row md:gap-[34px]">
            <FoundCover found={found} w={190} />
            <div className="min-w-0 grow">
              <h2 className="font-serif text-[28px] leading-tight font-bold">{found.title}</h2>
              <p className="mt-[6px] text-[14px]">{found.author}</p>
              <p className="mt-2 text-[13px] text-[#a8a8a8]">
                {[
                  found.rating && `★ ${found.rating.toFixed(1)} (${compact(found.ratings ?? 0)})`,
                  about?.genre,
                  found.year && `First published ${found.year}`,
                ]
                  .filter(Boolean)
                  .join(" • ")}
              </p>
              <div className="mt-5 flex items-center justify-between gap-4 rounded-2xl bg-[#3a393c] p-[17px]">
                <div>
                  <p className="text-[16px] font-bold">{isManga ? "Manga" : "Book"}</p>
                  <p className="text-[13px] text-[#c8c8c8]">
                    {about?.facts || "Not in your library"}
                  </p>
                </div>
                <WantButton found={found} className="w-[150px]" />
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-8 md:px-[74px]">
          <h3 className="font-serif text-[17px] font-bold">Description</h3>
          {about ? (
            <Blurb key={found.key} text={about.description ?? "No description yet."} />
          ) : (
            <div aria-hidden className="mt-3 space-y-2">
              <div className={`${bar} h-3`} />
              <div className={`${bar} h-3`} />
              <div className={`${bar} h-3 w-2/3`} />
            </div>
          )}
          {s.lookups &&
            !isManga &&
            found.author !== UNKNOWN_AUTHOR &&
            row(`More Books by ${found.author}`, `author=${encodeURIComponent(found.author)}`)}
          {s.lookups &&
            about?.genre &&
            (isManga
              ? row(`Popular ${about.genre} Manga`, `mangaGenre=${encodeURIComponent(about.genre)}`)
              : row(`Top Books in ${about.genre}`, `subject=${encodeURIComponent(about.genre)}`))}
        </div>
      </div>
    </Sheet>
  );
}

/** A row that scrolls sideways, with an arrow at each edge it can still scroll toward instead of a scrollbar. */
function Scroller({ className = "", children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [can, setCan] = useState({ left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setCan((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };
  useEffect(() => {
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(ref.current!);
    return () => watch.disconnect();
  }, []);
  const arrow = (dir: -1 | 1) => (
    <button
      aria-label={dir < 0 ? "Scroll left" : "Scroll right"}
      onClick={() =>
        ref.current!.scrollBy({ left: dir * ref.current!.clientWidth * 0.8, behavior: "smooth" })
      }
      // 90px: the middle of a 180px-tall cover. Shown while the pointer is over the row, or on keyboard focus.
      className={`absolute top-[90px] z-10 flex h-[84px] w-[30px] -translate-y-1/2 items-center justify-center rounded-full bg-[#3a3a3c] text-white opacity-0 shadow-lg transition-opacity group-hover/row:opacity-100 hover:bg-[#4a4a4c] focus-visible:opacity-100 ${dir < 0 ? "-left-[15px]" : "-right-[15px]"}`}
    >
      <Icon name={dir < 0 ? "chevronLeft" : "chevronRight"} className="size-5" strokeWidth={2} />
    </button>
  );
  return (
    <div className={`group/row relative ${className}`}>
      <div ref={ref} onScroll={measure} className="no-scrollbar flex gap-5 overflow-x-auto pb-3">
        {children}
      </div>
      {can.left && arrow(-1)}
      {can.right && arrow(1)}
    </div>
  );
}

/**
 * Books from Open Library's catalogue (`query` is the /api/discover query string), shown as a
 * carousel of covers, a two-column list, or a list of titles to search for.
 * Mount with `key={query}` so a new query starts clean.
 */
function FoundBooks({
  query,
  as,
  limit = 18,
  skip = "",
  onPick,
  wrap,
  className,
}: {
  query: string;
  as: "carousel" | "list" | "terms";
  limit?: number;
  skip?: string; // title to leave out: the book this row is shown under
  onPick?: (title: string) => void; // "terms": a title was chosen
  /** Wraps the result in its heading; with it, nothing at all is rendered unless there are books. */
  wrap?: (content: ReactNode) => ReactNode;
  className?: string;
}) {
  const { setDetail, preview } = useContext(LibCtx);
  const { mineOf } = useCatalogue();
  const [found, setFound] = useState<Found[] | string | null>(null); // null while loading
  useEffect(() => {
    const stop = new AbortController();
    // The search box remounts this on every key, so wait for a pause before asking.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/discover?${query}`, { signal: stop.signal });
        const body = await res.json();
        setFound(res.ok ? body.books : body.error);
      } catch {
        if (!stop.signal.aborted) setFound("Open Library can’t be reached right now.");
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [query]);

  // minmax(0,…): a long title is cut short instead of stretching the column past the screen.
  const columns = `grid grid-cols-[minmax(0,1fr)] gap-x-[25px] md:grid-cols-[repeat(2,minmax(0,1fr))] ${className ?? ""}`;
  if (found === null) {
    if (wrap) return null;
    // Grey shapes where the books will be, so the page doesn't jump when they arrive.
    const bar = "animate-pulse rounded bg-white/10";
    return as === "carousel" ? (
      <div aria-hidden className={`flex gap-5 overflow-hidden pb-3 ${className ?? ""}`}>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="w-[120px] shrink-0">
            <div className={`${bar} h-[180px]`} />
            <div className={`${bar} mt-3 h-3`} />
            <div className={`${bar} mt-2 h-3 w-2/3`} />
            <div className={`${bar} mt-3 h-[30px]`} />
          </div>
        ))}
      </div>
    ) : (
      <div aria-hidden className={columns}>
        {Array.from({ length: as === "list" ? Math.min(limit, 8) : 10 }, (_, i) =>
          as === "list" ? (
            <div key={i} className="flex items-center gap-[18px] border-b border-white/10 px-2 py-[10px]">
              <div className={`${bar} h-[84px] w-[56px] shrink-0`} />
              <div className="grow">
                <div className={`${bar} h-3 w-1/2`} />
                <div className={`${bar} mt-2 h-3 w-1/3`} />
              </div>
            </div>
          ) : (
            <div key={i} className="border-b border-white/10 px-2 py-[15px]">
              <div className={`${bar} h-[14px] w-1/2`} />
            </div>
          ),
        )}
      </div>
    );
  }
  const books =
    typeof found === "string"
      ? []
      : found.filter((f) => lower(f.title) !== lower(skip)).slice(0, limit);
  if (!books.length)
    return wrap ? null : (
      <p className="text-[14px] text-[#8e8e8e]">
        {typeof found === "string" ? found : "No books found."}
      </p>
    );

  /** The cover, `w` wide; it opens the book when it is already in the library. */
  const art = (f: Found, w: number) => {
    const mine = mineOf(f);
    return (
      <button
        aria-label={`Open ${f.title}`}
        onClick={() => (mine ? setDetail({ ids: [mine.id], id: mine.id }) : preview(f))}
        onPointerEnter={() => loadAbout(f.key)}
        className="block shrink-0"
      >
        <FoundCover found={f} w={w} />
      </button>
    );
  };
  const want = (f: Found) => <FoundMenu found={f} />;

  const content =
    as === "terms" ? (
      <div className={columns}>
        {books.map((f) => (
          // The rule stays straight; only the hover highlight inside it is rounded.
          <div key={f.key} className="border-b border-white/10 py-[2px]">
            <button
              onClick={() => onPick?.(f.title)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-[10px] text-left text-[14px] hover:bg-white/5"
            >
              <Icon name="search" className="size-4 shrink-0 text-[#9a9a9a]" strokeWidth={2} />
              <span className="truncate">{f.title}</span>
            </button>
          </div>
        ))}
      </div>
    ) : as === "list" ? (
      <div className={columns}>
        {books.map((f) => (
          <div key={f.key} className="border-b border-white/10 py-[2px]">
            <div className="flex items-center gap-2 rounded-lg pr-2 hover:bg-white/5">
              <FoundResult found={f} w={56} />
              {want(f)}
            </div>
          </div>
        ))}
      </div>
    ) : (
      <Scroller className={className}>
        {books.map((f) => (
          <div key={f.key} className="w-[120px] shrink-0 text-[13px] leading-[18px]">
            {art(f, 120)}
            <p className="mt-2 truncate font-semibold" data-tip={f.title}>
              {f.title}
            </p>
            <div className="flex items-center justify-between gap-2 text-[#9a9a9a]">
              <span className="truncate">{f.author}</span>
              {want(f)}
            </div>
          </div>
        ))}
      </Scroller>
    );
  return wrap ? wrap(content) : content;
}

function Search() {
  const { s, set } = useContext(LibCtx);
  const [q, setQ] = useState("");
  const [pickedGenre, setGenre] = useState<string | null>(null);
  const [origin, setOrigin] = useState("manga");
  // What this profile has shown it likes: finished, highly rated, started or wanted books.
  // ponytail: a tally of genres and authors, not a recommender; fine for a home library.
  const liked = s.books.filter((b) => b.finished || b.rating || (b.progress ?? 0) > 0 || b.want);
  const top = (books: Book[], of: (b: Book) => string | undefined) => {
    const score = new Map<string, number>();
    for (const b of books) {
      const name = of(b);
      if (name) score.set(name, (score.get(name) ?? 0) + ((b.rating ?? 0) >= 4 ? 3 : b.finished ? 2 : 1));
    }
    return [...score].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  };
  const prose = liked.filter((b) => b.kind !== "comic");
  const likedGenres = top(prose, (b) => b.info?.genre || undefined);
  const likedAuthor = top(prose, (b) => (b.author === UNKNOWN_AUTHOR ? undefined : b.author))[0];
  const likedManga = top(liked.filter((b) => b.kind === "comic"), (b) => b.info?.genre || undefined)[0];
  // A new profile sees what is popular everywhere; after a few books the rows follow its taste.
  const personal = prose.length >= 3 && likedGenres.length > 0;
  const genreChips = [...new Set([...(personal ? likedGenres.slice(0, 3) : []), ...GENRES])];
  const genre = pickedGenre ?? (personal ? (likedGenres[1] ?? likedGenres[0]) : GENRES[0]);
  const q8 = encodeURIComponent;
  const term = q.trim();
  const results = s.books.filter((b) =>
    `${b.title} ${b.author} ${b.series ?? ""} ${b.narrator ?? ""} ${(b.tags ?? []).join(" ")}`
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
  // Library books are kept by id, catalogue books as they were shown.
  const viewed = s.viewed
    .flatMap((v) => (typeof v === "string" ? (s.books.find((b) => b.id === v) ?? []) : v))
    .slice(0, 6);
  const viewedIds = viewed.flatMap((v) => ("id" in v ? v.id : []));
  const found = (query: string, as: "carousel" | "list" | "terms", limit?: number) => (
    <FoundBooks
      key={query}
      query={query}
      as={as}
      limit={limit}
      onPick={setQ}
      className="md:mr-[33px]"
    />
  );

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
            // Not on phones and tablets: focusing would throw the keyboard up over the page.
            autoFocus={typeof matchMedia === "function" && !matchMedia("(pointer: coarse)").matches}
            type="search"
            aria-label="Search"
            placeholder={s.lookups ? "Search Books" : "Search Library"}
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
        <>
          {results.length ? (
            <Section title="In Your Library">{rows(results)}</Section>
          ) : (
            !s.lookups && (
              <EmptyState title="No Results" text={`Nothing in your library matches “${term}”.`} />
            )
          )}
          {s.lookups && (
            <>
              <Section title="More Books">{found(`q=${encodeURIComponent(term)}`, "list", 12)}</Section>
              <Section title="Manga & Manhwa">
                {found(`manga=${encodeURIComponent(term)}`, "carousel")}
              </Section>
            </>
          )}
        </>
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
          {viewed.length > 0 && (
            <Section title="Recently Viewed" onClear={() => set(() => ({ viewed: [] }))}>
              <div className="grid gap-x-6 gap-y-1 py-1 md:grid-cols-3">
                {viewed.map((v) =>
                  "id" in v ? (
                    <Result key={v.id} book={v} w={72} ids={viewedIds} />
                  ) : (
                    <FoundResult key={v.key} found={v} w={72} className="rounded-lg hover:bg-white/5" />
                  ),
                )}
              </div>
            </Section>
          )}
          {s.lookups && (
            <>
              {personal ? (
                <>
                  <Section title={`For You: ${likedGenres[0]}`}>
                    {found(`subject=${q8(likedGenres[0])}&sort=rating`, "list", 8)}
                  </Section>
                  {likedAuthor && (
                    <Section title={`More by ${likedAuthor}`}>
                      {found(`author=${q8(likedAuthor)}`, "carousel")}
                    </Section>
                  )}
                  <Section title={`Trending in ${likedGenres[0]}`}>
                    {found(`subject=${q8(likedGenres[0])}`, "terms", 10)}
                  </Section>
                </>
              ) : (
                <>
                  <Section title="Discover">{found("list=new", "list", 8)}</Section>
                  <Section title="Trending">{found("list=trending", "terms", 10)}</Section>
                </>
              )}
              <Section title="Browse by Genre">
                <div className="mb-4 flex flex-wrap gap-2">
                  {genreChips.map((g) => (
                    <button
                      key={g}
                      aria-pressed={genre === g}
                      onClick={() => setGenre(g)}
                      className={`${controlClass} aria-pressed:bg-[#737373]`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                {found(`subject=${encodeURIComponent(genre)}`, "carousel")}
              </Section>
              <Section title="Manga & Manhwa">
                <div className="mb-4 flex flex-wrap gap-2">
                  {[...(likedManga ? ["for you"] : []), "manga", "manhwa"].map((o) => (
                    <button
                      key={o}
                      aria-pressed={origin === o}
                      onClick={() => setOrigin(o)}
                      className={`${controlClass} capitalize aria-pressed:bg-[#737373]`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
                {found(
                  origin === "for you" && likedManga ? `mangaGenre=${q8(likedManga)}` : `list=${origin}`,
                  "carousel",
                )}
              </Section>
            </>
          )}
          <Section title="In Your Library">
            {s.books.length ? (
              rows(s.books)
            ) : (
              <p className="text-[14px] text-[#8e8e8e]">
                Nothing here yet. Import a book from Home to get started.
              </p>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/**
 * A cover on a shelf. One click selects it (a light halo, until you click elsewhere); a double
 * click or Enter opens the book to read or listen. Details are in its ••• menu.
 * A div, not a button, so the tile around it stays draggable.
 */
function CoverButton({ book, w, ids }: { book: Book; w: number; ids: string[] }) {
  const { setDetail, play, read } = useContext(LibCtx);
  const open = () =>
    !book.file
      ? setDetail({ ids, id: book.id }) // nothing to open: show what is known about it
      : book.kind === "audiobook"
        ? play(book.id)
        : read(book.id);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={book.title}
      data-tip={book.file ? "Double-click to open" : undefined}
      // A finger has no double-click: on touch screens one tap opens the book.
      onClick={() => matchMedia("(pointer: coarse)").matches && open()}
      onDoubleClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
      className="w-fit shrink-0 cursor-pointer outline-none"
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
          // ponytail: metadata is shared, so this edit shows for everyone on the server
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

const canRead = (b: Book) => !!b.file && READABLE.includes(extOf(b.file));

/** The reader, wired to the library: saves position and counts the time it is open and on screen. */
function ReaderHost({ book, onClose }: { book: Book; onClose: () => void }) {
  const { s, set, patch } = useContext(LibCtx);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    patch(book.id, { opened: Date.now() });
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
    // Marks the book as opened once per book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);
  useReadingClock(visible);
  return (
    <Reader
      book={book}
      prefs={s.reader}
      onPrefs={(p) => set((prev) => ({ reader: { ...prev.reader, ...p } }))}
      onPatch={(p) => patch(book.id, p)}
      onClose={onClose}
    />
  );
}

/** Audiobook bar pinned to the bottom of the window. Plays the book's files back to back as one timeline. */
function Player({ book, onClose }: { book: Book; onClose: () => void }) {
  const { patch } = useContext(LibCtx);
  const audio = useRef<HTMLAudioElement>(null);
  const parts = book.files?.length ? book.files : [{ file: book.file!, duration: 0, name: "" }];
  const starts = parts.map((_, i) => parts.slice(0, i).reduce((sum, p) => sum + p.duration, 0));
  /** The file that holds a position on the whole-book timeline, and the offset inside it. */
  const locate = (at: number) => {
    const index = Math.max(0, starts.findLastIndex((start) => start <= at));
    return { index, offset: at - starts[index] };
  };
  const [index, setIndex] = useState(() => locate(book.position ?? 0).index);
  const pending = useRef(locate(book.position ?? 0).offset); // where to start once a file has loaded
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(book.position ?? 0); // seconds into the whole book
  const [measured, setMeasured] = useState(0);
  const [rate, setRate] = useState(1);
  const [sleep, setSleep] = useState(0); // minutes; 0 = off
  const duration = book.duration || measured;
  const chapters = book.chapters ?? [];
  const chapterIndex = chapters.findLastIndex((c) => c.start <= time + 0.5);
  const chapter = chapters[chapterIndex];
  // The bar shows the chapter being played; a book without chapters is one long chapter.
  const from = chapter?.start ?? 0;
  const to = chapters[chapterIndex + 1]?.start ?? duration;

  // While playing, the listening time counts as reading and the position is saved with it.
  useReadingClock(!paused, () =>
    patch(book.id, {
      position: time,
      progress: duration ? Math.min(1, time / duration) : 0,
      opened: Date.now(),
    }),
  );

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
    const target = locate(Math.max(0, Math.min(to, duration || to)));
    setTime(starts[target.index] + target.offset);
    if (target.index === index) audio.current!.currentTime = target.offset;
    else {
      pending.current = target.offset;
      setIndex(target.index);
    }
  };
  const [volume, setVolume] = useState(1);
  const left = (seconds: number) => {
    const m = Math.max(0, Math.round(seconds / 60));
    return m >= 60 ? `${Math.floor(m / 60)} hr, ${m % 60} min left` : `${m} min left`;
  };
  const round = "flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/10";
  const skip = (by: -15 | 15) => (
    <button
      aria-label={by < 0 ? "Back 15 seconds" : "Forward 15 seconds"}
      onClick={() => seek(time + by)}
      className={`${round} relative`}
    >
      <Icon name="skip" className={`size-7 ${by > 0 ? "-scale-x-100" : ""}`} strokeWidth={1.6} />
      <span className="absolute pt-[3px] text-[8px] font-bold">15</span>
    </button>
  );

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 left-3 z-30 flex justify-center max-md:bottom-[76px] md:left-[233px]">
      <div className="pointer-events-auto flex h-[70px] w-full max-w-[860px] items-center gap-4 rounded-full border border-white/15 bg-[#1e1e1e]/90 px-5 shadow-2xl backdrop-blur-xl max-md:gap-2 max-md:px-3">
        <audio
          ref={audio}
          src={`/api/file?file=${parts[index].file}`}
          autoPlay
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onTimeUpdate={(e) => setTime(starts[index] + e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const a = e.currentTarget;
            if (parts.length === 1) setMeasured(a.duration);
            // resume where it stopped, unless that was the very end
            if (pending.current < a.duration - 5) a.currentTime = pending.current;
            pending.current = 0;
            a.playbackRate = rate;
            a.volume = volume;
          }}
          onEnded={() =>
            index < parts.length - 1
              ? setIndex(index + 1) // the next file starts by itself (autoPlay)
              : patch(book.id, { progress: 1, position: 0 })
          }
        />
        <div className="flex shrink-0 items-center gap-1">
          {skip(-15)}
          <button
            aria-label={paused ? "Play" : "Pause"}
            onClick={() => (paused ? audio.current!.play() : audio.current!.pause())}
            className="flex size-10 items-center justify-center rounded-full hover:bg-white/10"
          >
            <Icon
              name={paused ? "play" : "pause"}
              className="size-7"
              fill={paused ? "currentColor" : "none"}
              strokeWidth={paused ? 1.7 : 4}
            />
          </button>
          {skip(15)}
        </div>
        <div className="relative flex min-w-0 grow items-center gap-3 self-stretch">
          <Cover book={book} w={44} />
          <div className="min-w-0">
            <p className="truncate text-[15px]">
              {book.title} · {book.author}
            </p>
            <p className="truncate text-[13px] text-[#9a9a9a]">
              {left(to - time)}
              {chapter && ` · ${chapter.title}`}
            </p>
          </div>
          {/* The thin line is the current chapter; the invisible slider over it does the seeking. */}
          <div className="absolute inset-x-0 bottom-[5px] h-[3px] overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-white/60"
              style={{ width: `${to > from ? ((time - from) / (to - from)) * 100 : 0}%` }}
            />
          </div>
          <input
            type="range"
            aria-label="Position"
            min={from}
            max={to || 1}
            value={time}
            onChange={(e) => seek(Number(e.target.value))}
            className="absolute inset-x-0 bottom-0 h-[13px] w-full cursor-pointer opacity-0"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {chapters.length > 1 && (
            <Popover
              label="Tracks"
              button={<Icon name="list" className="size-6" />}
              buttonClass={round}
              panelClass="bottom-full right-0 mb-5 max-h-[60vh] w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto"
            >
              <div className="px-3 pt-2 pb-3">
                <p className="text-[17px] font-bold">Tracks</p>
                <p className="text-[12px] text-[#9a9a9a]">{left(duration - time)} in audiobook</p>
              </div>
              {chapters.map((c, i) => (
                // The rule stays straight; only the highlight inside it is rounded.
                <div key={c.start} className="border-t border-white/10 py-[2px]">
                  <button
                    role="menuitem"
                    aria-current={c === chapter}
                    onClick={() => seek(c.start)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-[9px] text-left text-[14px] hover:bg-white/10 aria-[current=true]:bg-white/15 aria-[current=true]:font-bold"
                  >
                    <span className="grow truncate">{c.title}</span>
                    {c === chapter && (
                      <span aria-hidden className="eq text-[#c8c8c8]" data-paused={paused}>
                        <span />
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                    <span className="shrink-0 text-[12px] text-[#9a9a9a] tabular-nums">
                      {/* time left in the chapter that is playing, the full length of the others */}
                      {clock((chapters[i + 1]?.start ?? duration) - (c === chapter ? time : c.start))}
                    </span>
                  </button>
                </div>
              ))}
            </Popover>
          )}
          <Popover
            label="Playback speed"
            button={`${rate}×`}
            buttonClass={`${round} text-[13px] font-bold max-md:hidden`}
            panelClass="bottom-full right-0 mb-5 w-[130px]"
          >
            {RATES.map((r) => (
              <MenuItem
                key={r}
                label={`${r}×`}
                checked={rate === r}
                onClick={() => {
                  audio.current!.playbackRate = r;
                  setRate(r);
                }}
              />
            ))}
          </Popover>
          <Popover
            label="Sleep timer"
            button={
              <>
                <Icon name="moon" className="size-5" />
                {sleep > 0 && <span className="text-[11px]">{sleep}</span>}
              </>
            }
            buttonClass={`${round} max-md:hidden`}
            panelClass="bottom-full right-0 mb-5 w-[150px]"
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
          <Popover
            label="Volume"
            button={<Icon name="volume" className="size-6" />}
            buttonClass={`${round} max-md:hidden`}
            panelClass="bottom-full right-0 mb-5 w-[180px] !p-3"
          >
            <input
              type="range"
              aria-label="Volume"
              onClick={(e) => e.stopPropagation()} // a click inside a flyout would otherwise close it
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => {
                const next = Number(e.target.value);
                audio.current!.volume = next;
                setVolume(next);
              }}
              className="block w-full"
            />
          </Popover>
          <button aria-label="Close player" onClick={onClose} className={`${round} text-[#a0a0a0]`}>
            <Icon name="x" className="size-5" />
          </button>
        </div>
      </div>
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
                      data-tip={describe(d)}
                      className={`grow rounded-t ${d.seconds >= goal ? "bg-[#1c9be6]" : "bg-white/30"}`}
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
          {/* phones show the last 26 weeks so the squares stay large enough to tap */}
          <div className="ml-8 grid grid-cols-[repeat(26,minmax(0,1fr))] gap-[2px] md:grid-cols-[repeat(53,minmax(0,1fr))] md:gap-[3px]">
            {weeks.map(([sunday], week) => (
              <span
                key={dayKey(sunday.date)}
                className={`h-4 whitespace-nowrap ${week < 27 ? "max-md:hidden" : ""}`}
              >
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
            {/* 1fr columns, so the grid always fits the card: no scrolling at any width */}
            <div className="grid min-w-0 grow grid-flow-col grid-cols-[repeat(26,minmax(0,1fr))] grid-rows-7 gap-[2px] md:grid-cols-[repeat(53,minmax(0,1fr))] md:gap-[3px]">
              {weeks.flatMap((days, week) => days.map((d) => ({ ...d, week }))).map((d) => {
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
                    className={`aspect-square rounded-[20%] hover:ring-1 hover:ring-white/60 ${d.week < 27 ? "max-md:hidden" : ""} ${d.date > now ? "invisible" : shade(d.seconds)}`}
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
                className={`rounded ${n ? "bg-[#1c9be6]" : "bg-white/15"}`}
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
  { id: "comics", label: "Manga & Comics", icon: "panels" },
];

// 32px + 2px gap keeps the 34px pitch without hover touching the selected row.
const itemClass =
  "mb-[2px] flex h-[32px] w-full items-center gap-[10px] rounded-lg px-[10px] text-left text-[13.500px] font-medium";
const headingClass = "mt-[15px] mb-[7px] px-[7px] text-[13.500px] font-bold";
const UNKNOWN_AUTHOR = "Unknown Author";

type ImportItem = { name: string; status: "waiting" | "working" | "done" | "failed"; note?: string };

/** Files in a drop, including everything inside dropped folders. */
function droppedFiles(data: DataTransfer): Promise<File[]> {
  const walk = async (entry: FileSystemEntry): Promise<File[]> => {
    if (entry.isFile)
      return [await new Promise<File>((ok, no) => (entry as FileSystemFileEntry).file(ok, no))];
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const out: File[] = [];
    // readEntries hands back a batch at a time, and an empty one when the folder is done.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) return out;
      for (const child of batch) out.push(...(await walk(child)));
    }
  };
  // Both are read before the first await: a drop's data is gone once its event is over.
  const files = [...data.files];
  const entries = [...data.items].flatMap((item) => item.webkitGetAsEntry?.() ?? []);
  if (!entries.length) return Promise.resolve(files);
  return Promise.all(entries.map(walk)).then((found) => found.flat());
}

/** Bottom-right card showing how an import is going; expands to a per-file list. */
function ImportPanel({
  items,
  ignored,
  onClose,
}: {
  items: ImportItem[];
  ignored: number;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const finished = done + failed === items.length;
  // Goes away by itself once everything is in; stays when something failed or the list is open.
  useEffect(() => {
    if (!finished || failed || open) return;
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, failed, open]);
  const iconButton = "rounded-lg p-1 hover:bg-white/10";
  return (
    <div className="fixed right-5 bottom-5 z-50 w-[360px] max-w-[calc(100%-24px)] rounded-2xl border border-white/10 bg-[#2c2c2e] p-4 shadow-2xl max-md:right-3 max-md:bottom-[76px]">
      <div className="flex items-center gap-1">
        <p role="status" className="grow text-[14px] font-bold">
          {finished
            ? done
              ? "Import Finished"
              : "Import Failed"
            : `Importing ${done + failed + 1} of ${items.length}`}
        </p>
        <button
          aria-label={open ? "Hide files" : "Show files"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={iconButton}
        >
          <Icon name={open ? "chevronDown" : "chevronUp"} className="size-4" strokeWidth={2} />
        </button>
        {finished && (
          <button aria-label="Dismiss" onClick={onClose} className={iconButton}>
            <Icon name="x" className="size-4" strokeWidth={2} />
          </button>
        )}
      </div>
      <p className="mt-1 truncate text-[13px] text-[#a0a0a0]">
        {finished
          ? `${done} added${failed ? `, ${failed} failed` : ""}${ignored ? `, ${ignored} other file${ignored === 1 ? "" : "s"} ignored` : ""}.`
          : items.find((i) => i.status === "working")?.name}
      </p>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-white transition-[width]"
          style={{ width: `${((done + failed) / items.length) * 100}%` }}
        />
      </div>
      {open && (
        <ul className="mt-3 max-h-[240px] overflow-y-auto text-[13px]">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-3 py-1">
              <span className="min-w-0 grow truncate" data-tip={item.name}>
                {item.name}
              </span>
              <span
                className={`shrink-0 ${item.status === "failed" ? "text-[#ff6b61]" : "text-[#a0a0a0]"}`}
              >
                {item.note ??
                  { waiting: "Waiting", working: "Importing…", done: "Added", failed: "Failed" }[
                    item.status
                  ]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Sign in to an existing account, or create one. */
function SignIn({ onDone }: { onDone: () => void }) {
  const [options, setOptions] = useState({ first: false, signups: true });
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [sent, setSent] = useState<string | null>(null); // email a reset code was requested for
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth")
      .then((res) => res.json())
      .then((body) => {
        setOptions(body);
        if (body.first) setMode("register"); // nobody to sign in as yet
      })
      .catch(() => {});
  }, []);

  const registering = mode === "register";
  const switchTo = (m: typeof mode) => {
    setMode(m);
    setSent(null);
    setError(null);
  };
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const failed = await authCall(body);
    setBusy(false);
    if (failed) setError(failed);
    else onDone();
  };
  const field = (
    name: string,
    label: string,
    props: InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label className="block">
      <span className="mb-1 block text-[12px] font-bold text-[#a0a0a0]">{label}</span>
      <input name={name} className={fieldClass} {...props} />
    </label>
  );
  /** Password field; once it has text, an eye at its right end shows or hides what was typed. */
  const secret = (name: string, label: string, fresh: boolean) => (
    <label className="block">
      <span className="mb-1 block text-[12px] font-bold text-[#a0a0a0]">{label}</span>
      <span className="relative block">
        <input
          name={name}
          type={show ? "text" : "password"}
          placeholder=" " // lets CSS tell an empty field from a filled one
          autoComplete={fresh ? "new-password" : "current-password"}
          minLength={fresh ? 8 : undefined}
          required
          className={`${fieldClass} peer pr-10`}
        />
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          onClick={() => setShow(!show)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-[#a0a0a0] peer-placeholder-shown:hidden hover:text-white"
        >
          <Icon name={show ? "eye" : "eyeOff"} className="size-5" />
        </button>
      </span>
    </label>
  );

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-[440px] max-w-full rounded-[28px] bg-[#2c2c2e] p-8 shadow-2xl">
        <Icon name="book" className="size-9" />
        <h1 className="mt-3 font-serif text-[28px] font-bold">
          {registering ? "Create your account" : mode === "forgot" ? "Reset your password" : "Welcome back"}
        </h1>
        <p className="mt-1 text-[14px] text-[#a0a0a0]">
          {options.first
            ? "This library is new. The first account becomes its admin."
            : registering
              ? "Your shelves, progress and reading stats are kept under your account."
              : mode === "forgot"
                ? sent
                  ? "Enter the code and choose a new password."
                  : "Enter your account’s email to get a reset code."
                : "Sign in to pick up where you left off."}
        </p>

        {options.signups && !options.first && mode !== "forgot" && (
          <div className="mt-6 grid grid-cols-2 gap-1 rounded-lg bg-white/5 p-1">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => switchTo(m)}
                className="h-[30px] rounded-lg text-[13px] font-bold hover:bg-white/5 aria-pressed:bg-[#737373]"
              >
                {m === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>
        )}

        <form
          key={mode + (sent ?? "")}
          className="mt-6 flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.currentTarget));
            if ("confirm" in data && data.password !== data.confirm)
              return setError("The two passwords don’t match.");
            if (mode !== "forgot")
              return send({ ...data, action: mode, remember: data.remember === "on" });
            if (sent) return send({ ...data, action: "reset", email: sent });
            setBusy(true);
            const failed = await authCall({ action: "forgot", email: data.email });
            setBusy(false);
            setError(failed);
            if (!failed) setSent(String(data.email));
          }}
        >
          {registering && (
            <div className="grid grid-cols-2 gap-3">
              {field("first", "First name", {
                autoComplete: "given-name",
                required: true,
                maxLength: 40,
                autoFocus: true,
              })}
              {field("last", "Last name (optional)", { autoComplete: "family-name", maxLength: 40 })}
            </div>
          )}
          {registering &&
            !options.first &&
            field("family", "Family code (optional)", {
              inputMode: "numeric",
              pattern: "\\d{6}",
              maxLength: 6,
              placeholder: "6 digits, from a family member’s Settings",
              ...{ "data-tip": "Six digits" },
            })}
          {sent ? (
            <>
              <p className="text-[13px] leading-[19px] text-[#a0a0a0]">
                If {sent} has an account, it now has a reset code. Ask this server’s admin for
                it: they see it under Settings → Account, and it is written to the server log.
                The code works for 30 minutes.
              </p>
              {field("code", "Reset code", {
                inputMode: "numeric",
                autoComplete: "one-time-code",
                required: true,
                autoFocus: true,
              })}
            </>
          ) : (
            field("email", "Email", {
              type: "email",
              autoComplete: "email",
              required: true,
              autoFocus: !registering,
            })
          )}
          {mode === "login" && secret("password", "Password", false)}
          {(registering || sent) &&
            secret("password", `${sent ? "New password" : "Password"} (at least 8 characters)`, true)}
          {(registering || sent) && secret("confirm", "Confirm password", true)}
          {mode !== "forgot" && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <label
                className="flex items-center gap-2"
                data-tip="Stay signed in on this device for 30 days"
              >
                <input type="checkbox" name="remember" defaultChecked />
                Remember me
              </label>
              {mode === "login" && (
                <button
                  type="button"
                  onClick={() => switchTo("forgot")}
                  className="text-[#a0a0a0] hover:text-white hover:underline"
                >
                  Forgot password?
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-[#ff6b61]">
              {error}
            </p>
          )}
          <button disabled={busy} className={`${primaryClass} h-[38px] w-full disabled:opacity-60`}>
            {registering
              ? "Create Account"
              : mode === "login"
                ? "Sign In"
                : sent
                  ? "Set New Password"
                  : "Get Reset Code"}
          </button>
          {mode === "forgot" && (
            <button
              type="button"
              onClick={() => switchTo("login")}
              className="text-[13px] text-[#a0a0a0] hover:text-white hover:underline"
            >
              Back to sign in
            </button>
          )}
        </form>

        {!options.signups && (
          <p className="mt-4 text-center text-[12px] text-[#8c8c8c]">
            New accounts are turned off here. Ask the server’s admin to let you in.
          </p>
        )}
      </div>
    </main>
  );
}

export default function Page() {
  const [s, setS] = useState(INITIAL);
  const [auth, setAuth] = useState<Account | "loading" | "signin" | "offline">("loading");
  const loaded = typeof auth === "object";
  const [saving, setSaving] = useState<"ok" | "failing">("ok");
  const [savedAt, setSavedAt] = useState(0); // bumps whenever the server and this tab agree again
  const synced = useRef(INITIAL); // the state the server is known to have
  const latest = useRef(INITIAL);
  const sending = useRef(false);
  const merges = useRef<((state: Saved) => Saved)[]>([]); // server-side changes that arrived mid-save
  const [view, setView] = useState("home"); // nav id, or `c:<collection id>`
  const [renaming, setRenaming] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [previewing, setPreviewing] = useState<Found | null>(null);
  const [picking, setPicking] = useState<"auto" | "asked" | null>(null); // profile picker
  const [social, setSocial] = useState(NO_SOCIAL);
  const loadSocial = () =>
    fetch("/api/social")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body && setSocial(body))
      .catch(() => {});
  const [hud, setHud] = useState<{ title: string; text: string } | null>(null);
  const requested = useRef(new Set<string>());
  const [navOpen, setNavOpen] = useState(false); // sidebar drawer on narrow windows
  const [importing, setImporting] = useState(false);
  const [dropping, setDropping] = useState(false);
  // The running import: every file queued so far, plus how many unsupported files were left out.
  const [job, setJob] = useState<{ items: ImportItem[]; ignored: number } | null>(null);
  const queue = useRef<File[]>([]);
  const cursor = useRef(0); // index in job.items of the next queued file
  const busy = useRef(false);
  const dragId = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null); // audiobook in the player
  const [editing, setEditing] = useState<string | null>(null); // book in Edit Details
  const [readingId, setReadingId] = useState<string | null>(null); // book open in the reader
  const [settingsTab, setSettingsTab] = useState<string | null>(null); // open settings modal
  const [offline, setOffline] = useState(new Set<string>()); // book files kept on this device
  const [downloading, setDownloading] = useState(new Set<string>()); // book ids being fetched
  const userId = useRef(0);
  const carry = useRef<Batch | null>(null); // changes from an earlier offline visit, not sent yet
  useEffect(() => {
    registerWorker();
    downloadedFiles().then(setOffline);
  }, []);

  const load = async () => {
    try {
      const res = await fetch("/api/library");
      if (res.status === 401) return setAuth("signin");
      const body = await res.json();
      const state: Saved = { ...INITIAL, ...body.prefs, books: body.books, log: body.log };
      // Changes that couldn't be sent last time are shown again and go out with the next save.
      userId.current = body.user.id;
      carry.current = loadPending(body.user.id);
      const shown = carry.current ? applyBatch(state, carry.current) : state;
      synced.current = state;
      latest.current = shown;
      setS(shown);
      // The service worker answered from its copy: the server can't be reached.
      if (res.headers.get("X-From-Cache")) setSaving("failing");
      setAuth(body.user);
      setSavedAt(Date.now());
      loadSocial();
    } catch {
      setAuth("offline");
    }
  };
  useEffect(() => {
    load();
    // Runs once; `load` only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sends whatever changed since the last save. One request at a time; retries until it gets through. */
  const flush = async (keepalive = false) => {
    if (sending.current) return;
    const snapshot = latest.current;
    const carried = carry.current;
    const batch = mergeBatch(carried, diff(synced.current, snapshot));
    if (!batch) return;
    sending.current = true;
    merges.current = [];
    try {
      const res = await fetch("/api/library", {
        method: "PATCH",
        body: JSON.stringify(batch),
        keepalive,
      });
      if (res.status === 401) return setAuth("signin");
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      // Anything the server told us during the request was merged into the old baseline; replay it.
      synced.current = merges.current.reduce((state, fn) => fn(state), snapshot);
      carry.current = null;
      savePending(userId.current, null);
      // Reading time that waited offline is on the server now; count it here as well.
      if (carried?.time)
        merge((state) => {
          const log = { ...state.log };
          for (const [day, seconds] of Object.entries(carried.time!)) log[day] = (log[day] ?? 0) + seconds;
          return { ...state, log };
        });
      setSaving("ok");
      setSavedAt(Date.now());
    } catch {
      // Kept on the device, so closing the app offline doesn't lose it.
      savePending(userId.current, batch);
      setSaving("failing");
      setTimeout(flush, 5000);
    } finally {
      sending.current = false;
    }
    if (latest.current !== snapshot) flush();
  };
  useEffect(() => {
    latest.current = s;
    if (!loaded) return;
    const timer = setTimeout(flush, 800);
    return () => clearTimeout(timer);
    // `flush` reads everything through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, loaded]);
  useEffect(() => {
    // Closing the tab inside the 0.8s debounce would otherwise drop the last change.
    const leave = () => flush(true);
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Applies a change that is already on the server (an import, a lookup result), so it is not sent back. */
  const merge = (fn: (state: Saved) => Saved) => {
    setS(fn);
    synced.current = fn(synced.current);
    merges.current.push(fn);
    setSavedAt(Date.now());
  };
  const mergeBook = (id: string, fields: Partial<Book>) =>
    merge((state) => ({
      ...state,
      books: state.books.map((b) => (b.id === id ? { ...b, ...fields } : b)),
    }));

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

  // A further file of an audiobook updates the book that is already there.
  const addBook: Lib["addBook"] = (book) =>
    merge((state) => ({
      ...state,
      books: state.books.some((b) => b.id === book.id)
        ? state.books.map((b) => (b.id === book.id ? { ...b, ...book } : b))
        : [...state.books, book],
    }));

  /** Uploads one file at a time; files added while it runs join the same queue. */
  const importFiles: Lib["importFiles"] = async (files) => {
    // A folder also holds cover images, notes and the like; those are left out.
    const accepted = files.filter((f) => kindOf(f.name));
    if (!accepted.length)
      return toast("Nothing to Import", `No supported files were found. ${FORMATS}`);
    setJob((prev) => ({
      ignored: (prev?.ignored ?? 0) + files.length - accepted.length,
      items: [
        ...(prev?.items ?? []),
        ...accepted.map((f): ImportItem => ({ name: f.name, status: "waiting" })),
      ],
    }));
    queue.current.push(...accepted);
    if (busy.current) return;
    busy.current = true;
    for (let f; (f = queue.current.shift()); ) {
      const at = cursor.current++;
      const mark = (status: ImportItem["status"], note?: string) =>
        setJob(
          (prev) =>
            prev && {
              ...prev,
              items: prev.items.map((item, i) => (i === at ? { ...item, status, note } : item)),
            },
        );
      mark("working");
      try {
        // Sent in pieces: the tunnel the app is published through refuses requests over 100 MB.
        const PIECE = 64 * 1024 * 1024;
        const upload = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        let res: Response;
        for (let offset = 0; ; offset += PIECE) {
          const last = offset + PIECE >= f.size;
          res = await fetch(
            `/api/import?name=${encodeURIComponent(f.name)}&upload=${upload}&offset=${offset}${last ? "&last=1" : ""}`,
            { method: "PUT", body: f.slice(offset, offset + PIECE) },
          );
          if (last || !res.ok) break;
          mark("working", `${Math.round(((offset + PIECE) / f.size) * 100)}% sent`);
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
        const book: Book = body.book;
        addBook(book);
        if (book.kind === "pdf" && !book.coverFile) {
          // A PDF's cover is its first page, drawn here because only the browser can render one.
          const cover = await pdfCover(f).catch(() => null);
          const saved = cover && (await fetch(`/api/file?book=${book.id}`, { method: "PUT", body: cover }));
          if (saved?.ok) mergeBook(book.id, await saved.json());
        }
        mark(
          "done",
          body.duplicate
            ? "Already in your library"
            : body.merged
              ? `Added to “${book.title}”`
              : undefined,
        );
      } catch (e) {
        mark("failed", e instanceof TypeError ? "Can’t reach the server" : (e as Error).message);
      }
    }
    busy.current = false;
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
      droppedFiles(e.dataTransfer!).then(importFiles);
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
  // A shared shelf (`x:<id>`) is shown like one of your own; only where it is stored differs.
  const sharedShelf = social.shelves.find((c) => `x:${c.id}` === view);
  const collection: { id: string; name: string; bookIds: string[] } | undefined =
    s.collections.find((c) => `c:${c.id}` === view) ??
    (sharedShelf && { ...sharedShelf, id: String(sharedShelf.id) });
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

  // Ask the server to fill in what a book is missing (cover, description, ratings), once
  // per book. Runs on saved state, so a title edit is on the server before it is looked up.
  useEffect(() => {
    if (!loaded || !s.lookups) return;
    for (const b of synced.current.books) {
      const key = `${b.id}|${b.title}|${b.author}`;
      // Records from an older version of the lookup are refreshed once.
      const complete = b.info === null || b.info?.v === INFO_VERSION;
      if (complete || requested.current.has(key)) continue;
      requested.current.add(key);
      fetch("/api/lookup", { method: "POST", body: JSON.stringify({ id: b.id }) })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => body && mergeBook(b.id, body.patch))
        .catch(() => {}); // offline: asked again on the next visit
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedAt, loaded, s.lookups]);

  // Like a TV app: when the account has several profiles, opening the app asks who is reading.
  // Once per browser session, so a reload does not ask again.
  useEffect(() => {
    if (!loaded || sessionStorage.getItem("asked-who")) return;
    sessionStorage.setItem("asked-who", "1");
    setPicking((now) => now ?? "auto");
  }, [loaded]);
  const filePicker = useRef<HTMLInputElement>(null);

  if (!loaded)
    return auth === "loading" ? null : auth === "offline" ? (
      <main className="flex h-full flex-col items-center justify-center">
        <EmptyState title="Can’t Reach the Server" text="Check that the library server is running, then try again." />
        <button onClick={load} className={`${controlClass} mt-5`}>
          Try Again
        </button>
      </main>
    ) : (
      <SignIn
        onDone={() => {
          setPicking("auto");
          load();
        }}
      />
    );
  const user = auth;
  /** Import: a phone goes straight to its files; elsewhere the sheet opens with the file chooser over it. */
  const startImport = () => {
    if (!matchMedia("(pointer: coarse)").matches) setImporting(true);
    filePicker.current?.click();
  };

  const lib: Lib = {
    s,
    set,
    patch,
    toast,
    setView: go,
    setDetail: (d) => {
      setDetail(d);
      if (d)
        set((prev) => ({ viewed: [d.id, ...prev.viewed.filter((id) => id !== d.id)].slice(0, 12) }));
    },
    preview: (f) => {
      setPreviewing(f);
      set((prev) => ({
        viewed: [f, ...prev.viewed.filter((v) => typeof v === "string" || v.key !== f.key)].slice(0, 12),
      }));
    },
    pickProfile: () => setPicking("asked"),
    social,
    socialCall: async (body) => {
      const res = await fetch("/api/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      const answer = await res?.json().catch(() => null);
      if (!res?.ok) {
        toast("Not Done", answer?.error ?? "The server couldn’t be reached.");
        return null;
      }
      await loadSocial();
      return answer;
    },
    user,
    logout: async () => {
      await flush();
      await authCall({ action: "logout" });
      await forgetLibrary();
      location.reload();
    },
    offline,
    downloading,
    keepOffline: async (book) => {
      const files = filesOf(book);
      if (!canWorkOffline())
        return toast(
          "Not Available Here",
          "Browsers only allow offline storage on a secure (https) address or on localhost.",
        );
      const mark = (on: boolean) =>
        setDownloading((prev) => {
          const next = new Set(prev);
          if (on) next.add(book.id);
          else next.delete(book.id);
          return next;
        });
      if (files.every((f) => offline.has(f))) await removeDownloads(files);
      else {
        mark(true);
        try {
          await download(files);
          warmReader(); // the reader's own code has to be on the device too
          toast("Downloaded", `“${book.title}” can now be opened without a connection.`);
        } catch {
          await removeDownloads(files); // no half-downloaded audiobooks
          toast("Not Downloaded", "The file couldn’t be fetched, or this device is out of space.");
        }
        mark(false);
      }
      setOffline(await downloadedFiles());
    },
    clearOffline: async () => {
      await removeDownloads([...offline]);
      setOffline(new Set());
    },
    openImport: startImport,
    importFiles,
    addBook,
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
      // A book with no file is only there because it was wanted (or finished), so un-wanting drops it.
      if (b.want && !b.file && !b.finished)
        set((prev) => ({
          books: prev.books.filter((x) => x.id !== b.id),
          collections: prev.collections.map((c) => ({
            ...c,
            bookIds: c.bookIds.filter((id) => id !== b.id),
          })),
        }));
      else patch(b.id, { want: !b.want });
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

  const deleteShelf = async (id: string) => {
    if (sharedShelf && String(sharedShelf.id) === id) {
      const gone = await ask({
        title: `Delete “${sharedShelf.name}”?`,
        text: "The shared shelf is deleted for everyone. Its books stay in the library.",
        action: "Delete",
        danger: true,
      });
      if (gone === null) return;
      await lib.socialCall({ action: "deleteShelf", id: sharedShelf.id });
      return setView("all");
    }
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

  const navButton = (id: string, label: string, icon: IconName, renameKey?: string) => (
    <button
      key={id}
      onClick={() => go(id)}
      onDoubleClick={() => renameKey && setRenaming(renameKey)}
      className={`${itemClass} ${view === id ? "bg-[#737373]" : "hover:bg-white/5"}`}
    >
      <Icon name={icon} />
      <span className="truncate">{label}</span>
    </button>
  );
  /** A shelf in the sidebar, your own or a shared one: renamed in place, with a ••• menu on hover. */
  const shelfRow = (
    key: string, // also what `renaming` holds while this row is being renamed
    viewId: string,
    name: string,
    icon: IconName,
    editable: boolean,
    onRename: (name: string) => void,
    onDelete: () => void,
    sharing?: { label: string; onClick: () => void }, // share with the family, or stop sharing
    more?: ReactNode, // further menu items: who a shared shelf is shared with
  ) =>
    renaming === key ? (
      <div key={key} className={`${itemClass} bg-[#737373]`}>
        <Icon name={icon} />
        <input
          autoFocus
          aria-label="Shelf name"
          defaultValue={name}
          maxLength={60}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== name) onRename(next);
            setRenaming(null);
          }}
          className="w-full min-w-0 bg-[#1e1e1e] px-1 outline-none"
        />
      </div>
    ) : (
      <div key={key} className="group relative [&>button]:pr-8">
        {navButton(viewId, name, icon, editable ? key : undefined)}
        {editable && (
          <div className="absolute top-[6px] right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-md:opacity-100">
            <Popover
              label={`Options for ${name}`}
              button={DOTS}
              buttonClass="block py-[7px] text-[#d0d0d0] hover:text-white"
              panelClass="w-[190px] max-md:w-[250px]"
            >
              <MenuItem icon="pencil" label="Rename" onClick={() => setRenaming(key)} />
              {sharing && <MenuItem icon="people" label={sharing.label} onClick={sharing.onClick} />}
              <MenuItem icon="trash" label="Delete" onClick={onDelete} />
              {more}
            </Popover>
          </div>
        )}
      </div>
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
          className={`my-[9px] mt-[13px] ml-[9px] flex w-[212px] shrink-0 flex-col rounded-2xl border border-white/10 bg-[#1b1b1b] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform md:relative md:z-[41] ${navOpen ? "" : "max-md:-translate-x-[240px]"}`}
        >
          <nav className="grow overflow-y-auto px-[9px] pt-[13px]">
            {TOP_NAV.map((n) => navButton(n.id, n.label, n.icon))}
            <h3 className={headingClass}>Library</h3>
            {LIBRARY_NAV.map((n) => navButton(n.id, n.label, n.icon))}
            <h3 className={headingClass}>My Shelves</h3>
            {s.collections.map((c) =>
              shelfRow(
                c.id,
                `c:${c.id}`,
                c.name,
                "lines",
                true,
                (name) =>
                  set((prev) => ({
                    collections: prev.collections.map((x) => (x.id === c.id ? { ...x, name } : x)),
                  })),
                () => deleteShelf(c.id),
                {
                  label: "Share with Family",
                  onClick: async () => {
                    const made = await lib.socialCall({ action: "newShelf", name: c.name, books: c.bookIds });
                    if (!made) return;
                    set((prev) => ({ collections: prev.collections.filter((x) => x.id !== c.id) }));
                    if (view === `c:${c.id}`) go(`x:${made.id}`);
                  },
                },
              ),
            )}
            {social.shelves.map((c) =>
              shelfRow(
                `x:${c.id}`,
                `x:${c.id}`,
                c.name,
                "people",
                c.mine,
                (name) => lib.socialCall({ action: "renameShelf", id: c.id, name }),
                async () => {
                  const gone = await ask({
                    title: `Delete “${c.name}”?`,
                    text: "The shared shelf is deleted for everyone. Its books stay in the library.",
                    action: "Delete",
                    danger: true,
                  });
                  if (gone === null) return;
                  await lib.socialCall({ action: "deleteShelf", id: c.id });
                  if (view === `x:${c.id}`) setView("all");
                },
                {
                  label: "Stop Sharing",
                  onClick: async () => {
                    // Becomes one of your own shelves again, with the books it has now.
                    const id = Date.now().toString(36);
                    if (!(await lib.socialCall({ action: "deleteShelf", id: c.id }))) return;
                    set((prev) => ({
                      collections: [...prev.collections, { id, name: c.name, bookIds: c.bookIds }],
                    }));
                    if (view === `x:${c.id}`) go(`c:${id}`);
                  },
                },
                // Whoever made the shelf picks who sees it: the whole family, or just some of them.
                c.owned && social.people.length > 0 && (
                  <>
                    {MENU_RULE}
                    <p className="px-[6px] pt-1 pb-[3px] text-[11px] font-bold text-[#777]">Shared With</p>
                    <MenuItem
                      label="Everyone in the Family"
                      checked={!c.members}
                      onClick={() => lib.socialCall({ action: "shareWith", id: c.id, members: null })}
                    />
                    {social.people.map((p) => (
                      <MenuItem
                        key={p.id}
                        label={p.name}
                        checked={c.members?.includes(p.id) ?? false}
                        onClick={() =>
                          lib.socialCall({
                            action: "shareWith",
                            id: c.id,
                            members: c.members?.includes(p.id)
                              ? c.members.filter((id) => id !== p.id)
                              : [...(c.members ?? []), p.id],
                          })
                        }
                      />
                    ))}
                  </>
                ),
              ),
            )}
            <Popover
              label="New Shelf"
              button={
                <>
                  <Icon name="plus" />
                  New Shelf
                </>
              }
              buttonClass={`${itemClass} hover:bg-white/5 aria-expanded:bg-white/10`}
              panelClass="w-[210px] max-md:w-[270px]"
            >
              <MenuItem icon="lines" label="Just for Me" onClick={() => lib.newCollection()} />
              <MenuItem
                icon="people"
                label="Shared with Family"
                onClick={async () => {
                  // Made with a placeholder name and put straight into renaming, like your own shelves.
                  const made = await lib.socialCall({ action: "newShelf", name: "Untitled Shelf" });
                  if (!made) return;
                  go(`x:${made.id}`);
                  setRenaming(`x:${made.id}`);
                }}
              />
              {/* With more than one other person: a shelf for just one of them. More can be added from its ••• menu. */}
              {social.people.length > 1 &&
                social.people.map((p) => (
                  <MenuItem
                    key={p.id}
                    icon="user"
                    label={`Shared with ${p.name}`}
                    onClick={async () => {
                      const made = await lib.socialCall({ action: "newShelf", name: "Untitled Shelf", members: [p.id] });
                      if (!made) return;
                      go(`x:${made.id}`);
                      setRenaming(`x:${made.id}`);
                    }}
                  />
                ))}
            </Popover>
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
                      {user.name[0].toUpperCase()}
                    </span>
                    <span className="truncate text-[13.500px] font-bold">{user.name}</span>
                  </>
                }
                panelClass="bottom-full left-0 mb-1 w-full"
              >
                <p className="truncate px-[6px] py-1 text-[12px] text-[#9a9a9a]">{user.name}</p>
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
                    startImport();
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
                {MENU_RULE}
                <MenuItem icon="user" label="Switch Profile" onClick={lib.pickProfile} />
                <MenuItem icon="logout" label="Log Out" onClick={lib.logout} />
              </Popover>
            </div>
        </aside>

        <main
          // Clear of the phone's notch at the top and of the tab bar (plus home indicator) at the bottom.
          className={`relative flex min-w-0 grow flex-col overflow-x-hidden overflow-y-auto px-[max(1rem,env(safe-area-inset-left))] pt-[max(1.5rem,env(safe-area-inset-top))] md:pt-[52px] md:pr-[10px] md:pl-[43px] ${playingBook ? "pb-[130px] max-md:pb-[calc(250px+env(safe-area-inset-bottom))]" : "pb-[27px] max-md:pb-[calc(90px+env(safe-area-inset-bottom))]"}`}
        >
          {!loaded ? (
            // Grey covers while the library is fetched, so the page is never just blank.
            <div role="status" aria-label="Loading your library" className="animate-pulse">
              <div className="mb-8 h-[42px] w-[180px] rounded-lg bg-white/10 md:mb-[44px]" />
              <div className="flex flex-wrap gap-x-[27px] gap-y-10 max-md:[zoom:0.86]">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="h-[282px] w-[188px] rounded-[3px] bg-white/10" />
                ))}
              </div>
            </div>
          ) : view === "search" ? (
            <Search />
          ) : (
            <>
              <div className="mb-8 flex items-center justify-between gap-4 md:mr-[33px] md:mb-[44px]">
                <h1 className="font-serif text-[36px] leading-[52px] font-bold">{title}</h1>
                {view === "home" && (
                  <button
                    onClick={startImport}
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
                  group={s.stack && ["all", "books", "audiobooks", "pdfs", "comics"].includes(view)}
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
                  {MENU_RULE}
                  <MenuItem
                    label="Stack Series"
                    icon="shelf"
                    checked={s.stack}
                    onClick={() => set((prev) => ({ stack: !prev.stack }))}
                  />
                  {sharedShelf?.mine && (
                    <>
                      {MENU_RULE}
                      <MenuItem
                        label="Rename Shelf"
                        icon="pencil"
                        checked={false}
                        onClick={() => setRenaming(`x:${sharedShelf.id}`)}
                      />
                    </>
                  )}
                  {collection && (!sharedShelf || sharedShelf.mine) && (
                    <>
                      {!sharedShelf?.mine && MENU_RULE}
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
                  ...count("comic", "comic"),
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
        {previewing && <FoundSheet found={previewing} onClose={() => setPreviewing(null)} />}
        {picking && (
          <ProfilePicker
            auto={picking === "auto"}
            onClose={() => setPicking(null)}
            onManage={() => {
              setPicking(null);
              setSettingsTab("profile");
            }}
            onPick={async (id, pin) => {
              await flush();
              const failed = await authCall({ action: "switchProfile", id, pin });
              if (failed) return toast("Not Switched", failed);
              location.reload();
            }}
          />
        )}
        {editingBook && <EditSheet book={editingBook} onClose={() => setEditing(null)} />}
        {readingBook && (
          <ReaderHost key={readingBook.id} book={readingBook} onClose={() => setReadingId(null)} />
        )}
        {playingBook && (
          <Player key={playingBook.id} book={playingBook} onClose={() => setPlaying(null)} />
        )}
        {importing && <ImportSheet onClose={() => setImporting(false)} />}
        <input
          ref={filePicker}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="Choose files to import"
          className="sr-only"
          onChange={(e) => {
            lib.importFiles([...(e.target.files ?? [])]);
            e.target.value = ""; // so the same file can be chosen again
            setImporting(false);
          }}
        />
        {dropping && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-[28px] border-2 border-dashed border-white/30 text-center">
              <Icon name="import" className="size-12 text-[#a0a0a0]" />
              <p className="font-serif text-[24px] font-bold">Drop to Import</p>
              <p className="max-w-[520px] text-[13px] text-[#a0a0a0]">{FORMATS}</p>
            </div>
          </div>
        )}
        {saving === "failing" && (
          <p
            role="status"
            className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#5a2320] px-5 py-2 text-[13px] shadow-2xl md:left-[calc(50%+110px)]"
          >
            Can’t reach the server. Your changes will be saved when it’s back.
          </p>
        )}
        {job && (
          <ImportPanel
            {...job}
            onClose={() => {
              setJob(null);
              cursor.current = 0;
            }}
          />
        )}
        {hud && (
          <div
            role="status"
            className="pointer-events-none fixed top-1/2 left-1/2 z-50 w-[258px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-[#3a3a3c]/75 px-6 pt-10 pb-7 text-center backdrop-blur-2xl md:left-[calc(50%+110px)]"
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
