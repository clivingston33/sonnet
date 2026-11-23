// Downloads the demo library into demo/books: public-domain books, an audiobook and a PDF, and
// three episodes of Pepper&Carrot (CC BY 4.0, David Revoy). Run with `node demo/fetch.mjs`.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const OUT = path.join(import.meta.dirname, "books");
await mkdir(OUT, { recursive: true });

const get = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Sonnet demo library)" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
};
/** Saves `url` as `name`, unless an earlier run already did. */
const save = async (name, url) => {
  const file = path.join(OUT, name);
  if (existsSync(file)) return;
  await writeFile(file, typeof url === "string" ? await get(url) : await url());
  console.log(name);
};

// Standard Ebooks: public-domain texts with proper covers and metadata.
for (const book of [
  "mary-shelley/frankenstein",
  "jane-austen/pride-and-prejudice",
  "lewis-carroll/alices-adventures-in-wonderland/john-tenniel",
  "h-g-wells/the-war-of-the-worlds",
  "bram-stoker/dracula",
  "arthur-conan-doyle/a-study-in-scarlet",
  "arthur-conan-doyle/the-adventures-of-sherlock-holmes",
  "herman-melville/moby-dick",
  "f-scott-fitzgerald/the-great-gatsby",
  "h-g-wells/the-time-machine",
  "oscar-wilde/the-picture-of-dorian-gray",
]) {
  const name = `${book.replaceAll("/", "_")}.epub`;
  await save(name, `https://standardebooks.org/ebooks/${book}/downloads/${name}?source=download`);
}

// LibriVox recording (public domain), a file per chapter: Sonnet joins files of one album into one
// audiobook. (LibriVox's single M4B has a broken end that the tag reader gives up on.)
for (let n = 1; n <= 12; n++) {
  const chapter = String(n).padStart(2, "0");
  await save(`Alice in Wonderland ${chapter}.mp3`, async () => {
    const data = Buffer.from(
      await get(`https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_${chapter}_64kb.mp3`),
    );
    // The title tag is the file's name, and it becomes the chapter's. Written over in place,
    // padded to the same length, so nothing else in the tag has to move.
    const old = `wonderland_ch_${chapter}`;
    const title = `Chapter ${n}`.padEnd(old.length, "\0");
    for (let at = data.indexOf(old, 0, "latin1"); at >= 0; at = data.indexOf(old, at + 1, "latin1"))
      data.write(title, at, "latin1");
    return data;
  });
}

// Oliver Byrne's 1847 colour edition of Euclid.
await save(
  "The Elements of Euclid (Oliver Byrne).pdf",
  "https://archive.org/download/firstsixbooksofe00byrn/firstsixbooksofe00byrn.pdf",
);

// Pepper&Carrot by David Revoy, CC BY 4.0, https://www.peppercarrot.com
const SOURCES = "https://www.peppercarrot.com/0_sources";
const episodes = JSON.parse(new TextDecoder().decode(await get(`${SOURCES}/episodes-v1.json`)));
for (const [i, episode] of episodes.slice(0, 3).entries()) {
  const title = episode.name.replace(/^ep\d+_/, "").replaceAll("-", " ");
  await save(`Pepper&Carrot ${i + 1}.cbz`, async () => {
    const zip = new JSZip();
    const { cover, ...pages } = episode.pages;
    // Named to sort first: the first picture is the book's cover, and the title page is only a banner.
    zip.file("00-cover.jpg", await get(`${SOURCES}/${episode.name}/low-res/en_${cover}`));
    for (const page of Object.values(pages).sort())
      zip.file(page, await get(`${SOURCES}/${episode.name}/low-res/en_${page}`));
    zip.file(
      "ComicInfo.xml",
      `<?xml version="1.0"?><ComicInfo><Title>Pepper&amp;Carrot ${i + 1}: ${title}</Title>` +
        `<Series>Pepper&amp;Carrot</Series><Number>${i + 1}</Number><Writer>David Revoy</Writer>` +
        `<Summary>A webcomic by David Revoy, licensed CC BY 4.0. peppercarrot.com</Summary></ComicInfo>`,
    );
    return zip.generateAsync({ type: "uint8array" });
  });
}
