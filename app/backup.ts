/**
 * Reading without an account: the server knows such a reader only by a cookie, so a copy of what
 * is theirs is kept in this browser and, where the browser allows it, in a folder they choose.
 */

import type { Backup } from "./sync";

const FILE = "sonnet-backup.json";
const KEY = "backup";

// Not in TypeScript's DOM types yet.
type Folder = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};
const WRITE = { mode: "readwrite" } as const;

/** Chromium browsers and the desktop app have folder access, and only on https or localhost. */
export const canPickFolder = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

/** One request against the app's small IndexedDB store: the only place a folder's handle can be kept. */
function kept<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const open = indexedDB.open("sonnet", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kept");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = run(open.result.transaction("kept", mode).objectStore("kept"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  };
  return promise;
}

/** The folder chosen earlier, whether or not the browser still lets this site write to it. */
export const chosenFolder = () =>
  canPickFolder()
    ? kept<Folder | undefined>("readonly", (store) => store.get("folder")).catch(() => undefined)
    : Promise.resolve(undefined);

/**
 * The chosen folder, when it may be written to. Browsers withdraw that between visits unless
 * told to allow it every time; `ask` asks for it again, which they only permit from a click.
 */
export async function openFolder(ask = false) {
  const folder = await chosenFolder();
  if (!folder) return null;
  if ((await folder.queryPermission(WRITE)) === "granted") return folder;
  return ask && (await folder.requestPermission(WRITE)) === "granted" ? folder : null;
}

/** Shows the system's folder dialog and remembers the choice. Null when it was closed. */
export async function pickFolder() {
  try {
    const picked = await (
      window as unknown as { showDirectoryPicker(options: object): Promise<Folder> }
    ).showDirectoryPicker({ id: "sonnet", ...WRITE });
    await kept("readwrite", (store) => store.put(picked, "folder"));
    return picked;
  } catch {
    return null;
  }
}

/** Writes the copy to the browser, and to the folder when there is one that may be written to. */
export async function saveBackup(backup: Backup) {
  const json = JSON.stringify(backup);
  try {
    localStorage.setItem(KEY, json);
  } catch {
    // storage full or blocked: the folder's copy, if any, still gets written
  }
  try {
    const folder = await openFolder();
    if (!folder) return;
    const file = await (await folder.getFileHandle(FILE, { create: true })).createWritable();
    await file.write(json);
    await file.close();
  } catch {
    // the folder was moved or deleted: the browser's copy remains
  }
}

/** The copy in the folder if it can be read, else the browser's; null when there is neither. */
export async function loadBackup(): Promise<Backup | null> {
  try {
    const folder = await openFolder();
    if (folder) return JSON.parse(await (await (await folder.getFileHandle(FILE)).getFile()).text());
  } catch {
    // no copy in the folder yet
  }
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}
