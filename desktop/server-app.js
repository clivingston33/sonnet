/**
 * Sonnet Server: the library for a household, as Jellyfin Server is for films. It has no window.
 * It runs the server for every device on the network, sits in the system tray, and is used from a
 * browser or from the Sonnet app on any of those devices, this computer included.
 */
const { app, Menu, Tray, clipboard, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { DOWNLOAD, isSonnet, networks, newerVersion, setWantsUpdates, startServer, wantsUpdates } = require("./local-server");

app.setName("Sonnet Server"); // its own data folder, apart from the Sonnet app's private library
// One below the Sonnet app's private library (main.js), so both can run on one computer.
const PORT = 38916;
const HERE = `http://localhost:${PORT}`;
let tray;
let server = null;
let quitting = false;
/** A version newer than this one, once GitHub has been asked; null when there is none. */
let update = null;

function run() {
  server = startServer(PORT, true);
  // It should always be there: started again if it ever stops by itself.
  server.on("exit", () => {
    server = null;
    if (!quitting) setTimeout(run, 2000);
  });
}

function menu() {
  const login = app.getLoginItemSettings().openAtLogin;
  const told = wantsUpdates();
  return Menu.buildFromTemplate([
    ...(update
      ? [{ label: `Version ${update} Is Available…`, click: () => shell.openExternal(DOWNLOAD) }, { type: "separator" }]
      : []),
    { label: "Open Sonnet", click: () => shell.openExternal(HERE) },
    { type: "separator" },
    { label: "Other devices connect to:", enabled: false },
    // Click to copy: these are typed into a browser or the Sonnet app elsewhere.
    ...networks().map((n) => {
      const address = `http://${n.address}:${PORT}`;
      return { label: address, click: () => clipboard.writeText(address) };
    }),
    { type: "separator" },
    {
      label: "Start When I Sign In",
      type: "checkbox",
      checked: login,
      click: () => app.setLoginItemSettings({ openAtLogin: !login }),
    },
    {
      label: "Tell Me About New Versions",
      type: "checkbox",
      checked: told,
      click: async () => {
        setWantsUpdates(!told);
        update = await newerVersion();
      },
    },
    { label: "Quit Sonnet Server", click: () => app.quit() },
  ]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => shell.openExternal(HERE)); // opened again: show the library
  app.on("before-quit", () => (quitting = true));
  app.on("quit", () => server?.kill());
  app.whenReady().then(async () => {
    app.dock?.hide(); // macOS: a menu bar item only
    const fresh = !fs.existsSync(path.join(app.getPath("userData"), "data", "library.db"));
    run();
    newerVersion().then((version) => (update = version));
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
    tray.setToolTip("Sonnet Server");
    // Built when it is opened, so the addresses and the tick are current.
    const show = () => tray.popUpContextMenu(menu());
    tray.on("click", show);
    tray.on("right-click", show);
    // A new server opens its own setup in the browser; after that it starts quietly.
    if (!fresh) return;
    for (let tries = 0; tries < 60; tries++) {
      if (await isSonnet(HERE)) return shell.openExternal(HERE);
      await new Promise((done) => setTimeout(done, 250));
    }
  });
}
