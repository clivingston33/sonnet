import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { parseFile } from "music-metadata";
import { AUDIO } from "../formats.ts";

/** What a file says about itself. */
export type FileMeta = {
  title?: string;
  author?: string; // several authors joined with ", "
  description?: string; // plain text
  series?: string;
  seriesIndex?: number;
  isbn?: string; // digits/X only, 10 or 13 long
  narrator?: string;
  album?: string; // audio album tag: groups the files of one audiobook
  part?: string; // audio title tag: the name of this file's part of the book
  track?: number;
  duration?: number; // seconds
  chapters?: { title: string; start: number }[]; // seconds from the start
  cover?: Uint8Array;
  rtl?: boolean; // comic that reads right to left
  comic?: boolean; // an EPUB made of page images (manga, comics) rather than text
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) =>
      code[0] !== "#"
        ? (ENTITIES[code.toLowerCase()] ?? whole)
        : String.fromCodePoint(
            /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
          ),
    );
/** Text of an XML/HTML fragment: descriptions are often HTML, sometimes escaped twice. */
const plain = (s: string) =>
  decode(decode(s).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000) || undefined;

// There is no XML parser in Node; these cover the flat, predictable shape of OPF metadata.
type El = { attrs: string; text: string };
/** Elements called `name` (any namespace prefix) that have a closing tag. */
const tags = (xml: string, name: string): El[] =>
  [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "gi"))].map(
    (m) => ({ attrs: m[1], text: m[2] }),
  );
