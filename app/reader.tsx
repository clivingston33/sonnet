"use client";

/** In-app reader: EPUB (epub.js), PDF (pdf.js), comic archives and plain text. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Book as EpubBook, Contents, Location, NavItem, Rendition } from "epubjs";
import type Section from "epubjs/types/section";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Book, Highlight, PageMode, ReaderPrefs } from "./sync";
import { FONTS, fontOf } from "./fonts";
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
  dusk: { bg: "#cfd2ce", fg: "#2a2c2a" },
  sepia: { bg: "#f4ecd8", fg: "#3b2f1e" },
  light: { bg: "#ffffff", fg: "#1a1a1a" },
};
const THEME_NAMES = Object.keys(THEMES) as ReaderPrefs["theme"][];
const HIGHLIGHTS: Record<string, string> = {
  yellow: "#f5c518",
  green: "#4cc38a",
  blue: "#4aa8ff",
  pink: "#ff6fa5",
};
const tint = (h: Highlight) => HIGHLIGHTS[h.color ?? ""] ?? HIGHLIGHTS.yellow;
/** Paper grain: a tile of grey noise, laid over the page. */
const GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>",
)}")`;

/** The app's own @font-face rules, for a book's frame: that is a document of its own and has none. */
function faces() {
  let css = "";
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules)
        if (rule instanceof CSSFontFaceRule)
          // The frame's addresses are the book's, so the font files are named in full.
          css += rule.cssText.replace(
            /url\("?([^")]+)"?\)/g,
            (_, url) => `url("${new URL(url, sheet.href ?? location.href)}")`,
          );
    } catch {
      // a stylesheet from another site can't be read
    }
  }
  return css;
}
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

/**
 * Fetches the reader's own code (EPUB, comic and PDF engines) so the service worker has it
 * when a downloaded book is opened without a connection.
 */
export const warmReader = () =>
  Promise.allSettled([
    import("epubjs"),
    import("jszip"),
    pdfjs().then((lib) => fetch(lib.GlobalWorkerOptions.workerSrc)),
  ]);

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

type Touched = { changedTouches: ArrayLike<{ clientX: number; clientY: number }> };
/**
 * Touch handlers that call `turn` for a sideways swipe: 1 when the finger moves left (what is
 * on the right comes in), -1 when it moves right. Up-and-down movement is left to scrolling.
 */
function swipe(turn: (by: -1 | 1) => void) {
  let x = 0;
  let y = 0;
  let live = false; // a touch is down and has not turned the page yet
  const check = (e: Touched) => {
    if (!live) return;
    const dx = e.changedTouches[0].clientX - x;
    const dy = e.changedTouches[0].clientY - y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    live = false;
    turn(dx < 0 ? 1 : -1);
  };
  return {
    start: (e: Touched) => {
      x = e.changedTouches[0].clientX;
      y = e.changedTouches[0].clientY;
      live = true;
    },
    // Checked while the finger moves as well as when it lifts: some phones take the gesture over
    // part-way and never report the lift.
    move: check,
    end: (e: Touched) => {
      check(e);
      live = false;
    },
  };
}

/**
 * Applies the page colours and text size to an open EPUB. Set directly on the page, because
 * epub.js's named themes do not come back once another has been selected after them.
 */
