import { randomUUID } from "node:crypto";
import { INFO_VERSION, type Found } from "../../sync";
import { authorize } from "../../server/auth";
import { db, getBook } from "../../server/db";
import { saveCover } from "../../server/files";
import {
  genreOf,
  getJson,
  isJson,
  manga,
  num,
  plainText,
  type Json,
  type Manga,
} from "../../server/sources";

const FIELDS =
  "key,title,author_name,first_publish_year,cover_i,ratings_average,ratings_count,number_of_pages_median,subject";
const WORK = /^\/works\/OL\d+W$/;
const ANILIST = /^anilist:(\d+)$/;
// Adult manga (hentai) is never shown. AniList flags it reliably; books have no such flag and are not filtered.
const SAFE = "isAdult: false";
const UNKNOWN_AUTHOR = "Unknown Author";

// ponytail: in-memory cache, lost on restart and per process; fine for one home server
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.value as T;
  const value = await load();
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Open Library works at `path`. */
const works = (path: string) =>
  cached(path, async () => {
    const body = await getJson(`https://openlibrary.org/${path}`);
    const list: unknown = body?.works ?? body?.docs;
    return (Array.isArray(list) ? (list as Json[]) : []).filter((d) => WORK.test(String(d.key)) && d.title);
  });
const mangaList = (filter: string) => cached(`manga ${filter}`, () => manga(`${filter}, ${SAFE}`));

const authorOf = (d: Json) =>
  Array.isArray(d.author_name) && d.author_name[0] ? String(d.author_name[0]) : UNKNOWN_AUTHOR;
const fromManga = (m: Manga): Found => ({
  key: `anilist:${m.id}`,
  title: m.title,
  author: m.author ?? UNKNOWN_AUTHOR,
  year: m.year,
  cover: m.cover,
  rating: m.rating,
  ratings: m.ratings,
});

/**
 * GET ?list=trending | new | manga | manhwa, ?subject=<genre>, ?author=<name>, ?q=<search> or
 * ?manga=<search>: books from Open Library's catalogue, manga from AniList's.
 * Lists only include books with a cover, so the rows look complete.
 * GET ?about=<key>: the description of one of those books, for its info page.
 */
