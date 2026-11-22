const form = document.querySelector("form");
const address = document.getElementById("address");
const error = document.getElementById("error");
const found = document.getElementById("found");

// main.js passes the server last used, why this page is showing again, and this computer's address.
const query = new URLSearchParams(location.search);
address.value = query.get("url") ?? "";
error.textContent = query.get("error") ?? "";
const lan = document.getElementById("lan");
lan.append(
  query.get("hosting") ? "Hosting now. " : "",
  "Your library stays on this computer, and other devices on your network can open it",
  query.get("lan") ? " at " : ".",
);
if (query.get("lan")) lan.append(Object.assign(document.createElement("b"), { textContent: query.get("lan") }), ".");

// Whether the app asks GitHub for the newest version when it opens. It never installs one itself.
const updates = document.querySelector("#updates input");
window.sonnetDesktop.updates().then((on) => (updates.checked = on));
updates.addEventListener("change", () => window.sonnetDesktop.updates(updates.checked));

/** Runs one of the choices; on success the window is already loading the library. */
async function go(button, busy, action) {
  const label = button.textContent;
  const buttons = document.querySelectorAll("button");
  for (const b of buttons) b.disabled = true;
  button.textContent = busy;
  error.textContent = "";
  const failed = await action();
  if (!failed) return;
  error.textContent = failed;
  button.textContent = label;
  for (const b of buttons) b.disabled = false;
}

// Servers that answer on the network get a button each, above the field for typing an address.
window.sonnetDesktop.discover().then((servers) => {
  if (!servers.length) return;
  found.append(Object.assign(document.createElement("label"), { textContent: "Found on your network" }));
  for (const { name, url } of servers) {
    const button = Object.assign(document.createElement("button"), {
      type: "button",
      textContent: `${name} · ${url.replace(/^http:\/\//, "")}`,
    });
    button.addEventListener("click", () => go(button, "Connecting…", () => window.sonnetDesktop.connect(url)));
    found.append(button);
  }
});

document.getElementById("local").addEventListener("click", (e) =>
  go(e.currentTarget, "Opening…", () => window.sonnetDesktop.useLocal()),
);
document.getElementById("host").addEventListener("click", (e) =>
  go(e.currentTarget, "Starting…", () => window.sonnetDesktop.useLocal(true)),
);
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!address.value.trim()) return void (error.textContent = "Enter your server’s address.");
  go(document.getElementById("connect"), "Connecting…", () => window.sonnetDesktop.connect(address.value));
});