function paint(r: Rendition, prefs: Props["prefs"]) {
  const { bg, fg } = THEMES[prefs.theme];
  r.themes.override("color", fg, true);
  r.themes.override("background", bg, true);
  r.themes.override("font-family", fontOf(prefs.font), true);
  r.themes.fontSize(`${prefs.fontSize}%`);
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
  wideEdges,
  prefs,
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
  wideEdges?: boolean; // each side's 45% of the page turns it
  prefs?: ReaderPrefs; // for the lighting
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
  // One swipe tracker for the life of the reader; it always calls the latest `onTurn`.
  const turnRef = useRef(onTurn);
  useEffect(() => {
    turnRef.current = onTurn;
  });
  const [swiped] = useState(() => swipe((by) => turnRef.current?.(by)));
  const light = prefs?.light ?? 100;
  const contrast = prefs?.contrast ?? 100;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Reading ${book.title}`}
      className="fixed inset-0 z-[45] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      style={{
        background: tone.bg,
        color: tone.fg,
        filter:
          light !== 100 || contrast !== 100 ? `brightness(${light}%) contrast(${contrast}%)` : undefined,
      }}
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
          <span className="max-md:hidden">Library</span>
        </button>
        {/* Phones have no room for the title beside the controls; the space still pushes them right. */}
        <h2 className="grow basis-0 truncate text-center text-[13px] opacity-70 max-md:invisible md:min-w-[80px]">
          {book.title}
        </h2>
        {controls}
      </header>
      <div
        className="relative flex min-h-0 grow"
        onTouchStart={swiped.start}
        onTouchMove={swiped.move}
        onTouchEnd={swiped.end}
      >
        <div className="relative flex min-w-0 grow flex-col">{children}</div>
        {onTurn &&
          ([-1, 1] as const).map((by) => (
            <button
              key={by}
              aria-label={by < 0 ? "Page to the left" : "Page to the right"}
              onClick={() => onTurn(by)}
              // As wide as the margin beside the 720px page, and never too narrow to tap.
              className={`group absolute inset-y-0 flex items-center ${wideEdges ? "w-[45%]" : "w-[max(44px,calc((100%-760px)/2))]"} ${by < 0 ? "left-0 justify-start pl-3" : "right-0 justify-end pr-3"}`}
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
      {/* Lighting, over everything and out of the pointer's way: a warm cast and paper grain. */}
      {!!prefs?.warmth && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-30 bg-[#ff8a1f] mix-blend-multiply"
          style={{ opacity: prefs.warmth * 0.004 }}
        />
      )}
      {!!prefs?.grain && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-30"
          style={{ backgroundImage: GRAIN, opacity: prefs.grain * 0.004 }}
        />
      )}
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

/** Grey shapes where the page will be, shown while a book is fetched and opened. */
function Loading({ lines = false }: { lines?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="pointer-events-none absolute inset-0 z-[1] flex animate-pulse items-center justify-center p-6"
    >
      {lines ? (
        <div className="w-full max-w-[640px] space-y-4">
          {[100, 96, 88, 100, 92, 60, 100, 94, 85, 100, 90, 45].map((width, i) => (
            <div key={i} className="h-4 rounded bg-current opacity-10" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : (
        <div className="aspect-[2/3] max-h-[85%] w-[min(80%,420px)] rounded-lg bg-current opacity-10" />
      )}
    </div>
  );
}

/** The toolbar's page-turning choice: a small button that opens the list of ways to read. */
function ModeMenu({
  mode,
  options,
  onPick,
  children,
}: {
  mode: PageMode;
  options: [PageMode, string][];
  onPick: (mode: PageMode) => void;
  children?: ReactNode;
}) {
  return (
    <Popover
      label="Page turning"
      button={<Icon name="panels" className="size-5" />}
      buttonClass={iconButton}
      panelClass="top-8 right-0 w-[210px] max-md:w-[270px]"
    >
      {options.map(([value, label]) => (
        <MenuItem key={value} label={label} checked={mode === value} onClick={() => onPick(value)} />
      ))}
      {children}
    </Popover>
  );
}

const groupLabel = "px-[6px] pt-3 pb-1 text-[11px] font-bold text-[#8c8c8c]";
const segment =
  "h-[30px] grow basis-0 rounded-lg text-[13px] font-bold hover:bg-white/10 aria-pressed:bg-white/20 max-md:h-[38px]";
/** The lighting sliders: preference, label, range, and where each rests. */
const LIGHTING = [
  ["light", "Light", 30, 100, 100],
  ["warmth", "Warmth", 0, 100, 0],
  ["grain", "Grain", 0, 100, 0],
  ["contrast", "Contrast", 60, 140, 100],
] as const;

/** Lighting for every format; with `text` (the formats the app lays out itself) also size, colours, font and how much text a page holds. */
function Appearance({ prefs, onPrefs, text = true }: Pick<Props, "prefs" | "onPrefs"> & { text?: boolean }) {
  const fill = prefs.fill ?? 100;
  return (
    <Popover
      label="Appearance"
      button={<Icon name="text" className="size-5" />}
      buttonClass={iconButton}
      panelClass="w-[260px] max-md:w-[300px]"
    >
      {/* A menu closes when something in it is clicked; these are adjusted, so the click stops here. */}
      <div onClick={(e) => e.stopPropagation()} className="p-[6px]">
        {text && (
          <>
            <div className="flex gap-1">
              <button
                aria-label="Smaller text"
                className={segment}
                onClick={() => onPrefs({ fontSize: Math.max(70, prefs.fontSize - 10) })}
              >
                A−
              </button>
              <span className="flex grow basis-0 items-center justify-center text-[13px]">{prefs.fontSize}%</span>
              <button
                aria-label="Larger text"
                className={`${segment} !text-[17px]`}
                onClick={() => onPrefs({ fontSize: Math.min(200, prefs.fontSize + 10) })}
              >
                A+
              </button>
            </div>
            <div className="mt-3 flex justify-between px-3">
              {THEME_NAMES.map((theme) => (
                <button
                  key={theme}
                  aria-label={`${theme[0].toUpperCase() + theme.slice(1)} page`}
                  aria-pressed={prefs.theme === theme}
                  onClick={() => onPrefs({ theme })}
                  className="size-9 rounded-full border border-white/25 font-serif text-[15px] outline-offset-2 outline-white aria-pressed:outline-2"
                  style={{ background: THEMES[theme].bg, color: THEMES[theme].fg }}
                >
                  Aa
                </button>
              ))}
            </div>
            <select
              aria-label="Font"
              value={prefs.font && prefs.font in FONTS ? prefs.font : "georgia"}
              onChange={(e) => onPrefs({ font: e.target.value })}
              className={`${controlClass} mt-3 w-full`}
            >
              {Object.entries(FONTS).map(([key, font]) => (
                <option key={key} value={key}>
                  {font.label}
                </option>
              ))}
            </select>
            <p className={groupLabel}>Text on Screen</p>
            <div className="flex gap-1">
              {[100, 80, 60, 40].map((n) => (
                <button key={n} aria-pressed={fill === n} className={segment} onClick={() => onPrefs({ fill: n })}>
                  {n === 100 ? "Full" : `${n}%`}
                </button>
              ))}
            </div>
          </>
        )}
        <p className={groupLabel}>Lighting</p>
        {LIGHTING.map(([key, label, min, max, rest]) => (
          <label key={key} className="flex items-center gap-3 px-[6px] py-[5px] text-[13px]">
            <span className="w-[62px] shrink-0">{label}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={5}
              value={prefs[key] ?? rest}
              onChange={(e) => onPrefs({ [key]: Number(e.target.value) })}
              className="min-w-0 grow"
            />
          </label>
        ))}
        {LIGHTING.some(([key, , , , rest]) => (prefs[key] ?? rest) !== rest) && (
          <button
            className={`${segment} mt-1 w-full`}
            onClick={() => onPrefs({ light: 100, warmth: 0, grain: 0, contrast: 100 })}
          >
            Reset Lighting
          </button>
        )}
      </div>
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
  // The toolbar beside selected text or a tapped highlight, with where on the screen that is.
  const [pop, setPop] = useState<{ cfi: string; text: string; x: number; top: number; bottom: number } | null>(null);
  const [noting, setNoting] = useState<string | null>(null); // cfi of the highlight whose note is being written
  const tapped = useRef(false); // the last click landed on a highlight
  const [found, setFound] = useState<Found[] | "searching" | null>(null);
  const [broken, setBroken] = useState(false);
  const [ready, setReady] = useState(false); // the first page is on screen
  const [pages, setPages] = useState(0); // how many screens the book is cut into, once counted
  const bookmarks = book.bookmarks ?? [];
  const highlights = book.highlights ?? [];

  // What the book's own event handlers, set up once, need to see as it is now.
  const live = useRef({ highlights, pop });
  useEffect(() => {
    live.current = { highlights, pop };
  });

  const draw = (h: Highlight) =>
    rendition.current?.annotations.highlight(
      h.cfi,
      {},
      (e: Event) => {
        // epub.js also calls this as a finger lands, which may be the start of a swipe: the click that follows a tap is enough.
        if (e.type !== "click") return;
        tapped.current = true;
        const box = (e.target as Element).getBoundingClientRect();
        setPop({ cfi: h.cfi, text: h.text, x: box.left + box.width / 2, top: box.top, bottom: box.bottom });
      },
      "hl",
      { fill: tint(h), "fill-opacity": "0.35", "mix-blend-mode": "normal" },
    );

  // Which way the pages run. Right goes forward unless the book is set to read right to left.
  const rtl = book.mode === "rtl";
  const rtlRef = useRef(rtl);
  useEffect(() => {
    rtlRef.current = rtl;
  });
  /** `by` is a side of the page (1 = right): a tap, click, swipe or arrow key towards it. */
  const turnBy = (by: -1 | 1) => {
    const r = rendition.current;
    if (!r) return;
    if (by * (rtlRef.current ? -1 : 1) > 0) r.next();
    else r.prev();
  };

  useEffect(() => {
    let cancelled = false;
    const turn = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") turnBy(-1);
      if (e.key === "ArrowRight") turnBy(1);
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
        r.themes.default({
          body: { "line-height": "1.6 !important" },
          // The chosen typeface (set on the body by `paint`) also reaches text the book styles itself.
          "p, div, span, li, blockquote, a, em, strong, i, b, h1, h2, h3, h4, h5, h6, td": {
            "font-family": "inherit !important",
          },
          a: { color: "#1c9be6 !important" },
          // Pictures (and whole pages of them, in comics saved as books) are shrunk to fit, never cropped.
          "img, svg": {
            "max-width": "100% !important",
            "max-height": "96vh !important",
            height: "auto !important",
            "object-fit": "contain",
          },
        });
        paint(r, prefs);
        // (epub.js types getContents as one Contents; it is a list, one per visible section.)
        const selecting = () =>
          (r.getContents() as unknown as Contents[]).some((c) => String(c.window.getSelection() ?? "").length > 0);
        r.on("keyup", turn); // key presses while focus is inside the book
        // A click or tap on the left or right 45% of the page turns it.
        let pending: ReturnType<typeof setTimeout>;
        let held = false; // the press began with text selected or the toolbar up: it only puts those away
        const clicked = (e: MouseEvent) => {
          clearTimeout(pending);
          if (e.detail > 1 || (e.target as Element).closest?.("a")) return;
          const box = stage.current?.firstElementChild?.getBoundingClientRect();
          if (!box?.width) return;
          // The frame holds the chapter's pages side by side; this is the place within the one shown.
          const frame = e.view?.frameElement?.getBoundingClientRect().left ?? box.left;
          const at = ((((frame - box.left + e.clientX) % box.width) + box.width) % box.width) / box.width;
          // Wait a moment: a double-click selects a word and must not turn the page.
          pending = setTimeout(() => {
            if (tapped.current) return void (tapped.current = false);
            if (held) return setPop(null);
            if (selecting()) return;
            if (at < 0.45) turnBy(-1);
            else if (at > 0.55) turnBy(1);
          }, 250);
        };
        r.hooks.content.register((contents: Contents) => {
          // Some books hide headings by parking them far off the page (`left: -999em`), and each
          // chapter is as many pages as its content is wide: that made dozens of blank pages.
          // Such rules are hidden in place instead, still there for screen readers.
          // ponytail: top-level rules only; walk @media blocks too if a book hides them there.
          for (const sheet of contents.document.styleSheets) {
            let rules: CSSRule[] = [];
            try {
              rules = [...sheet.cssRules];
            } catch {
              // a stylesheet from another site can't be read; its rules are left alone
            }
            for (const rule of rules) {
              const style = (rule as CSSStyleRule).style;
              if (style?.position !== "absolute" || !(parseFloat(style.left) <= -100)) continue;
              style.cssText += "left:auto;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)";
            }
          }
          contents.document.addEventListener("click", clicked);
          contents.document.addEventListener("pointerdown", () => {
            held = selecting() || !!live.current.pop;
          });
          // The frame keeps touches to itself, so sideways swipes are watched for inside it.
          // Not while text is selected: there a moving finger is stretching the selection.
          const swiped = swipe((by) => selecting() || turnBy(by));
          contents.document.addEventListener("touchstart", swiped.start, { passive: true });
          contents.document.addEventListener("touchmove", swiped.move, { passive: true });
          contents.document.addEventListener("touchend", swiped.end, { passive: true });
          // The selection was dropped (a tap elsewhere): its toolbar goes; a tapped highlight's stays.
          contents.document.addEventListener("selectionchange", () => {
            if (String(contents.window.getSelection() ?? "")) return;
            setPop((p) => (p && !live.current.highlights.some((h) => h.cfi === p.cfi) ? null : p));
          });
          const fonts = contents.document.createElement("style");
          fonts.textContent = faces();
          contents.document.head.append(fonts);
        });
        r.on("selected", (cfi: string, contents: Contents) => {
          const chosen = contents.window.getSelection();
          const text = String(chosen ?? "").trim();
          if (!chosen?.rangeCount || !text) return;
          selectedIn.current = contents;
          // Where the selection is in the window: its place in the frame, plus the frame's own.
          const box = chosen.getRangeAt(0).getBoundingClientRect();
          const frame = contents.window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
          setPop({
            cfi,
            text: text.slice(0, 500),
            x: frame.left + box.left + box.width / 2,
            top: frame.top + box.top,
            bottom: frame.top + box.bottom,
          });
        });
        r.on("relocated", (where: Location) => {
          // Chapter position plus the page within it: close enough without indexing the whole book.
          const { index, cfi, href, displayed } = where.start;
          setAt({ cfi, href });
          setPop(null);
          onPatch({
            cfi,
            progress: where.atEnd
              ? 1
              : Math.min(1, (index + displayed.page / displayed.total) / (opened.spine.last().index + 1)),
          });
        });
        opened.loaded.navigation.then((nav) => cancelled || setToc(nav.toc));
        highlights.forEach(draw);
        // Page numbers need the whole book measured once; the result is kept in this browser.
        const saved = `pages:${book.id}`;
        opened.ready
          .then(() => {
            const kept = localStorage.getItem(saved);
            if (kept) return void opened.locations.load(kept);
            return opened.locations.generate(1200).then(() => {
              try {
                localStorage.setItem(saved, opened.locations.save());
              } catch {
                // storage full: it is simply measured again next time
              }
            });
          })
          .then(() => cancelled || setPages(opened.locations.length()))
          .catch(() => {}); // no page numbers; the percentage still shows
        return r.display(book.cfi).then(() => cancelled || setReady(true));
      })
      .catch(() => setBroken(true));
    window.addEventListener("keydown", turn);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", turn);
      rendition.current = null;
      epub.current?.destroy();
      epub.current = null;
      stage.current?.replaceChildren();
    };
    // Opens once per book: later prefs/progress updates must not restart the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    if (rendition.current) paint(rendition.current, prefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only these change the page
  }, [prefs.theme, prefs.fontSize, prefs.font]);
  const fill = prefs.fill ?? 100;
  useEffect(() => {
    // The page's box changed height: epub.js lays the chapter out again and stays at the same place.
    // (Its types ask for a size; without one it measures the box, as it does when the window resizes.)
    (rendition.current as unknown as { resize(): void } | null)?.resize();
  }, [fill]);

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

  const existing = pop ? highlights.find((h) => h.cfi === pop.cfi) : undefined;
  /** Highlights the selection, or recolours the tapped highlight; `note` then opens its note. */
  const mark = (color: string, note = false) => {
    if (!pop) return;
    const h: Highlight = existing
      ? { ...existing, color }
      : { cfi: pop.cfi, text: pop.text, color, added: Date.now() };
    if (existing) rendition.current?.annotations.remove(h.cfi, "highlight");
    draw(h);
    onPatch({ highlights: existing ? highlights.map((x) => (x === existing ? h : x)) : [...highlights, h] });
    selectedIn.current?.window.getSelection()?.removeAllRanges();
    setPop(null);
    if (note) setNoting(h.cfi);
  };
  const unmark = (h: Highlight) => {
    rendition.current?.annotations.remove(h.cfi, "highlight");
    onPatch({ highlights: highlights.filter((x) => x !== h) });
    setPop(null);
  };
  const noted = highlights.find((h) => h.cfi === noting);

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
            <span className="line-clamp-3 border-l-2 pl-2" style={{ borderColor: tint(h) }}>
              {h.text}
            </span>
            {h.note && <span className="mt-1 block text-[#a0a0a0]">{h.note}</span>}
          </>
        )}
        onOpen={(h) => go(h.cfi)}
        onDelete={unmark}
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
      status={[
        chapterName === "Bookmark" ? "" : chapterName,
        at && pages
          ? `Page ${Number(epub.current?.locations.locationFromCfi(at.cfi) ?? 0) + 1} of ${pages}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      onTurn={turnBy}
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
          <ModeMenu
            mode={rtl ? "rtl" : "ltr"}
            options={[
              ["ltr", "Left to Right"],
              ["rtl", "Right to Left"],
            ]}
            onPick={(mode) => onPatch({ mode })}
          />
          <Appearance prefs={prefs} onPrefs={onPrefs} />
        </>
      }
      prefs={prefs}
    >
      {broken ? (
        failed
      ) : (
        <>
          {!ready && <Loading lines />}
          <div className="flex min-h-0 grow items-center">
            <div ref={stage} className="mx-auto w-full max-w-[720px] px-4" style={{ height: `${fill}%` }} />
          </div>
          {pop && (
            <div
              role="toolbar"
              aria-label={existing ? "Highlight" : "Selected text"}
              // Under the text where there is room: a phone's own Copy menu sits above it.
              className="fixed z-20 flex -translate-x-1/2 items-center gap-[2px] rounded-full border border-white/15 bg-[#222] p-[5px] text-[#f2f2f2] shadow-2xl"
              style={{
                left: Math.min(Math.max(pop.x, 165), window.innerWidth - 165),
                top:
                  pop.bottom + 62 < window.innerHeight ? pop.bottom + 10 : Math.max(8, pop.top - 58),
              }}
            >
              {Object.entries(HIGHLIGHTS).map(([name, hex]) => (
                <button
                  key={name}
                  aria-label={`Highlight ${name}`}
                  aria-pressed={!!existing && tint(existing) === hex}
                  onClick={() => mark(name)}
                  className="flex size-9 items-center justify-center rounded-full hover:bg-white/10"
                >
                  <span
                    className="size-[22px] rounded-full outline-offset-2 outline-white [[aria-pressed=true]>&]:outline-2"
                    style={{ background: hex }}
                  />
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-white/15" />
              <button
                aria-label={existing?.note ? "Edit note" : "Add note"}
                onClick={() => {
                  if (!existing) return mark("yellow", true);
                  setNoting(existing.cfi);
                  setPop(null);
                }}
                className="flex size-9 items-center justify-center rounded-full hover:bg-white/10"
              >
                <Icon name="pencil" className="size-[18px]" />
              </button>
              {/* Browsers only allow copying on a secure (https) address or on localhost. */}
              {navigator.clipboard && (
                <button
                  aria-label="Copy"
                  onClick={() => {
                    navigator.clipboard.writeText(pop.text);
                    selectedIn.current?.window.getSelection()?.removeAllRanges();
                    setPop(null);
                  }}
                  className="flex size-9 items-center justify-center rounded-full hover:bg-white/10"
                >
                  <Icon name="doc" className="size-[18px]" />
                </button>
              )}
              {existing && (
                <button
                  aria-label="Delete highlight"
                  onClick={() => unmark(existing)}
                  className="flex size-9 items-center justify-center rounded-full hover:bg-white/10"
                >
                  <Icon name="trash" className="size-[18px]" />
                </button>
              )}
            </div>
          )}
          {noted && (
            <form
              key={noted.cfi}
              // At the top on phones, clear of the keyboard.
              className="absolute inset-x-2 z-20 mx-auto max-w-[460px] rounded-2xl border border-white/15 bg-[#222] p-4 text-[#f2f2f2] shadow-2xl max-md:top-2 md:bottom-6"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation(); // closes the note, not the book
                setNoting(null);
              }}
              onSubmit={(e) => {
                e.preventDefault();
                const note = String(new FormData(e.currentTarget).get("note") ?? "").trim() || undefined;
                onPatch({ highlights: highlights.map((x) => (x === noted ? { ...noted, note } : x)) });
                setNoting(null);
              }}
            >
              <p className="line-clamp-3 border-l-2 pl-2 text-[13px] text-[#a0a0a0]" style={{ borderColor: tint(noted) }}>
                {noted.text}
              </p>
              <textarea
                name="note"
                aria-label="Note"
                placeholder="Write a note"
                defaultValue={noted.note}
                autoFocus
                className={`${fieldClass} mt-3 !h-auto min-h-[76px] py-2`}
              />
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setNoting(null)} className={controlClass}>
                  Cancel
                </button>
                <button className={controlClass}>Save Note</button>
              </div>
            </form>
          )}
        </>
      )}
    </Shell>
  );
}

