// Run: node --test app/server/metadata.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { nameMeta, readMeta, volumeOf } from "./metadata.ts";

const dir = mkdtempSync(path.join(tmpdir(), "meta-"));
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

async function epub(name: string, opf: string, files: Record<string, Buffer> = {}) {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path='OEBPS/content.opf'/></rootfiles></container>`,
  );
  zip.file("OEBPS/content.opf", opf);
  for (const [file, data] of Object.entries(files)) zip.file(file, data);
  const target = path.join(dir, name);
  writeFileSync(target, await zip.generateAsync({ type: "nodebuffer" }));
  return target;
}

test("EPUB2: calibre series, named cover, escaped HTML description, several authors", async () => {
  const file = await epub(
    "two.epub",
    `<package><metadata xmlns:dc="x" xmlns:opf="y">
      <dc:title>Tom &amp; Jerry</dc:title>
      <dc:creator opf:role="aut">Ann Lee</dc:creator><dc:creator>Bo Ray</dc:creator>
      <dc:description>&lt;p&gt;A &lt;b&gt;fine&lt;/b&gt;   book &amp;amp; more.&lt;/p&gt;</dc:description>
      <dc:identifier opf:scheme="ISBN">978-0-441-17271-9</dc:identifier>
      <meta content="Saga" name="calibre:series"/><meta name="calibre:series_index" content="2.0"/>
      <meta name="cover" content="img1"/>
    </metadata><manifest><item href="images/c%20over.jpg" id="img1" media-type="image/jpeg"/></manifest></package>`,
    { "OEBPS/images/c over.jpg": JPEG },
  );
  const { cover, ...meta } = await readMeta(file);
  assert.deepEqual(meta, {
    title: "Tom & Jerry",
    author: "Ann Lee, Bo Ray",
    description: "A fine book & more.",
    series: "Saga",
    seriesIndex: 2,
    isbn: "9780441172719",
  });
  assert.deepEqual(Buffer.from(cover!), JPEG);
});

test("EPUB3: belongs-to-collection, cover-image property, urn:isbn", async () => {
  const file = await epub(
    "three.epub",
    `<package><metadata><title>Plain</title>
      <dc:identifier>urn:uuid:1234</dc:identifier><dc:identifier>urn:isbn:0441172717</dc:identifier>
      <meta property="belongs-to-collection" id="c1">Trilogy</meta>
      <meta refines="#c1" property="group-position">3</meta>
    </metadata><manifest><item id="x" properties="nav cover-image" href="../cover.png"/></manifest></package>`,
    { "cover.png": JPEG },
  );
  const meta = await readMeta(file);
  assert.equal(meta.series, "Trilogy");
  assert.equal(meta.seriesIndex, 3);
  assert.equal(meta.isbn, "0441172717");
  assert.equal(meta.author, undefined);
  assert.ok(meta.cover);
});

test("EPUB3: a collection of type set is a list the book is on, not its series", async () => {
  const file = await epub(
    "sets.epub",
    `<package><metadata><title>Plain</title>
      <meta id="a" property="belongs-to-collection">100 Best Novels</meta>
      <meta property="collection-type" refines="#a">set</meta>
      <meta property="group-position" refines="#a">40</meta>
      <meta id="b" property="belongs-to-collection">Sherlock Holmes</meta>
      <meta property="collection-type" refines="#b">series</meta>
      <meta property="group-position" refines="#b">2</meta>
    </metadata><manifest></manifest></package>`,
  );
  const meta = await readMeta(file);
  assert.equal(meta.series, "Sherlock Holmes");
  assert.equal(meta.seriesIndex, 2);
});

test("EPUB of page images (fixed layout) is a comic, read right to left when its spine says so", async () => {
  const file = await epub(
    "manga.epub",
    `<package><metadata xmlns:dc="x"><dc:title>Dandadan v05 (2023) (Digital)</dc:title>
      <meta property="rendition:layout">pre-paginated</meta></metadata>
      <manifest/><spine page-progression-direction="rtl"/></package>`,
  );
  assert.deepEqual(await readMeta(file), { title: "Dandadan v05 (2023) (Digital)", comic: true, rtl: true });
  const novel = await epub("novel.epub", `<package><metadata xmlns:dc="x"><dc:title>Emma</dc:title></metadata></package>`);
  assert.deepEqual(await readMeta(novel), { title: "Emma" });
});

test("EPUB with a picture per page is a comic; an illustrated novel with as many pictures is not", async () => {
  const book = (name: string, page: string) => {
    const files: Record<string, Buffer> = {};
    let manifest = "";
    for (let i = 0; i < 20; i++) manifest += `<item href="img/${i}.jpg" media-type="image/jpeg"/>`;
    for (let i = 0; i < 10; i++) {
      manifest += `<item href="p${i}.xhtml" media-type="application/xhtml+xml"/>`;
      files[`OEBPS/p${i}.xhtml`] = Buffer.from(`<html><head><title>Page ${i}</title></head><body>${page}</body></html>`);
    }
    return epub(name, `<package><metadata><title>T</title></metadata><manifest>${manifest}</manifest></package>`, files);
  };
  assert.equal((await readMeta(await book("strip.epub", `<img src="img/1.jpg" alt="Page"/>`))).comic, true);
  const chapter = `<img src="img/1.jpg"/><p>${"Alice was beginning to get very tired. ".repeat(40)}</p>`;
  assert.equal((await readMeta(await book("illustrated.epub", chapter))).comic, undefined);
});

test("unreadable and unknown files yield {}", async () => {
  const bad = path.join(dir, "bad.epub");
  writeFileSync(bad, "not a zip");
  assert.deepEqual(await readMeta(bad), {});
  assert.deepEqual(await readMeta(path.join(dir, "missing.m4b")), {});
  assert.deepEqual(await readMeta(path.join(dir, "notes.mobi")), {});
});

test("PDF title and author come from its Info dictionary", async () => {
  const file = path.join(dir, "a.pdf");
  writeFileSync(
    file,
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj
4 0 obj<</Title(Animal Farm)/Author(George Orwell)>>endobj
trailer<</Root 1 0 R/Info 4 0 R>>
%%EOF`,
  );
  assert.deepEqual(await readMeta(file), { title: "Animal Farm", author: "George Orwell" });
});

