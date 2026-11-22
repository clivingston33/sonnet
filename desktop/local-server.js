/** What the two desktop apps share: running the bundled server, and telling whether an address is a Sonnet server. */
const { app, net } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isSonnet = async (origin) => {
  try {
    const res = await net.fetch(`${origin}/manifest.webmanifest`, { signal: AbortSignal.timeout(8000) });
    return (await res.json()).name === "Sonnet";
  } catch {
    return false;
  }
};

/** This computer's addresses on the networks it is on. */
const networks = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n.family === "IPv4" && !n.internal);

/**
 * Starts the bundled server (desktop/server, built by build-server.js) with its library in the
 * app's data folder, and returns the process. `shared`: other devices on the network can reach
 * it; otherwise only this computer can.
 */
function startServer(port, shared) {
  const dir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server");
  const home = app.getPath("userData");
  // Electron's own binary, run as plain Node. Not a utility process: pdf.js only reads PDFs
  // when it finds itself in real Node, and takes a utility process for a browser.
  return spawn(process.execPath, [path.join(dir, "server.js")], {
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: shared ? "0.0.0.0" : "127.0.0.1",
      DATA_DIR: path.join(home, "data"),
      LIBRARY_DIR: path.join(home, "library"),
    },
  });
}

/** Where a newer version is fetched from by hand: the apps never install anything themselves. */
const DOWNLOAD = "https://clivingston33.github.io/sonnet/download.html";

// Whether to ask GitHub for the newest version. On unless it was turned off; kept apart from the
// choice of library, which is rewritten whole.
const prefsFile = () => path.join(app.getPath("userData"), "prefs.json");
function wantsUpdates() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8")).updates !== false;
  } catch {
    return true; // never chosen
  }
}
const setWantsUpdates = (on) => fs.writeFileSync(prefsFile(), JSON.stringify({ updates: !!on }));

/**
 * The newest release's version, e.g. "0.2.0", when it is newer than this app; otherwise null,
 * as it is when the check is off or GitHub doesn't answer. One request, and nothing is sent in it.
 */
async function newerVersion() {
  if (!wantsUpdates()) return null;
  try {
    const res = await net.fetch("https://api.github.com/repos/clivingston33/sonnet/releases/latest", {
      signal: AbortSignal.timeout(8000),
    });
    const latest = String((await res.json()).tag_name).replace(/^v/, "");
    // Shown in the app's own pages, so only ever digits and dots.
    if (!/^\d+(\.\d+)*$/.test(latest)) return null;
    return latest.localeCompare(app.getVersion(), undefined, { numeric: true }) > 0 ? latest : null;
  } catch {
    return null;
  }
}

module.exports = { DOWNLOAD, isSonnet, networks, newerVersion, setWantsUpdates, startServer, wantsUpdates };
