/** What the two desktop apps share: running the bundled server, and telling whether an address is a Sonnet server. */
const { app, net } = require("electron");
const { spawn } = require("node:child_process");
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

module.exports = { isSonnet, networks, startServer };
