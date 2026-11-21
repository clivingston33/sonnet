import { INFO_VERSION } from "../../sync";
import { authorize } from "../../server/auth";
import { getBook, patchBook, type BookData } from "../../server/db";
import { saveCover } from "../../server/files";
import {
  audible,
  genreOf,
  getJson,
  isJson,
  manga,
  num,
  plainText,
  str,
  wikidataSeries,
} from "../../server/sources";

const UNKNOWN_AUTHOR = "Unknown Author";
const first = (v: unknown) => (Array.isArray(v) && isJson(v[0]) ? v[0] : undefined);

/**
 * POST { id }: fills in what the book is missing. Books: Open Library (ratings, year, pages,
 * genre, cover, author, description), then Wikidata for the series. Audiobooks also ask
 * Audible's catalogue (narrator, series, genre). Comics ask AniList instead.
 * Matches on ISBN when the file had one, otherwise on title and author.
 * Fields edited by hand are never overwritten. Returns the fields it changed.
 */
export async function POST(req: Request) {
  const user = authorize(req, true);
  if (user instanceof Response) return user;
  const body: unknown = await req.json().catch(() => null);
  const id = isJson(body) ? str(body.id) : undefined;
  const book = id ? getBook(id) : null;
  if (!id || !book) return new Response(null, { status: 404 });

  const title = String(book.title).replace(/\s*\(.*\)$/, "");
  const author = book.author === UNKNOWN_AUTHOR ? undefined : str(book.author);
  const isbn = str(book.isbn);
  const locked = isJson(book.locked) ? book.locked : {};
  const patch: BookData = {};
  const done = () => {
    patchBook(id, patch);
    return Response.json({ patch });
  };
  /** Sets a field the book doesn't have yet, unless it was edited by hand. */
  const fill = (key: string, value: unknown) => {
    if (value !== undefined && !book[key] && !patch[key] && !locked[key]) patch[key] = value;
  };
  const fetchCover = async (url: string | undefined) => {
    if (book.coverFile || patch.coverFile || !url) return;
    const image = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (image.ok) patch.coverFile = await saveCover(new Uint8Array(await image.arrayBuffer()));
  };

  if (book.kind === "comic") {
    try {
      // A volume is looked up by its series: "One Piece", not "One Piece v03".
      const name = str(book.series) ?? title;
      const [found] = await manga(`search: ${JSON.stringify(name)}, sort: SEARCH_MATCH`, 1);
      patch.info = found
        ? {
            rating: found.rating,
            ratings: found.ratings,
            year: found.year,
            genre: found.genre ?? "",
            v: INFO_VERSION,
          }
        : null; // looked up, nothing found
      if (found) {
        if (!author && found.author && !locked.author) patch.author = found.author;
        fill("blurb", found.description);
        await fetchCover(found.cover);
      }
    } catch {
      if (!Object.keys(patch).length) return Response.json({ error: "Lookup failed" }, { status: 502 });
    }
    return done();
  }

  // A bare title matches the wrong book too often (a file called "story" got a Stephen King
  // cover), so nothing is looked up until there is an ISBN or an author to match with.
  if (!isbn && !author) {
    patch.info = null;
    return done();
  }

  try {
    const query = new URLSearchParams({
      limit: "1",
      fields:
        "key,ratings_average,ratings_count,first_publish_year,number_of_pages_median,cover_i,author_name,subject",
    });
    if (isbn) query.set("isbn", isbn);
    else {
      query.set("title", title);
      if (author) query.set("author", author);
    }
    const doc = first((await getJson(`https://openlibrary.org/search.json?${query}`))?.docs);
    patch.info = doc
      ? {
          rating: num(doc.ratings_average),
          ratings: num(doc.ratings_count),
          year: num(doc.first_publish_year),
          pages: num(doc.number_of_pages_median),
          genre: genreOf(doc.subject) ?? "", // "" = looked up, none recognised
          v: INFO_VERSION,
        }
      : null; // looked up, nothing found
    const foundAuthor = doc && Array.isArray(doc.author_name) ? str(doc.author_name[0]) : undefined;
    if (!author && foundAuthor && !locked.author) patch.author = foundAuthor;
    if (doc && num(doc.cover_i)) await fetchCover(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`);

    if (!book.blurb && !locked.blurb) {
      // Open Library's work record first; Google Books only with a key (its keyless quota is shared and usually spent).
      const work = doc && str(doc.key) ? await getJson(`https://openlibrary.org${doc.key}.json`) : null;
      let description = isJson(work?.description) ? str(work.description.value) : str(work?.description);
      const key = process.env.GOOGLE_BOOKS_KEY;
      if (!description && key) {
        const q = isbn ? `isbn:${isbn}` : `intitle:"${title}" inauthor:"${author}"`;
        const volume = first(
          (await getJson(`https://www.googleapis.com/books/v1/volumes?maxResults=1&key=${key}&q=${encodeURIComponent(q)}`))?.items,
        );
        description = isJson(volume?.volumeInfo) ? str(volume.volumeInfo.description) : undefined;
      }
      fill("blurb", plainText(description));
    }
  } catch {
    // Offline or a service is down: keep whatever was found; the browser asks again next visit.
    if (!Object.keys(patch).length) return Response.json({ error: "Lookup failed" }, { status: 502 });
  }

  // Extras from the other catalogues. Each is optional: when one is down the rest still lands.
  const known = author ?? str(patch.author);
  if (known)
    try {
      if (book.kind === "audiobook") {
        const found = await audible(title, known);
        if (found) {
          fill("narrator", found.narrator);
          fill("series", found.series);
          if (patch.series) fill("seriesIndex", found.seriesIndex);
          fill("blurb", found.blurb);
          await fetchCover(found.cover);
          // Audible's genre is tidier than Open Library's subjects.
          if (isJson(patch.info) && found.genre) patch.info.genre = found.genre;
        }
      } else if (!book.series && !locked.series) {
        const found = await wikidataSeries(title, known);
        if (found) {
          patch.series = found.series;
          fill("seriesIndex", found.seriesIndex);
        }
      }
    } catch {
      // not found this time; the main lookup above still counts
    }

  return done();
}
