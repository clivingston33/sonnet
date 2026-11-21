// Service worker: lets the app open, and downloaded books be read, without a connection.
// - The page, its scripts, covers and the last library answer are kept as they are fetched and
//   used when the network is down (the network always wins when it is there).
// - Book and audio files are served from the device only when the reader chose to download them.

const SHELL = "shell-v1"; // page, scripts, covers, last /api/library answer
const BOOKS = "books"; // files the reader downloaded; filled by the page, see app/offline.ts

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Answers a Range request (audio seeking, PDF paging) from a whole stored file. */
async function ranged(request, stored) {
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get("range") || "");
  if (!range) return stored;
  const blob = await stored.blob();
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": stored.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${blob.size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

/** The network's answer, remembered; or the remembered one, marked, when the network is down. */
async function networkFirst(request, key) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(key, fresh.clone());
    return fresh;
  } catch (error) {
    const stored = await cache.match(key);
    if (!stored) throw error;
    const headers = new Headers(stored.headers);
    headers.set("X-From-Cache", "1"); // the page shows that it is working offline
    return new Response(stored.body, { status: stored.status, headers });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const key = url.pathname + url.search;

  if (url.pathname === "/api/file" && url.searchParams.has("file")) {
    event.respondWith(
      caches
        .open(BOOKS)
        .then((cache) => cache.match(key))
        .then((stored) => (stored ? ranged(request, stored) : fetch(request))),
    );
    return;
  }
  // Covers never change under the same name, so a stored one is always right.
  if (url.pathname === "/api/file" && url.searchParams.has("cover")) {
    event.respondWith(
      caches.match(key).then((stored) => stored || networkFirst(request, key)),
    );
    return;
  }
  if (request.mode === "navigate") return event.respondWith(networkFirst(request, "/"));
  if (url.pathname.startsWith("/_next/") || url.pathname === "/api/library" || /\.(png|svg|webmanifest)$/.test(url.pathname))
    event.respondWith(networkFirst(request, key));
});
