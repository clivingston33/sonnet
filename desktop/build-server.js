/**
 * Builds the server the desktop app runs for a library kept on this computer, into desktop/server.
 * Only the listed parts of Next's standalone build are copied: its tracing can sweep up the whole
 * project folder, and your own books and database must never end up inside an installer.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const built = path.join(root, ".next", "standalone");
const out = path.join(__dirname, "server");

execSync("npx next build", { cwd: root, stdio: "inherit", env: { ...process.env, SONNET_DESKTOP: "1" } });
fs.rmSync(out, { recursive: true, force: true });
for (const part of ["server.js", "package.json", ".next", "node_modules"])
  fs.cpSync(path.join(built, part), path.join(out, part), { recursive: true });
// The standalone build leaves these two out; its server expects them beside it.
fs.cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
fs.cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
