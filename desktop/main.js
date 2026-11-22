/**
 * Two apps are built from this folder, as Jellyfin has a server and a player:
 *  - Sonnet Server (server-app.js): the library for a household, run from the system tray;
 *  - Sonnet (this file): shows a library in a window. On first launch it asks which one: a
 *    private library on this computer, for which it runs its own copy of the server
 *    (desktop/server) that only this computer can reach unless told to host; or a Sonnet server
 *    somewhere else, found on the network or given by its address.
 */
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeTheme, shell } = require("electron");
const dgram = require("node:dgram");
const fs = require("node:fs");
const path = require("node:path");
const { isSonnet, networks, startServer } = require("./local-server");

// Which of the two this is: decided when it is built (server-build.json), or `--server` in development.
if (require("./package.json").sonnetServer || process.argv.includes("--server")) return require("./server-app");

const DEFAULT_PORT = 3000; // what `npm start` and compose.yaml serve on
const DISCOVERY_PORT = 38918; // app/server/discovery.ts answers there
// Sign-in, settings and downloaded books belong to an address, so the local one never changes.
// ponytail: one fixed port; pick and remember a free one if other software ever turns out to use it.
const LOCAL_PORT = 38917;
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;

const configFile = path.join(app.getPath("userData"), "server.json");
/** The choice made on the connect page: `{ local: true }`, `{ url: origin }`, or `{}` before there is one. */
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch {
  // first launch
}
/** Origin the window is showing, e.g. "http://192.168.1.20:3000". */
let server = null;
const BACKGROUND = "#1e1e1e"; // the page's own (app/globals.css)
const BAR = 32; // height of the strip at the top of the window that it is dragged by
let win;
/** Everything under that strip: the connect page or the server's interface. */
let view;
let localServer = null;

/**
 * Where other devices reach this computer's library while it is hosting; "" with no network.
 * ponytail: the first network address found; with a VPN or several adapters it may be the wrong one.
 */
function lanAddress() {
  const [first] = networks();
  return first ? `http://${first.address}:${LOCAL_PORT}` : "";
}

const showConnect = (error = "") =>
  view.webContents.loadFile(path.join(__dirname, "connect.html"), {
    query: { error, url: config.url ?? "", lan: lanAddress(), hosting: config.shared ? "1" : "" },
  });

/**
 * Starts this computer's own server, if it isn't running, and waits until it answers.
 * `shared`: other devices on the network can reach it too; otherwise only this computer can.
 */
