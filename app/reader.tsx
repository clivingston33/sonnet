"use client";

/** In-app reader: EPUB (epub.js), PDF (pdf.js), comic archives and plain text. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Book as EpubBook, Contents, Location, NavItem, Rendition } from "epubjs";
import type Section from "epubjs/types/section";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Book, Highlight, Mark, PageMode, ReaderPrefs } from "./sync";
import {
  EmptyState,
  Icon,
  MENU_RULE,
  MenuItem,
  Popover,
  controlClass,
  fieldClass,
  type IconName,
} from "./ui";

/** Extensions the reader can open. */
export const READABLE = ["epub", "pdf", "cbz", "txt"];
export const extOf = (file: string) => file.split(".").pop()!.toLowerCase();

type Patch = Partial<Pick<Book, "cfi" | "page" | "progress" | "bookmarks" | "highlights" | "mode">>;
type Props = {
  book: Book;
  prefs: ReaderPrefs;
  onPrefs: (p: Partial<ReaderPrefs>) => void;
  /** Position, progress, bookmarks or highlights changed; the parent saves them and passes the book back. */
  onPatch: (p: Patch) => void;
  onClose: () => void;
};

const THEMES = {
  dark: { bg: "#1e1e1e", fg: "#e6e6e6" },
  sepia: { bg: "#f4ecd8", fg: "#3b2f1e" },
  light: { bg: "#ffffff", fg: "#1a1a1a" },
};
const src = (book: Book) => `/api/file?file=${book.file}`;
// `current` so the hover shows on light pages as well as dark ones.
const iconButton = "rounded-lg p-1 hover:bg-current/10 aria-pressed:bg-current/15";
const failed = (
  <EmptyState
    title="Can’t Open This Book"
    text="The file couldn’t be read. It may be damaged or protected."
  />
);

async function pdfjs() {
  // Loaded on demand: pdf.js needs browser globals, so it can't be imported during server rendering.
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc ||= new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  return lib;
}

/** Renders page 1 of a PDF to a JPEG about 600px wide, for use as its cover. */
export async function pdfCover(file: Blob) {
  const doc = await (await pdfjs()).getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 600 / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, viewport }).promise;
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob(resolve, "image/jpeg", 0.85);
  const cover = await promise;
  await doc.loadingTask.destroy();
  return cover;
}

/**
 * The reading screen, laid out like an e-reader: the page fills the window, the toolbar
 * stays out of sight until the pointer goes to the top, and the bottom line says where you are.
 */