test("file names: site tags dropped, a trailing name is the author, edition notes are not", () => {
  assert.deepEqual(nameMeta("Animal Farm (George Orwell) (z-library.sk, 1lib.sk, z-lib.sk).pdf"), {
    title: "Animal Farm",
    author: "George Orwell",
  });
  assert.deepEqual(nameMeta("Dune (Unabridged).m4b"), { title: "Dune (Unabridged)" });
  assert.deepEqual(nameMeta("Emma (Penguin Classics).epub"), { title: "Emma (Penguin Classics)" });
  assert.deepEqual(nameMeta("my_story.txt"), { title: "my story" });
});

test("CBZ cover is the first page in natural order", async () => {
  const zip = new JSZip();
  zip.file("page10.jpg", Buffer.from("ten"));
  zip.file("page2.jpg", Buffer.from("two"));
  zip.file("readme.txt", "x");
  const file = path.join(dir, "comic.cbz");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(Buffer.from((await readMeta(file)).cover!).toString(), "two");
});

test("CBZ: ComicInfo.xml gives series, number, writer and reading direction", async () => {
  const zip = new JSZip();
  zip.file("001.jpg", Buffer.from("one"));
  zip.file(
    "ComicInfo.xml",
    `<ComicInfo><Series>One Piece</Series><Number>3</Number><Writer>Eiichiro Oda</Writer>
     <Summary>Pirates &amp; treasure.</Summary><Manga>YesAndRightToLeft</Manga></ComicInfo>`,
  );
  const file = path.join(dir, "tagged.cbz");
  writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  const { cover, ...meta } = await readMeta(file);
  assert.ok(cover);
  assert.deepEqual(meta, {
    title: "One Piece 3",
    series: "One Piece",
    seriesIndex: 3,
    author: "Eiichiro Oda",
    description: "Pirates & treasure.",
    rtl: true,
  });
});

test("comic file names give the series and volume or chapter number", () => {
  assert.deepEqual(volumeOf("One Piece v03"), { series: "One Piece", seriesIndex: 3 });
  assert.deepEqual(volumeOf("Solo Leveling - Chapter 12.5"), { series: "Solo Leveling", seriesIndex: 12.5 });
  assert.deepEqual(volumeOf("Naruto 045"), { series: "Naruto", seriesIndex: 45 });
  assert.deepEqual(volumeOf("Watchmen"), {});
});

test("audio duration", async () => {
  const rate = 8000;
  const samples = rate * 3;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  const file = path.join(dir, "part.wav");
  writeFileSync(file, wav);
  assert.equal(Math.round((await readMeta(file)).duration!), 3);
});
