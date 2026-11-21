import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Books",
  description: "Personal ebook collection",
  // Lets phones and tablets install it to the home screen as its own app.
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  // "default": the page starts below the phone's status bar instead of running underneath it.
  appleWebApp: { capable: true, title: "Books", statusBarStyle: "default" },
};
// `cover` lets the app paint to the screen edges; it pads itself clear of notches and home bars.
export const viewport: Viewport = { themeColor: "#1e1e1e", viewportFit: "cover" };

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