function Shell({
  book,
  onClose,
  controls,
  panel,
  onPanelClose,
  footer,
  tone = THEMES.dark,
  status,
  onTurn,
  children,
}: {
  book: Book;
  onClose: () => void;
  controls?: ReactNode;
  panel?: { title: string; body: ReactNode } | null;
  onPanelClose?: () => void;
  footer?: ReactNode;
  tone?: { bg: string; fg: string }; // page colours
  status?: string; // bottom-left line, e.g. the chapter
  onTurn?: (by: -1 | 1) => void; // given: the page's side margins turn the page
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // True while the pointer is in the top strip of the window. An EPUB's own frame keeps pointer
  // moves to itself, so over the text column it is the header's own height that counts.
  const [near, setNear] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Reading ${book.title}`}
      className="fixed inset-0 z-[45] flex flex-col"
      style={{ background: tone.bg, color: tone.fg }}
      onMouseMove={(e) => setNear(e.clientY < 150)}
      onMouseLeave={() => setNear(false)}
    >
      {/* Dimmed until the pointer is near the top; it lingers a moment before dimming again.
          Touch screens have no hover, so there it is always shown. */}
      <header
        className={`flex min-h-[64px] flex-wrap items-center gap-1 px-3 py-2 transition-opacity duration-200 focus-within:opacity-100 hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 has-[[aria-pressed=true]]:opacity-100 [@media(hover:none)]:opacity-100 ${near ? "opacity-100" : "opacity-40 delay-700"}`}
      >
        <button
          aria-label="Back to library"
          onClick={onClose}
          className={`${iconButton} flex items-center gap-1 pr-2 text-[13px]`}
        >
          <Icon name="chevronLeft" className="size-5" />
          Library
        </button>
        <h2 className="min-w-[80px] grow basis-0 truncate text-center text-[13px] opacity-70">
          {book.title}
        </h2>
        {controls}
      </header>
      <div className="relative flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col">{children}</div>
        {onTurn &&
          ([-1, 1] as const).map((by) => (
            <button
              key={by}
              aria-label={by < 0 ? "Page to the left" : "Page to the right"}
              onClick={() => onTurn(by)}
              // As wide as the margin beside the 720px page, and never too narrow to tap.
              className={`group absolute inset-y-0 flex w-[max(44px,calc((100%-760px)/2))] items-center ${by < 0 ? "left-0 justify-start pl-3" : "right-0 justify-end pr-3"}`}
            >
              <Icon
                name={by < 0 ? "chevronLeft" : "chevronRight"}
                className="size-7 opacity-0 transition-opacity group-hover:opacity-40"
                strokeWidth={1.5}
              />
            </button>
          ))}
        {panel && (
          // A floating rounded card, like the app's sidebar.
          <aside className="absolute inset-y-0 right-[9px] z-10 mb-[9px] flex w-[300px] max-w-[calc(100%-18px)] flex-col rounded-2xl border border-white/10 bg-[#1b1b1b] text-[#f2f2f2] shadow-2xl">
            <div className="flex items-center justify-between pt-[13px] pr-[9px] pb-[7px] pl-4">
              <h3 className="text-[13.500px] font-bold">{panel.title}</h3>
              <button aria-label="Close panel" onClick={onPanelClose} className={iconButton}>
                <Icon name="x" className="size-4" />
              </button>
            </div>
            <div className="min-h-0 grow overflow-y-auto px-[9px] pb-[9px]">{panel.body}</div>
          </aside>
        )}
      </div>
      {footer && <div className="bg-[#1e1e1e] text-[#f2f2f2]">{footer}</div>}
      <p className="flex justify-between gap-4 px-6 pt-1 pb-3 text-[12px] opacity-60">
        <span className="truncate">{status ?? book.author}</span>
        <span>{Math.round((book.progress ?? 0) * 100)}%</span>
      </p>
    </div>
  );
}

function ToolButton({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: IconName;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button aria-label={label} aria-pressed={pressed} onClick={onClick} className={iconButton}>
      <Icon name={icon} className="size-5" fill={pressed && icon === "bookmark" ? "currentColor" : "none"} />
    </button>
  );
}

/** Font size and theme menu, for the formats the app lays out itself. */
function Appearance({ prefs, onPrefs }: Pick<Props, "prefs" | "onPrefs">) {
  return (
    <Popover
      label="Text size and theme"
      button={<Icon name="text" className="size-5" />}
      buttonClass={iconButton}
      panelClass="top-8 right-0 w-[170px]"
    >
      <MenuItem
        label={`Larger text (${prefs.fontSize}%)`}
        checked={false}
        onClick={() => onPrefs({ fontSize: Math.min(200, prefs.fontSize + 10) })}
      />
      <MenuItem
        label="Smaller text"
        checked={false}
        onClick={() => onPrefs({ fontSize: Math.max(70, prefs.fontSize - 10) })}
      />
      {MENU_RULE}
      {(["dark", "sepia", "light"] as const).map((theme) => (
        <MenuItem
          key={theme}
          label={theme[0].toUpperCase() + theme.slice(1)}
          checked={prefs.theme === theme}
          onClick={() => onPrefs({ theme })}
        />
      ))}
    </Popover>
  );
}

const rowClass =
  "mb-[2px] block w-full rounded-lg px-[10px] py-[7px] text-left text-[13.500px] font-medium hover:bg-white/5";
const emptyClass = "px-2 py-3 text-[13px] text-[#8c8c8c]";

/** A list with a delete button per row, used for bookmarks and highlights. */
function Saved<T extends { added: number }>({
  items,
  empty,
  render,
  onOpen,
  onDelete,
}: {
  items: T[];
  empty: string;
  render: (item: T) => ReactNode;
  onOpen: (item: T) => void;
  onDelete: (item: T) => void;
}) {
  if (!items.length) return <p className={emptyClass}>{empty}</p>;
  return items.map((item) => (
    <div key={item.added} className="flex items-start gap-1">
      <button onClick={() => onOpen(item)} className={`${rowClass} min-w-0`}>
        {render(item)}
      </button>
      <button aria-label="Delete" onClick={() => onDelete(item)} className={`${iconButton} mt-1 text-[#a0a0a0]`}>
        <Icon name="trash" className="size-4" />
      </button>
    </div>
  ));
}

