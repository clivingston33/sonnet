/**
 * The reader's typefaces. next/font fetches them when the app is built and serves them from the
 * app itself, so choosing one asks no other site for anything. None is loaded until it is used.
 */
import { Atkinson_Hyperlegible, EB_Garamond, Literata, Lora, Merriweather } from "next/font/google";

// (next/font reads these calls when the app is compiled: each must be spelled out in full.)
const literata = Literata({ subsets: ["latin"], style: ["normal", "italic"], preload: false });
const lora = Lora({ subsets: ["latin"], style: ["normal", "italic"], preload: false });
const merriweather = Merriweather({ subsets: ["latin"], style: ["normal", "italic"], preload: false });
const garamond = EB_Garamond({ subsets: ["latin"], style: ["normal", "italic"], preload: false });
const atkinson = Atkinson_Hyperlegible({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  preload: false,
});

/** Label and CSS font-family of each choice, in menu order. The first is the default. */
export const FONTS: Record<string, { label: string; stack: string }> = {
  georgia: { label: "Georgia", stack: "Bookerly, Georgia, 'Times New Roman', serif" },
  literata: { label: "Literata", stack: `${literata.style.fontFamily}, Georgia, serif` },
  lora: { label: "Lora", stack: `${lora.style.fontFamily}, Georgia, serif` },
  merriweather: { label: "Merriweather", stack: `${merriweather.style.fontFamily}, Georgia, serif` },
  garamond: { label: "EB Garamond", stack: `${garamond.style.fontFamily}, Georgia, serif` },
  atkinson: { label: "Atkinson Hyperlegible", stack: `${atkinson.style.fontFamily}, system-ui, sans-serif` },
  system: { label: "System Sans", stack: "system-ui, sans-serif" },
};
export const fontOf = (key?: string) => (FONTS[key ?? ""] ?? FONTS.georgia).stack;
