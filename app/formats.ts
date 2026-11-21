// Shared by the import UI and the upload route: the only file types the library accepts.
export const EBOOK = ["epub", "pdf", "mobi", "azw", "azw3", "kfx", "fb2", "djvu", "cbz", "cbr", "txt"];
export const AUDIO = ["m4b", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "wma"];

export const ACCEPT = [...EBOOK, ...AUDIO].map((ext) => `.${ext}`).join(",");

export function kindOf(fileName: string): "book" | "audiobook" | "pdf" | null {
  const ext = fileName.split(".").pop()!.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (AUDIO.includes(ext)) return "audiobook";
  return EBOOK.includes(ext) ? "book" : null;
}