/** Attribute strings of every `name` element, self-closing or not. */
const elements = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)/?>`, "gi"))].map((m) => m[1]);
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? decode(m[1] ?? m[2]) : undefined;
};
const number = (s: string | undefined) => {
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? n : undefined;
};
const isbnOf = (s: string) => {
  const digits = s.toUpperCase().replace(/[^0-9X]/g, "");
  return digits.length === 10 || digits.length === 13 ? digits : undefined;
};

// ponytail: entries are inflated in memory without a size cap; only signed-in users can
// upload, so a zip bomb is self-inflicted. Stream with limits if uploads ever open up.
async function epub(file: string): Promise<FileMeta> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const text = (name: string) => zip.file(name)?.async("string") ?? "";
  const opfPath = attr(elements(await text("META-INF/container.xml"), "rootfile")[0] ?? "", "full-path");
  if (!opfPath) return {};
  const opf = await text(opfPath);
  const metas = tags(opf, "meta"); // EPUB3: <meta property="…">value</meta>
  const named = (name: string) => {
    // EPUB2 / calibre: <meta name="…" content="…"/>
    const found = elements(opf, "meta").find((a) => attr(a, "name") === name);
    return found ? attr(found, "content") : undefined;
  };

  const collection = metas.find((m) => attr(m.attrs, "property") === "belongs-to-collection");
  const position = metas.find((m) => attr(m.attrs, "property") === "group-position");
  const identifiers = tags(opf, "identifier");
  const isbn =
    identifiers.find((i) => /isbn/i.test(i.attrs + i.text)) ??
    identifiers.find((i) => /^\s*97[89][\d-]{10,}\s*$/.test(i.text));

  const items = elements(opf, "item");
  const coverItem =
    items.find((a) => attr(a, "properties")?.split(/\s+/).includes("cover-image")) ??
    items.find((a) => attr(a, "id") === named("cover")) ??
    items.find((a) => /^image\//.test(attr(a, "media-type") ?? "") && /cover/i.test(attr(a, "href") ?? ""));
  const href = coverItem && attr(coverItem, "href");
  const coverFile = href && zip.file(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(href)));

  return {
    title: plain(tags(opf, "title")[0]?.text ?? ""),
    author: tags(opf, "creator").map((c) => plain(c.text)).filter(Boolean).join(", ") || undefined,
    description: plain(tags(opf, "description")[0]?.text ?? ""),
    series: named("calibre:series") ?? (collection && plain(collection.text)),
    seriesIndex: number(named("calibre:series_index") ?? position?.text.trim()),
    isbn: isbn && isbnOf(decode(isbn.text)),
    cover: coverFile ? await coverFile.async("uint8array") : undefined,
    // Fixed-layout EPUBs are how manga and comics are packaged; comic converters also say so outright.
    // Others are plain EPUBs with one picture per page: at least as many pictures as pages of text.
    comic:
      metas.some((m) => attr(m.attrs, "property") === "rendition:layout" && /pre-paginated/.test(m.text)) ||
      named("fixed-layout") === "true" ||
      named("book-type") === "comic" ||
      ((pictures) => pictures >= 20 && pictures >= items.filter((a) => /xhtml/.test(attr(a, "media-type") ?? "")).length)(
        items.filter((a) => /^image\//.test(attr(a, "media-type") ?? "")).length,
      ) ||
      undefined,
    rtl: /page-progression-direction\s*=\s*["']rtl/.test(opf) || undefined,
  };
}

async function audio(file: string): Promise<FileMeta> {
  const { common, format } = await parseFile(file, { duration: true, includeChapters: true });
  return {
    // Audiobook files carry the book in `album` and the part in `title`.
    title: common.album ?? common.title,
    album: common.album,
    part: common.album ? common.title : undefined,
    author: common.albumartist ?? common.artist,
    narrator: common.composer?.join(", "),
    track: common.track.no ?? undefined,
    duration: format.duration,
    description: plain([common.description ?? [], common.comment?.map((c) => c.text ?? "") ?? []].flat()[0] ?? ""),
    chapters: format.chapters
      ?.map((c) => ({ title: c.title, start: c.timeScale ? c.start / c.timeScale : c.start }))
      .sort((a, b) => a.start - b.start),
    cover: common.picture?.[0]?.data,
  };
}

async function cbz(file: string): Promise<FileMeta> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const first = Object.values(zip.files)
    .filter((f) => !f.dir && /\.(jpe?g|png|webp|gif)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  // ComicInfo.xml is the tagging convention comic managers write into the archive.
  const xml = (await zip.file(/(^|\/)ComicInfo\.xml$/i)[0]?.async("string")) ?? "";
  const field = (name: string) => plain(tags(xml, name)[0]?.text ?? "");
  const series = field("Series");
  const index = number(field("Number")) ?? number(field("Volume"));
  return {
    title: field("Title") ?? (series && index ? `${series} ${index}` : undefined),
    series,
    seriesIndex: index,
    author: field("Writer"),
    description: field("Summary"),
    rtl: /RightToLeft/i.test(field("Manga") ?? "") || undefined,
    cover: first && (await first.async("uint8array")),
  };
}

/** Series and number from a comic's file-name title: "One Piece v03", "Solo Leveling Chapter 12", "Naruto 045". */
export function volumeOf(title: string): { series?: string; seriesIndex?: number } {
  const m =
    /^(.*?\S)[\s,-]*(?:\b(?:v|vol\.?|volume|ch\.?|chapter|c)|#)\s*(\d+(?:\.\d+)?)\b/i.exec(title) ??
    /^(.*?\S)\s+(\d{1,4})$/.exec(title);
  return m ? { series: m[1], seriesIndex: Number(m[2]) } : {};
}

/** Comic files carry release tags after the name: "Dandadan v05 (2023) (Digital) (1r0n)" → "Dandadan v05". */
export const tidyComic = (title: string) => title.replace(/(\s*[([][^()[\]]*[)\]])+$/, "") || title;
/** Comic converters sign themselves as the author. */
export const CONVERTER = /^(KCC|KindleComicConverter.*|Unknown)$/i;

async function pdf(file: string): Promise<FileMeta> {
  // ponytail: pdf.js wants the whole file in memory; huge scans keep their file-name title
  if ((await stat(file)).size > 200 * 1024 * 1024) return {};
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(await readFile(file)) });
  try {
    const info = (await (await task.promise).getMetadata()).info as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    const title = text(info.Title);
    return {
      // Word processors leave the document's file name or "Untitled" here.
      title: /\.\w{2,4}$|^untitled|^microsoft word/i.test(title) ? undefined : title,
      author: text(info.Author),
    };
  } finally {
    await task.destroy();
  }
}

/**
 * Title, and author when it is there, from a file name such as
 * "Animal Farm (George Orwell) (z-library.sk, 1lib.sk).pdf". Used when the file says nothing itself.
 */
export function nameMeta(name: string): { title: string; author?: string } {
  const title = name
    .replace(/\.[^.]+$/, "")
    .replace(/[_\s]+/g, " ")
    // download sites sign their files in brackets
    .replace(/\s*[([][^()[\]]*\b[\w-]+\.(?:sk|org|com|net|se|is|to|li)\b[^()[\]]*[)\]]/gi, "")
    .trim()
    .slice(0, 300);
  // A trailing "(Two To Four Capitalised Words)" is the author, unless it reads like an edition note.
  const m = /^(.*\S)\s*\(((?:\p{Lu}[\p{L}.'-]*)(?: \p{Lu}[\p{L}.'-]*){1,3})\)$/u.exec(title);
  return m && !/\b(Edition|Classics|Series|Book|Volume|Version)\b/.test(m[2])
    ? { title: m[1], author: m[2] }
    : { title };
}

/** Reads a file's own metadata, chosen by extension. Never throws: a file it can't read yields {}. */
export async function readMeta(file: string): Promise<FileMeta> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const reader =
    ext === "epub" ? epub : ext === "cbz" ? cbz : ext === "pdf" ? pdf : AUDIO.includes(ext) ? audio : null;
  try {
    const meta: FileMeta = reader ? await reader(file) : {};
    for (const key of Object.keys(meta) as (keyof FileMeta)[])
      if (meta[key] === undefined || meta[key] === "") delete meta[key];
    return meta;
  } catch {
    return {};
  }
}
