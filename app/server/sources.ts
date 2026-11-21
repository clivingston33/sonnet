/** The online catalogues the server reads. None of them needs a key. */

export type Json = Record<string, unknown>;
export const isJson = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** Descriptions arrive with light markup; the app shows plain text. */
export const plainText = (v: unknown) =>
  str(typeof v === "string" ? v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : undefined)?.slice(0, 5000);

export async function getJson(url: string, init: RequestInit = {}): Promise<Json | null> {
  const res = await fetch(url, {
    ...init,
    // Wikidata refuses requests that don't say who they are.
    headers: { "User-Agent": "BooksLibrary/1.0 (self-hosted)", ...init.headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  const body: unknown = await res.json();
  return isJson(body) ? body : null;
}

const GENRES = [
  "Science Fiction",
  "Historical Fiction",
  "Fantasy",
  "Mystery",
  "Thriller",
  "Romance",
  "Horror",
  "Young Adult",
  "Biography",
  "History",
  "Poetry",
  "Humor",
  "Philosophy",
  "Psychology",
  "Business",
  "Self-Help",
  "Science",
  "Adventure",
];

/**
 * Open Library's subjects are free-form ("Dune (Imaginary place)", "Fiction, science fiction, general"),
 * so a book's genre is the first well-known one any of its subjects mentions.
 */
export function genreOf(subjects: unknown) {
  if (!Array.isArray(subjects)) return;
  for (const subject of subjects) {
    const genre = GENRES.find((g) => String(subject).toLowerCase().includes(g.toLowerCase()));
    if (genre) return genre;
  }
}

export type Manga = {
  id: number;
  title: string;
  author?: string;
  cover?: string;
  rating?: number; // out of 5
  ratings?: number;
  year?: number;
  genre?: string;
  description?: string;
  facts?: string; // "Finished • 25 volumes • 262 chapters"
};

/**
 * Manga, manhwa and manhua from AniList. `filter` is the argument list of its `media` query,
 * written by the server; put user text in it with JSON.stringify.
 */
export async function manga(filter: string, count = 18): Promise<Manga[]> {
  const body = await getJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ Page(perPage: ${count}) { media(type: MANGA, ${filter}) {
        id title { english romaji } coverImage { large } averageScore popularity startDate { year }
        genres description status volumes chapters staff(perPage: 1) { nodes { name { full } } }
      } } }`,
    }),
  });
  const page = isJson(body?.data) && isJson(body.data.Page) ? body.data.Page.media : [];
  return (Array.isArray(page) ? page : []).filter(isJson).map((m) => {
    const title = isJson(m.title) ? m.title : {};
    const staff = isJson(m.staff) && Array.isArray(m.staff.nodes) ? m.staff.nodes[0] : null;
    const score = num(m.averageScore);
    return {
      id: Number(m.id),
      title: str(title.english) ?? str(title.romaji) ?? "Untitled",
      author: isJson(staff) && isJson(staff.name) ? str(staff.name.full) : undefined,
      cover: isJson(m.coverImage) ? str(m.coverImage.large) : undefined,
      rating: score && score / 20,
      ratings: num(m.popularity),
      year: isJson(m.startDate) ? num(m.startDate.year) : undefined,
      genre: Array.isArray(m.genres) ? str(m.genres[0]) : undefined,
      description: plainText(m.description),
      facts: [
        str(m.status)?.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
        num(m.volumes) && `${m.volumes} volumes`,
        num(m.chapters) && `${m.chapters} chapters`,
      ]
        .filter(Boolean)
        .join(" • "),
    };
  });
}

/**
 * Catalogues name one series several ways ("Dune", "Dune Chronicles", "Red Rising Trilogy");
 * dropping the generic last word makes them agree.
 */
export function seriesName<T extends string | undefined>(name: T): T {
  const short = name?.replace(/\s+\(?(series|trilogy|saga|cycle|chronicles|sequence|novels|books)\)?$/i, "").trim();
  return (short || name) as T;
}

/** An audiobook's narrators, series, genre, description and cover, from Audible's public catalogue. */
export async function audible(title: string, author: string) {
  const query = new URLSearchParams({
    num_results: "1",
    products_sort_by: "Relevance",
    title,
    author,
    response_groups: "series,contributors,product_desc,category_ladders,media",
  });
  const body = await getJson(`https://api.audible.com/1.0/catalog/products?${query}`);
  const product = Array.isArray(body?.products) ? body.products[0] : null;
  if (!isJson(product)) return null;
  const names = (v: unknown) =>
    Array.isArray(v) ? v.flatMap((x) => (isJson(x) ? (str(x.name) ?? []) : [])).join(", ") : "";
  const series = Array.isArray(product.series) && isJson(product.series[0]) ? product.series[0] : {};
  const ladder =
    Array.isArray(product.category_ladders) && isJson(product.category_ladders[0])
      ? product.category_ladders[0].ladder
      : null;
  // The ladder runs from broad to narrow ("Science Fiction & Fantasy" > "Science Fiction"); the second step reads best.
  const genre = Array.isArray(ladder) ? (ladder[1] ?? ladder[0]) : null;
  return {
    narrator: str(names(product.narrators)),
    series: seriesName(str(series.title)),
    seriesIndex: Number(series.sequence) || undefined,
    genre: isJson(genre) ? str(genre.name) : undefined,
    blurb: plainText(product.publisher_summary),
    cover: isJson(product.product_images) ? str(product.product_images["500"]) : undefined,
  };
}

/** The series a book belongs to and its place in it, from Wikidata. Matches the exact title and author. */
export async function wikidataSeries(title: string, author: string) {
  const query = `SELECT ?seriesLabel ?ordinal WHERE {
    ?work rdfs:label ${JSON.stringify(title)}@en; wdt:P50 ?author; p:P179 ?membership.
    ?author rdfs:label ${JSON.stringify(author)}@en.
    ?membership ps:P179 ?series. OPTIONAL { ?membership pq:P1545 ?ordinal }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
  } LIMIT 1`;
  const body = await getJson(
    `https://query.wikidata.org/sparql?${new URLSearchParams({ format: "json", query })}`,
  );
  const rows = isJson(body?.results) ? body.results.bindings : null;
  const row = Array.isArray(rows) && isJson(rows[0]) ? rows[0] : null;
  const value = (v: unknown) => (isJson(v) ? str(v.value) : undefined);
  const series = row && value(row.seriesLabel);
  return series ? { series: seriesName(series), seriesIndex: Number(value(row.ordinal)) || undefined } : null;
}
