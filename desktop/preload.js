const { contextBridge, ipcRenderer } = require("electron");

// Seen by the connect page and by the server's pages (app/page.tsx shows "Change Library" when it exists).
contextBridge.exposeInMainWorld("sonnetDesktop", {
  // These two resolve to an error message, or null when the library is being opened. Connect page only.
  connect: (address) => ipcRenderer.invoke("connect", address),
  /** `shared`: other devices on the network can connect to this computer's library too. */
  useLocal: (shared) => ipcRenderer.invoke("use-local", !!shared),
  /** Connect page only: the Sonnet servers found on the network, as `{ name, url }`. */
  discover: () => ipcRenderer.invoke("discover"),
  changeServer: () => ipcRenderer.send("change-server"),
  /** Connect page only: whether to say when a newer version is out. Call with true or false to change it. */
  updates: (on) => ipcRenderer.invoke("updates", on),
  // Only on pages of this computer's own library, whose folders the system dialog can choose.
  ...(ipcRenderer.sendSync("is-local") && { pickFolder: () => ipcRenderer.invoke("pick-folder") }),
});
