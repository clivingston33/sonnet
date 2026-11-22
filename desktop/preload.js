const { contextBridge, ipcRenderer } = require("electron");

// Seen by the connect page and by the server's pages (app/page.tsx shows "Change Library" when it exists).
contextBridge.exposeInMainWorld("sonnetDesktop", {
  // These two resolve to an error message, or null when the library is being opened. Connect page only.
  connect: (address) => ipcRenderer.invoke("connect", address),
  /** `shared`: other devices on the network can connect to this computer's library too. */
  useLocal: (shared) => ipcRenderer.invoke("use-local", !!shared),
  changeServer: () => ipcRenderer.send("change-server"),
});