export async function GET(req: Request) {
  const user = authorize(req);
  if (user instanceof Response) return user;
  const params = new URL(req.url).searchParams;
  const list = params.get("list");
  // Quotes would end the phrase these are put inside.
  const param = (name: string) => (params.get(name) ?? "").replace(/"/g, " ").trim().slice(0, 200);
  const [q, subject, author, comic, comicGenre] = [
    param("q"),
    param("subject"),
    param("author"),
    param("manga"),
    param("mangaGenre"),
  ];
  const search = (query: string, sort = "") =>
    `search.json?${new URLSearchParams({ q: query, fields: FIELDS, limit: "24" })}${sort}`;
  try {
    const about = params.get("about") ?? "";
    const comicId = ANILIST.exec(about)?.[1];
    if (comicId) {
      const [m] = await mangaList(`id: ${comicId}`);
      return Response.json({ description: m?.description, genre: m?.genre, facts: m?.facts });
    }
    if (WORK.test(about)) {
      const work = await cached(`about ${about}`, () => getJson(`https://openlibrary.org${about}.json`));
      const description = isJson(work?.description) ? work.description.value : work?.description;
      return Response.json({ description: plainText(description), genre: genreOf(work?.subjects) });
    }
    const drawn = comic
      ? await mangaList(`search: ${JSON.stringify(comic)}, sort: SEARCH_MATCH`)
      : comicGenre
        ? await mangaList(`genre: ${JSON.stringify(comicGenre)}, sort: POPULARITY_DESC`)
        : list === "manga"
          ? await mangaList(`sort: TRENDING_DESC, countryOfOrigin: "JP"`)
          : list === "manhwa"
            ? await mangaList(`sort: TRENDING_DESC, countryOfOrigin: "KR"`)
            : null;
    if (drawn) return Response.json({ books: drawn.map(fromManga) });

    const path = q
      ? search(q)
      : author
        ? search(`author:"${author}"`)
        : subject
          ? search(`subject:"${subject}"`, `&sort=${params.get("sort") === "rating" ? "rating" : "trending"}`)
          : list === "trending"
            ? "trending/weekly.json?limit=24"
            : list === "new"
              ? search(`first_publish_year:[${new Date().getFullYear() - 1} TO *]`, "&sort=trending")
              : null;
    if (!path) return Response.json({ error: "Unknown list" }, { status: 400 });
    const books: Found[] = (await works(path))
      .filter((d) => q || num(d.cover_i))
      .slice(0, 18)
      .map((d) => ({
        key: String(d.key),
        title: String(d.title),
        author: authorOf(d),
        year: num(d.first_publish_year),
        cover: num(d.cover_i) ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined,
        rating: num(d.ratings_average),
        ratings: num(d.ratings_count),
      }));
    return Response.json({ books });
  } catch {
    return Response.json({ error: "The catalogue can’t be reached right now." }, { status: 502 });
  }
}

/**
 * POST { key }: puts that catalogue entry on the user's Want to Read list, creating a book
 * without a file for it. The details come from the catalogue, not from the request.
 */
export async function POST(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => null);
  const key: unknown = body?.key;
  if (typeof key !== "string" || !(WORK.test(key) || ANILIST.test(key)))
    return Response.json({ error: "Bad request" }, { status: 400 });

  let id = db.prepare("SELECT id FROM books WHERE data ->> 'olKey' = ?").get(key)?.id;
  if (!id) {
    let book: Json | undefined;
    let cover: string | undefined;
    try {
      const comic = ANILIST.exec(key);
      if (comic) {
        const [m] = await manga(`id: ${comic[1]}, ${SAFE}`, 1);
        cover = m?.cover;
        book = m && {
          title: m.title,
          author: m.author ?? UNKNOWN_AUTHOR,
          kind: "comic",
          blurb: m.description,
          info: { rating: m.rating, ratings: m.ratings, year: m.year, genre: m.genre ?? "", v: INFO_VERSION },
        };
      } else {
        const [doc] = await works(
          `search.json?${new URLSearchParams({ q: `key:${key}`, fields: FIELDS, limit: "1" })}`,
        );
        cover = doc && num(doc.cover_i) ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined;
        // `info.v` is left out so the regular lookup still fetches the description and series.
        book = doc && {
          title: String(doc.title),
          author: authorOf(doc),
          kind: "book",
          info: {
            rating: num(doc.ratings_average),
            ratings: num(doc.ratings_count),
            year: num(doc.first_publish_year),
            pages: num(doc.number_of_pages_median),
            genre: genreOf(doc.subject) ?? "",
          },
        };
      }
    } catch {
      // handled below
    }
    if (!book) return Response.json({ error: "The catalogue can’t be reached right now." }, { status: 502 });
    const image = cover && (await fetch(cover, { signal: AbortSignal.timeout(10_000) }).catch(() => null));
    id = randomUUID();
    db.prepare("INSERT INTO books (id, data) VALUES (?, ?)").run(
      id,
      JSON.stringify({
        ...book,
        title: String(book.title).slice(0, 300),
        author: String(book.author).slice(0, 300),
        cover: ["#2b5d8a", "#0a1a2a"],
        coverFile: image && image.ok ? await saveCover(new Uint8Array(await image.arrayBuffer())) : undefined,
        added: new Date().toLocaleDateString("sv"),
        olKey: key,
      }),
    );
  }
  db.prepare(
    `INSERT INTO user_books (user_id, book_id, data) VALUES (?, ?, '{"want":true}')
     ON CONFLICT DO UPDATE SET data = json_patch(data, excluded.data)`,
  ).run(user.id, id);
  return Response.json({ book: { ...getBook(String(id)), id, want: true } });
}
