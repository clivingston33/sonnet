/**
 * The desktop app shows a Sonnet server's own interface in a window. Which server is the one choice
 * it asks for, on first launch:
 *  - this computer: it runs its own copy of the server (desktop/server, built by build-server.js)
 *    with the library kept in the app's data folder. Only this computer can reach it, unless it is
 *    told to host, and then other devices on the network can connect to it as to any server;
 *  - or, like Jellyfin's app, a server somewhere else, by its address.
 */
const { app, BrowserWindow, Menu, WebContentsView, ipcMain, nativeTheme, net, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 3000; // what `npm start` and compose.yaml serve on
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
 * Where other devices reach this computer's server while it is hosting; "" with no network.
 * ponytail: the first network address found; with a VPN or several adapters it may be the wrong one.
 */
function lanAddress() {
  const net4 = Object.values(os.networkInterfaces())
    .flat()
    .find((n) => n.family === "IPv4" && !n.internal);
  return net4 ? `http://${net4.address}:${LOCAL_PORT}` : "";
}

const showConnect = (error = "") =>
  view.webContents.loadFile(path.join(__dirname, "connect.html"), {
    query: { error, url: config.url ?? "", lan: lanAddress(), hosting: config.shared ? "1" : "" },
  });

const isSonnet = async (origin) => {
  try {
    const res = await net.fetch(`${origin}/manifest.webmanifest`, { signal: AbortSignal.timeout(8000) });
    return (await res.json()).name === "Sonnet";
  } catch {
    return false;
  }
};

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
    const dir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server");
    const home = app.getPath("userData");
    // Electron's own binary, run as plain Node. Not a utility process: pdf.js only reads PDFs
    // when it finds itself in real Node, and takes a utility process for a browser.
    localServer = spawn(process.execPath, [path.join(dir, "server.js")], {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PORT: String(LOCAL_PORT),
        HOSTNAME: shared ? "0.0.0.0" : "127.0.0.1",
        DATA_DIR: path.join(home, "data"),
        LIBRARY_DIR: path.join(home, "library"),
      },
    });
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

/** Opens what `choice` names and remembers it. Returns what went wrong, or null once it is loading. */
async function open(choice) {
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

const local = (url) => url.startsWith("file:");

// Only the app's own connect page may choose the server; a server's page may only ask to leave.
ipcMain.handle("connect", (e, input) =>
  local(e.senderFrame.url) ? connect(String(input)) : "Not allowed.",
);
ipcMain.handle("use-local", (e, shared) =>
  local(e.senderFrame.url) ? open(shared ? { local: true, shared: true } : { local: true }) : "Not allowed.",
);
app.on("quit", () => localServer?.kill());
ipcMain.on("change-server", () => showConnect());

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
    nativeTheme.themeSource = "dark"; // dark title bar and menus, matching the app
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
