import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sonnet",
  description: "Your library of ebooks, audiobooks and manga",
  // Lets phones and tablets install it to the home screen as its own app.
  manifest: "/manifest.webmanifest",
  // app/icon.svg is served at /icon.svg; it has to be named here because `icons` replaces Next's own link.
  icons: { icon: { url: "/icon.svg", type: "image/svg+xml" }, apple: "/apple-touch-icon.png" },
  // "default": the page starts below the phone's status bar instead of running underneath it.
  appleWebApp: { capable: true, title: "Sonnet", statusBarStyle: "default" },
};
// `cover` lets the app paint to the screen edges; it pads itself clear of notches and home bars.
// minimumScale: the page already fits the screen, so there is nothing to zoom out to.
export const viewport: Viewport = {
  themeColor: "#1e1e1e",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // dvh, not 100%: the height that is actually visible while a phone browser's bars are showing.
      className={`${inter.variable} ${sourceSerif.variable} h-dvh antialiased`}
    >
      <body className="h-full font-sans">{children}</body>
    </html>
  );
}