async function localReady(shared) {
  if (localServer && localServer.shared !== shared) {
    // Listening on the wrong side: stop it, then start it again below.
    const old = localServer;
    await new Promise((done) => {
      old.once("exit", done);
      old.kill();
    });
  }
  if (!localServer) {
    if (await isSonnet(LOCAL)) return true; // one left running by a copy of the app that crashed
    localServer = startServer(LOCAL_PORT, shared);
    localServer.shared = shared;
    localServer.on("exit", () => (localServer = null));
    localServer.on("error", () => (localServer = null));
  }
  for (let tries = 0; tries < 60 && localServer; tries++) {
    if (await isSonnet(LOCAL)) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

/**
 * True for an address of this computer's own library. Nothing keeps that running but this app,
 * so it is opened as the local library, which starts it, and never as a server somewhere else.
 */
function mine(url) {
  const { hostname, port } = new URL(url);
  return (
    Number(port) === LOCAL_PORT && ["127.0.0.1", "localhost", ...networks().map((n) => n.address)].includes(hostname)
  );
}

/** Opens what `choice` names and remembers it. Returns what went wrong, or null once it is loading. */
async function open(choice) {
  if (choice.url && mine(choice.url)) choice = config.shared ? { local: true, shared: true } : { local: true };
  if (choice.local && !(await localReady(!!choice.shared)))
    return "The library on this computer couldn’t be started.";
  config = choice;
  server = choice.local ? LOCAL : choice.url;
  fs.writeFileSync(configFile, JSON.stringify(config));
  view.webContents.loadURL(server);
  return null;
}

/** The origins an address could mean: as typed, then on Sonnet's usual port if none was given. */
function candidates(input) {
  const url = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`);
  if (url.port || /^https:/i.test(input)) return [url.origin];
  return [url.origin, `${url.protocol}//${url.hostname}:${DEFAULT_PORT}`];
}

async function connect(input) {
  let origins;
  try {
    origins = candidates(input.trim());
  } catch {
    return "That isn’t a valid address.";
  }
  for (const origin of origins) if (await isSonnet(origin)) return open({ url: origin });
  return `No Sonnet server answered at ${origins[0]}. Check the address and that the server is running.`;
}

/**
 * The Sonnet servers on the local network, as `{ name, url }`. Asked the way Jellyfin's apps ask:
 * a broadcast that every server answers with its name and port.
 */
function discover() {
  return new Promise((done) => {
    const found = new Map();
    const socket = dgram.createSocket("udp4");
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      socket.close();
      // Not this computer's own library while it is hosting: that is "Use This Computer", not a server.
      done([...found.values()].filter((s) => !mine(s.url)));
    };
    socket.on("error", finish); // no network: nothing found
    socket.on("message", (message, from) => {
      try {
        const { name, port } = JSON.parse(message);
        const key = `${name}:${port}`;
        // A server on this computer answers on every address it has: keep the one that is it itself.
        if (found.has(key) && from.address !== "127.0.0.1") return;
        found.set(key, { name: String(name), url: `http://${from.address}:${Number(port)}` });
      } catch {
        // not an answer to the question
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      // Every network's own broadcast address: some routers drop the general one.
      const everyone = networks().map((n) => {
        const mask = n.netmask.split(".").map(Number);
        return n.address.split(".").map((part, i) => (Number(part) | (~mask[i] & 255)) >>> 0).join(".");
      });
      for (const to of new Set(["127.0.0.1", "255.255.255.255", ...everyone]))
        socket.send("Who is SonnetServer?", DISCOVERY_PORT, to, () => {});
      setTimeout(finish, 1200);
    });
  });
}

const local = (url) => url.startsWith("file:");
/** True for a page of this computer's own library: the only one that may ask about its disk. */
const fromLocalLibrary = (e) => !!config.local && e.senderFrame.url.startsWith(LOCAL);

// Only the app's own connect page may choose the server; a server's page may only ask to leave.
ipcMain.handle("connect", (e, input) =>
  local(e.senderFrame.url) ? connect(String(input)) : "Not allowed.",
);
ipcMain.handle("use-local", (e, shared) =>
  local(e.senderFrame.url) ? open(shared ? { local: true, shared: true } : { local: true }) : "Not allowed.",
);
ipcMain.handle("discover", (e) => (local(e.senderFrame.url) ? discover() : []));
ipcMain.on("change-server", () => showConnect());
// Library folders are on the server's disk. Here that is this computer, so the page can offer
// the system's folder dialog instead of a path to type.
ipcMain.on("is-local", (e) => (e.returnValue = fromLocalLibrary(e)));
ipcMain.handle("pick-folder", async (e) => {
  if (!fromLocalLibrary(e)) return null;
  const picked = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return picked.canceled ? null : picked.filePaths[0];
});
app.on("quit", () => localServer?.kill());

function createWindow() {
  // No title bar from the system: the top strip is the app's colour, with only the system's
  // window buttons drawn on it, so the window is one surface.
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: BACKGROUND, // so there is no white flash while it loads
    titleBarStyle: "hidden",
    titleBarOverlay: { color: BACKGROUND, symbolColor: "#f2f2f2", height: BAR },
  });
  // The window's own page is nothing but that strip. The pages get a view of their own below it:
  // drawn over them, it would cover the top of the sidebar and of the reader's toolbar.
  win.loadURL(
    `data:text/html,<body style="margin:0;background:${encodeURIComponent(BACKGROUND)};-webkit-app-region:drag">`,
  );
  view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "preload.js") } });
  view.setBackgroundColor(BACKGROUND);
  win.contentView.addChildView(view);
  const fit = () => {
    const [width, height] = win.getContentSize();
    const top = win.isFullScreen() ? 0 : BAR; // full screen has no window buttons
    view.setBounds({ x: 0, y: top, width, height: height - top });
  };
  fit();
  for (const change of ["resize", "enter-full-screen", "leave-full-screen"]) win.on(change, fit);
  win.on("focus", () => view.webContents.focus()); // typing goes to the page, not the strip
  const web = view.webContents;
  // Links that leave the server (a book's page on Open Library, say) open in the real browser.
  web.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  web.on("will-navigate", (e, url) => {
    if (!/^https?:/i.test(url) || new URL(url).origin === server) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  // The server is off or has moved: back to the connect page, with its address filled in to retry.
  web.on("did-fail-load", (_e, code, _text, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* aborted by a newer navigation */ && !local(url))
      showConnect(`${server} can’t be reached. Check that the server is running.`);
  });
  if (config.local || config.url) open(config).then((failed) => failed && showConnect(failed));
  else showConnect();
}

if (!app.requestSingleInstanceLock()) app.quit(); // two copies would fight over one sign-in
else {
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = "dark"; // dark menus, matching the app
    const mac = process.platform === "darwin";
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(mac ? [{ role: "appMenu" }] : []),
        {
          label: "Library",
          submenu: [
            { label: "Change Library…", click: () => showConnect() },
            { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => view.webContents.reload() },
            ...(mac ? [] : [{ type: "separator" }, { role: "quit" }]),
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "togglefullscreen" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    createWindow();
    app.on("activate", () => BrowserWindow.getAllWindows().length || createWindow());
  });
  app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
}