/** One page of a PDF in the scrolling strip, drawn only while it is near the window. */
function PdfStripPage({ doc, n, width }: { doc: PDFDocumentProxy; n: number; width: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState(0); // known once drawn; until then a typical page shape
  useEffect(() => {
    const watch = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "150% 0px" });
    watch.observe(holder.current!);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!near || !width) return;
    let task: RenderTask | undefined;
    let cancelled = false;
    doc.getPage(n).then((p) => {
      if (cancelled || !canvas.current) return;
      const fit = width / p.getViewport({ scale: 1 }).width;
      const viewport = p.getViewport({ scale: fit * window.devicePixelRatio });
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      setHeight(viewport.height / window.devicePixelRatio);
      task = p.render({ canvas: canvas.current, viewport });
      task.promise.catch(() => {}); // cancelled when it scrolls away or the window resizes
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, width, doc, n]);
  return (
    <div ref={holder} aria-label={`Page ${n}`} className="mx-auto" style={{ width, height: height || width * 1.42 }}>
      {near && <canvas ref={canvas} className="block h-full w-full" />}
    </div>
  );
}

/** PDF pages drawn by pdf.js, or the images of a comic archive: a scrolling strip or one page at a time. */
function PagedView({ book, prefs, onPrefs, onPatch, onClose }: Props) {
  const gaps = prefs.gaps ?? true;
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

  // Comics open as one long strip to scroll, like the manga sites; paged turning is a choice per book.
  // An ordinary PDF opens a page at a time; a PDF filed under Manga & Comics opens as a strip.
  const mode: PageMode = book.mode ?? (isPdf && book.kind !== "comic" ? "ltr" : "scroll");
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = area.current ?? strip.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode, broken]);

  useEffect(() => {
    if (!doc || !size.w || mode === "scroll") return;
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
  }, [doc, page, size, mode]);

  const go = (to: number) => {
    const next = Math.min(Math.max(1, Math.round(to) || 1), count || 1);
    if (next === page) return;
    setPage(next);
    onPatch({ page: next, progress: count ? next / count : 0 });
  };
  const step = mode === "rtl" ? -1 : 1; // which way the right-hand arrow goes
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
  }, [mode, count]);
  useEffect(() => {
    const turn = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      // Right always goes on in a strip; in pages it follows the reading direction.
      if (mode === "scroll") {
        if (e.key === "ArrowLeft") jump(page - 1);
        if (e.key === "ArrowRight") jump(page + 1);
        return;
      }
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
      prefs={prefs}
      status={count ? `Page ${page} of ${count}` : undefined}
      onTurn={mode === "scroll" ? undefined : (by) => go(page + by * step)}
      wideEdges
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
          <Appearance prefs={prefs} onPrefs={onPrefs} text={false} />
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
          <ModeMenu
            mode={mode}
            options={[
              ["ltr", "Left to Right"],
              ["rtl", "Right to Left (Manga)"],
              ["scroll", "Scroll Down"],
            ]}
            onPick={(mode) => onPatch({ mode })}
          >
            {mode === "scroll" && (
              <>
                {MENU_RULE}
                <MenuItem label="Gaps Between Pages" checked={gaps} onClick={() => onPrefs({ gaps: !gaps })} />
              </>
            )}
          </ModeMenu>
          {mode !== "scroll" && (
            // Not on phones: there a swipe or a tap on the page's edge turns it, and the toolbar is full.
            <span className="flex gap-1 max-md:hidden">
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
            </span>
          )}
        </>
      }
    >
      {!broken && !count && <Loading />}
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
          // A gap between pages, as in a printed volume's margins, so one page is told from the next.
          // Off for comics drawn as one unbroken strip (webtoons), whose panels run across the page breaks.
          className={`relative min-h-0 grow overflow-y-auto bg-[#111] ${gaps ? "space-y-3" : ""}`}
        >
          {doc
            ? Array.from({ length: doc.numPages }, (_, i) => (
                <PdfStripPage key={i} doc={doc} n={i + 1} width={Math.min(size.w, 800)} />
              ))
            : images.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the archive
                <img key={url} src={url} alt={`Page ${i + 1}`} className="mx-auto block w-full max-w-[800px]" />
              ))}
        </div>
      ) : (
        // The page is laid over the whole area and scaled to fit inside it, so no edge is cut off.
        <div ref={area} className="relative flex min-h-0 grow touch-pinch-zoom items-center justify-center overflow-hidden bg-[#111]">
          {isPdf ? (
            <canvas ref={canvas} />
          ) : (
            images[page - 1] && (
              // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the archive
              <img
                src={images[page - 1]}
                alt={`Page ${page}`}
                className="absolute inset-0 size-full object-contain"
              />
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
      prefs={prefs}
      controls={<Appearance prefs={prefs} onPrefs={onPrefs} />}
    >
      {!broken && !blocks && <Loading lines />}
      {broken ? (
        failed
      ) : (
        <div className="flex min-h-0 grow items-center" style={{ background: bg }}>
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
            className="w-full overflow-y-auto px-5 py-8"
            style={{ color: fg, fontSize: `${prefs.fontSize}%`, height: `${prefs.fill ?? 100}%` }}
          >
            <div className="mx-auto max-w-[680px] leading-[1.6]" style={{ fontFamily: fontOf(prefs.font) }}>
              {blocks?.map((text, i) => (
                <p key={i} className="mb-[0.9em] whitespace-pre-wrap">
                  {text}
                </p>
              ))}
            </div>
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
