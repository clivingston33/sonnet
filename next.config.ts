import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  // The desktop app (desktop/build-server.js) packs a self-contained copy of the server.
  output: process.env.SONNET_DESKTOP ? "standalone" : undefined,
  // That copy must hold pdf.js's worker, loaded at run time, and never this machine's own library.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  outputFileTracingExcludes: {
    "*": ["./data/**", "./library/**", "./desktop/**", "./docs/**", "./.git/**"],
  },
  // The import route reads PDF metadata with pdf.js, which loads its worker file at run time.
  serverExternalPackages: ["pdfjs-dist"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
