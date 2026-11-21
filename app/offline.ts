/** Offline reading: the service worker, the books kept on this device, and changes waiting to be sent. */

import type { Batch } from "./sync";

const BOOKS = "books"; // the cache public/sw.js serves book files from
const urlOf = (file: string) => `/api/file?file=${file}`;

/** Browsers only allow this on HTTPS (or localhost): over plain http://192.168… it is unavailable. */
export const canWorkOffline = () =>
  typeof caches !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator;

export function registerWorker() {
  if (canWorkOffline()) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/** Stored names of the book files kept on this device. */
export async function downloadedFiles(): Promise<Set<string>> {
  if (!canWorkOffline()) return new Set();
  const keys = await (await caches.open(BOOKS)).keys();
  return new Set(keys.flatMap((request) => new URL(request.url).searchParams.get("file") ?? []));
}

/** Keeps the files on this device. Throws when one can't be fetched or there is no room for it. */
export async function download(files: string[]) {
  // Asks the browser not to clear this site's storage when the device runs low.
  await navigator.storage?.persist?.().catch(() => false);
  const cache = await caches.open(BOOKS);
  for (const file of files) await cache.add(urlOf(file));
}

export async function removeDownloads(files: string[]) {
  const cache = await caches.open(BOOKS);
  for (const file of files) await cache.delete(urlOf(file));
}

/** Forgets the library answer kept for offline use, so the next person on this device doesn't see it. */
export const forgetLibrary = () =>
  canWorkOffline()
    ? caches
        .keys()
        .then((names) => Promise.all(names.filter((n) => n !== BOOKS).map((n) => caches.open(n).then((c) => c.delete("/api/library")))))
        .catch(() => {})
    : Promise.resolve();

// Changes made while the server couldn't be reached, kept per profile until they are sent.
const pendingKey = (userId: number) => `pending:${userId}`;
export function loadPending(userId: number): Batch | null {
  try {
    return JSON.parse(localStorage.getItem(pendingKey(userId)) ?? "null");
  } catch {
    return null;
  }
}
export function savePending(userId: number, batch: Batch | null) {
  try {
    if (batch) localStorage.setItem(pendingKey(userId), JSON.stringify(batch));
    else localStorage.removeItem(pendingKey(userId));
  } catch {
    // storage full or blocked: the changes still live in this tab
  }
}