type Found = { cfi: string; excerpt: string };

function EpubView({ book, prefs, onPrefs, onPatch, onClose }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const epub = useRef<EpubBook | null>(null);
  const rendition = useRef<Rendition | null>(null);
  const selectedIn = useRef<Contents | null>(null);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [at, setAt] = useState<{ cfi: string; href: string } | null>(null);
  const [panel, setPanel] = useState<"Contents" | "Bookmarks" | "Highlights" | "Search" | null>(null);
  const [selection, setSelection] = useState<{ cfi: string; text: string } | null>(null);
  const [found, setFound] = useState<Found[] | "searching" | null>(null);
  const [broken, setBroken] = useState(false);
  const bookmarks = book.bookmarks ?? [];
  const highlights = book.highlights ?? [];

  const draw = (h: Highlight) =>
    rendition.current?.annotations.highlight(h.cfi, {}, undefined, "hl", {
      fill: "#f5c518",
      "fill-opacity": "0.35",
      "mix-blend-mode": "normal",
    });

  useEffect(() => {
    let cancelled = false;
    const turn = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") rendition.current?.prev();
      if (e.key === "ArrowRight") rendition.current?.next();
    };
    // Loaded on demand: epub.js touches `window` when imported.
    import("epubjs")
      .then(({ default: ePub }) => {
        if (cancelled) return;
        // The URL has no .epub extension to sniff, so say what it is.
        const opened = ePub(src(book), { openAs: "epub" });
        epub.current = opened;
        // One column, like a page; wide windows get margins instead of a second column.
        const r = opened.renderTo(stage.current!, { width: "100%", height: "100%", spread: "none" });
        rendition.current = r;
        for (const [name, { bg, fg }] of Object.entries(THEMES))
          r.themes.register(name, {
            body: {
              color: `${fg} !important`,
              background: `${bg} !important`,
              "font-family": "Bookerly, Georgia, 'Times New Roman', serif !important",
              "line-height": "1.6 !important",
            },
            a: { color: "#1c9be6 !important" },
          });
        r.themes.select(prefs.theme);
        r.themes.fontSize(`${prefs.fontSize}%`);
        r.on("keyup", turn); // key presses while focus is inside the book
        r.on("selected", (cfi: string, contents: Contents) => {
          selectedIn.current = contents;
          setSelection({ cfi, text: r.getRange(cfi).toString().trim().slice(0, 500) });
        });
        r.on("relocated", (where: Location) => {
          // Chapter position plus the page within it: close enough without indexing the whole book.
          const { index, cfi, href, displayed } = where.start;
          setAt({ cfi, href });
          onPatch({
            cfi,
            progress: where.atEnd
              ? 1
              : Math.min(1, (index + displayed.page / displayed.total) / (opened.spine.last().index + 1)),
          });
        });
        opened.loaded.navigation.then((nav) => cancelled || setToc(nav.toc));
        highlights.forEach(draw);
        return r.display(book.cfi);
      })
      .catch(() => setBroken(true));
    window.addEventListener("keydown", turn);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", turn);
      rendition.current = null;
      epub.current?.destroy();
      epub.current = null;
    };
    // Opens once per book: later prefs/progress updates must not restart the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    rendition.current?.themes.select(prefs.theme);
    rendition.current?.themes.fontSize(`${prefs.fontSize}%`);
  }, [prefs.theme, prefs.fontSize]);

  const flat = (items: NavItem[], depth = 0): { item: NavItem; depth: number }[] =>
    items.flatMap((item) => [{ item, depth }, ...flat(item.subitems ?? [], depth + 1)]);
  const chapters = flat(toc);
  const chapterName =
    chapters.find(({ item }) => at && item.href.split("#")[0].endsWith(at.href))?.item.label.trim() ??
    "Bookmark";
  const marked = bookmarks.find((b) => b.at === at?.cfi);
  const go = (cfi: string) => {
    rendition.current?.display(cfi);
    if (window.innerWidth < 768) setPanel(null);
  };

  const search = async (query: string) => {
    const opened = epub.current;
    if (!opened || !query) return setFound(null);
    setFound("searching");
    const sections: Section[] = [];
    opened.spine.each((section: Section) => sections.push(section));
    const results: Found[] = [];
    for (const section of sections) {
      if (results.length >= 100) break; // enough to be useful; refine the query for more
      try {
        await section.load(opened.load.bind(opened));
        for (const hit of section.find(query))
          if ("cfi" in hit && "excerpt" in hit)
            results.push({ cfi: String(hit.cfi), excerpt: String(hit.excerpt) });
        section.unload();
      } catch {
        // a chapter that fails to load just has no matches
      }
    }
    setFound(results);
  };

  const closeSelection = () => {
    selectedIn.current?.window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const panels = {
    Contents: chapters.length ? (
      chapters.map(({ item, depth }) => (
        <button
          key={item.id + item.href}
          onClick={() => go(item.href)}
          className={rowClass}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {item.label.trim()}
        </button>
      ))
    ) : (
      <p className={emptyClass}>This book has no table of contents.</p>
    ),
    Bookmarks: (
      <Saved
        items={bookmarks}
        empty="No bookmarks yet. Use the bookmark button to mark this page."
        render={(b) => b.label}
        onOpen={(b) => go(b.at)}
        onDelete={(b) => onPatch({ bookmarks: bookmarks.filter((x) => x !== b) })}
      />
    ),
    Highlights: (
      <Saved
        items={highlights}
        empty="No highlights yet. Select some text to highlight it or add a note."
        render={(h) => (
          <>
            <span className="line-clamp-3 border-l-2 border-[#f5c518] pl-2">{h.text}</span>
            {h.note && <span className="mt-1 block text-[#a0a0a0]">{h.note}</span>}
          </>
        )}
        onOpen={(h) => go(h.cfi)}
        onDelete={(h) => {
          rendition.current?.annotations.remove(h.cfi, "highlight");
          onPatch({ highlights: highlights.filter((x) => x !== h) });
        }}
      />
    ),
    Search: (
      <>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search(String(new FormData(e.currentTarget).get("q") ?? "").trim());
          }}
        >
          <input
            name="q"
            type="search"
            autoFocus
            aria-label="Search in this book"
            placeholder="Search in this book"
            className={`${fieldClass} mb-2`}
          />
        </form>
        {found === "searching" ? (
          <p className={emptyClass}>Searching…</p>
        ) : found?.length === 0 ? (
          <p className={emptyClass}>No matches.</p>
        ) : (
          found?.map((hit) => (
            <button key={hit.cfi} onClick={() => go(hit.cfi)} className={rowClass}>
              {hit.excerpt.trim()}
            </button>
          ))
        )}
      </>
    ),
  };
  const tools: [NonNullable<typeof panel>, IconName][] = [
    ["Contents", "list"],
    ["Search", "search"],
    ["Highlights", "highlight"],
    ["Bookmarks", "lines"],
  ];

  return (
    <Shell
      book={book}
      onClose={onClose}
      panel={panel && { title: panel, body: panels[panel] }}
      onPanelClose={() => setPanel(null)}
      tone={THEMES[prefs.theme]}
      // "Bookmark" is only the fallback label for bookmarks made outside any chapter.
      status={chapterName === "Bookmark" ? undefined : chapterName}
      onTurn={(by) => (by < 0 ? rendition.current?.prev() : rendition.current?.next())}
      controls={
        <>
          {tools.map(([name, icon]) => (
            <ToolButton
              key={name}
              label={name}
              icon={icon}
              pressed={panel === name}
              onClick={() => setPanel(panel === name ? null : name)}
            />
          ))}
          <ToolButton
            label={marked ? "Remove bookmark" : "Bookmark this page"}
            icon="bookmark"
            pressed={!!marked}
            onClick={() =>
              at &&
              onPatch({
                bookmarks: marked
                  ? bookmarks.filter((b) => b !== marked)
                  : [
                      ...bookmarks,
                      {
                        at: at.cfi,
                        label: `${chapterName} · ${Math.round((book.progress ?? 0) * 100)}%`,
                        added: Date.now(),
                      },
                    ],
              })
            }
          />
          <Appearance prefs={prefs} onPrefs={onPrefs} />
        </>
      }
      footer={
        selection && (
          <form
            className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
              const highlight = { ...selection, note: note || undefined, added: Date.now() };
              draw(highlight);
              onPatch({ highlights: [...highlights, highlight] });
              closeSelection();
            }}
          >
            <span className="w-[200px] max-w-full truncate text-[12px] text-[#a0a0a0]">
              “{selection.text}”
            </span>
            <input
              name="note"
              aria-label="Note"
              placeholder="Add a note (optional)"
              className={`${fieldClass} !h-[30px] min-w-[120px] grow basis-0`}
            />
            <button className={controlClass}>Highlight</button>
            <button type="button" onClick={closeSelection} className={controlClass}>
              Cancel
            </button>
          </form>
        )
      }
    >
      {broken ? (
        failed
      ) : (
        <div ref={stage} className="mx-auto h-full w-full max-w-[720px] px-4" />
      )}
    </Shell>
  );
}

