// Shared by the import UI and the upload route: the only file types the library accepts.
// Every one of them opens in the app; formats that could only be downloaded were dropped.
export const EBOOK = ["epub", "pdf", "cbz", "txt"];
export const AUDIO = ["m4b", "mp3", "m4a", "flac", "ogg", "opus", "wav"];

export const ACCEPT = [...EBOOK, ...AUDIO].map((ext) => `.${ext}`).join(",");

export function kindOf(fileName: string): "book" | "audiobook" | "pdf" | "comic" | null {
  const ext = fileName.split(".").pop()!.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "cbz") return "comic"; // manga, manhwa and other comics
  if (AUDIO.includes(ext)) return "audiobook";
  return EBOOK.includes(ext) ? "book" : null;
}