/** One page at a time: PDF pages drawn by pdf.js, or the images of a comic archive. */
function PagedView({ book, onPatch, onClose }: Props) {
  const isPdf = extOf(book.file!) === "pdf";
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [images, setImages] = useState<string[]>([]); // object URLs, in page order
  const [page, setPage] = useState(book.page ?? 1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [listing, setListing] = useState(false);
  const [broken, setBroken] = useState(false);
  const count = doc?.numPages ?? images.length;
  const bookmarks = book.bookmarks ?? [];
  const marked = bookmarks.find((b) => b.at === `page:${page}`);

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | undefined;
    const urls: string[] = [];
    const load = async () => {
      if (isPdf) {
        opened = await (await pdfjs()).getDocument({ url: src(book) }).promise;
        if (cancelled) return opened.loadingTask.destroy();
        return setDoc(opened);
      }
      // Loaded on demand, only when a comic is opened.
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(await (await fetch(src(book))).arrayBuffer());
      const pages = Object.values(zip.files)
        .filter((f) => !f.dir && /\.(jpe?g|png|webp|gif)$/i.test(f.name))
        // A comic EPUB keeps a separate copy of its first page as the cover.
        .filter((f) => extOf(book.file!) !== "epub" || !/(^|\/)cover\.\w+$/i.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      // ponytail: every page is inflated up front; decode on demand if huge comics stall the tab
      for (const entry of pages) urls.push(URL.createObjectURL(await entry.async("blob")));
      if (!cancelled) setImages(urls);
    };
    load().catch(() => setBroken(true));
    return () => {
      cancelled = true;
      opened?.loadingTask.destroy();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
    // Opens once per book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !size.w) return;
    let task: RenderTask | undefined;
    let cancelled = false;
    doc.getPage(Math.min(page, doc.numPages)).then((p) => {
      if (cancelled || !canvas.current) return;
      const natural = p.getViewport({ scale: 1 });
      const fit = Math.min(size.w / natural.width, size.h / natural.height);
      // Draw at device resolution so text stays sharp, then show it at the fitted size.
      const viewport = p.getViewport({ scale: fit * window.devicePixelRatio });
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      canvas.current.style.width = `${natural.width * fit}px`;
      canvas.current.style.height = `${natural.height * fit}px`;
      task = p.render({ canvas: canvas.current, viewport });
      task.promise.catch(() => {}); // cancelled by the next page turn or resize
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, size]);

  const go = (to: number) => {
    const next = Math.min(Math.max(1, Math.round(to) || 1), count || 1);
    if (next === page) return;
    setPage(next);
    onPatch({ page: next, progress: count ? next / count : 0 });
  };
  // Comics open as one long strip to scroll, like the manga sites; paged turning is a choice per book.
  const mode: PageMode = isPdf ? "ltr" : (book.mode ?? "scroll");
  const step = mode === "rtl" ? -1 : 1; // which way the right-hand arrow goes
  const strip = useRef<HTMLDivElement>(null);
  const show = (n: number) => strip.current?.children[n - 1]?.scrollIntoView();
  /** Goes to a page chosen by number or bookmark, which in the strip also means scrolling to it. */
  const jump = (to: number) => {
    go(to);
    show(Math.min(Math.max(1, Math.round(to) || 1), count || 1));
  };
  useEffect(() => {
    const el = strip.current;
    if (mode !== "scroll" || !el) return;
    // Page heights are only known once the images have decoded; scrolling earlier lands on the wrong one.
    Promise.all([...el.querySelectorAll("img")].map((img) => img.decode().catch(() => {}))).then(() =>
      show(page),
    );
    // Runs when the strip appears, not on every page change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, images.length]);
  useEffect(() => {
    const turn = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || mode === "scroll") return;
      if (e.key === "ArrowLeft") go(page - step);
      if (e.key === "ArrowRight") go(page + step);
    };
    window.addEventListener("keydown", turn);
    return () => window.removeEventListener("keydown", turn);
  });

  return (
    <Shell
      book={book}
      onClose={onClose}
      tone={{ bg: "#111", fg: "#e6e6e6" }}
      status={count ? `Page ${page} of ${count}` : undefined}
      onTurn={mode === "scroll" ? undefined : (by) => go(page + by * step)}
      onPanelClose={() => setListing(false)}
      panel={
        listing
          ? {
              title: "Bookmarks",
              body: (
                <Saved
                  items={bookmarks}
                  empty="No bookmarks yet. Use the bookmark button to mark this page."
                  render={(b) => b.label}
                  onOpen={(b) => jump(Number(b.at.split(":")[1]))}
                  onDelete={(b) => onPatch({ bookmarks: bookmarks.filter((x) => x !== b) })}
                />
              ),
            }
          : null
      }
      controls={
        <>
          <ToolButton label="Bookmarks" icon="lines" pressed={listing} onClick={() => setListing(!listing)} />
          <ToolButton
            label={marked ? "Remove bookmark" : "Bookmark this page"}
            icon="bookmark"
            pressed={!!marked}
            onClick={() =>
              onPatch({
                bookmarks: marked
                  ? bookmarks.filter((b) => b !== marked)
                  : [...bookmarks, { at: `page:${page}`, label: `Page ${page}`, added: Date.now() }],
              })
            }
          />
          <input
            key={page}
            aria-label="Page"
            type="number"
            min={1}
            max={count}
            defaultValue={page}
            onBlur={(e) => jump(Number(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className={`${controlClass} w-[58px] text-center`}
          />
          <span className="text-[12px] text-[#a0a0a0]">of {count}</span>
          {!isPdf && (
            <select
              aria-label="Page turning"
              value={mode}
              onChange={(e) => onPatch({ mode: e.target.value as PageMode })}
              className={controlClass}
            >
              <option value="ltr">Left to Right</option>
              <option value="rtl">Right to Left (Manga)</option>
              <option value="scroll">Scroll (Webtoon)</option>
            </select>
          )}
          {mode !== "scroll" && (
            <>
              <ToolButton
                label={step > 0 ? "Previous page" : "Next page"}
                icon="chevronLeft"
                onClick={() => go(page - step)}
              />
              <ToolButton
                label={step > 0 ? "Next page" : "Previous page"}
                icon="chevronRight"
                onClick={() => go(page + step)}
              />
            </>
          )}
        </>
      }
    >
      {broken ? (
        failed
      ) : mode === "scroll" ? (
        <div
          ref={strip}
          onScroll={(e) => {
            // The current page is the one crossing the middle of the window.
            const el = e.currentTarget;
            const middle = el.scrollTop + el.clientHeight / 2;
            const at = [...el.children].findIndex(
              (c) => (c as HTMLElement).offsetTop + (c as HTMLElement).offsetHeight > middle,
            );
            if (at >= 0) go(at + 1);
          }}
          className="relative min-h-0 grow overflow-y-auto bg-[#111]"
        >
          {images.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the archive
            <img key={url} src={url} alt={`Page ${i + 1}`} className="mx-auto block w-full max-w-[800px]" />
          ))}
        </div>
      ) : (
        <div ref={area} className="flex min-h-0 grow items-center justify-center overflow-hidden bg-[#111]">
          {isPdf ? (
            <canvas ref={canvas} />
          ) : (
            images[page - 1] && (
              // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the archive
              <img src={images[page - 1]} alt={`Page ${page}`} className="max-h-full max-w-full object-contain" />
            )
          )}
        </div>
      )}
    </Shell>
  );
}

/** A scrolling column of text for plain text files. */
function TextView({ book, prefs, onPrefs, onPatch, onClose }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [blocks, setBlocks] = useState<string[] | null>(null);
  const [broken, setBroken] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(src(book))
      .then((res) => (res.ok ? res.text() : Promise.reject()))
      .then((text) => {
        if (cancelled) return;
        setBlocks(text.split(/\n\s*\n/).map((t) => t.trim()));
      })
      .catch(() => setBroken(true));
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // Return to where the reader left off, once the text is on screen.
  useEffect(() => {
    const el = scroller.current;
    if (el && blocks) el.scrollTop = (book.progress ?? 0) * (el.scrollHeight - el.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  const { bg, fg } = THEMES[prefs.theme];
  return (
    <Shell
      book={book}
      onClose={onClose}
      tone={THEMES[prefs.theme]}
      controls={<Appearance prefs={prefs} onPrefs={onPrefs} />}
    >
      {broken ? (
        failed
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            clearTimeout(timer.current);
            // Saved once scrolling pauses, not on every frame.
            timer.current = setTimeout(() => {
              const max = el.scrollHeight - el.clientHeight;
              onPatch({ progress: max > 0 ? Math.min(1, el.scrollTop / max) : 1 });
            }, 400);
          }}
          className="min-h-0 grow overflow-y-auto px-5 py-8"
          style={{ background: bg, color: fg, fontSize: `${prefs.fontSize}%` }}
        >
          <div className="mx-auto max-w-[680px] font-serif leading-[1.6]">
            {blocks?.map((text, i) => (
              <p key={i} className="mb-[0.9em] whitespace-pre-wrap">
                {text}
              </p>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

export function Reader(props: Props) {
  const ext = extOf(props.book.file!);
  // A comic is shown as its page images whatever the file is (CBZ, or an EPUB of images).
  if (ext === "pdf" || ext === "cbz" || props.book.kind === "comic") return <PagedView {...props} />;
  if (ext === "epub") return <EpubView {...props} />;
  return <TextView {...props} />;
}
