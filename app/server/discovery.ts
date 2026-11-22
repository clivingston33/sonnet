import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

/** UDP port the server listens on for the question below. The desktop app (desktop/main.js) asks it. */
const DISCOVERY_PORT = 38918;
const QUESTION = "Who is SonnetServer?";

const port = () => Number(process.env.PORT ?? 3000);
/** A server told to listen on this computer only (the desktop app's private library). */
const isPrivate = () => ["127.0.0.1", "localhost", "::1"].includes(process.env.HOSTNAME ?? "");

/** Where other devices on the network reach this server; none when it is private. */
export const lanAddresses = () =>
  isPrivate()
    ? []
    : Object.values(networkInterfaces())
        .flat()
        .filter((n) => n?.family === "IPv4" && !n.internal)
        .map((n) => `http://${n!.address}:${port()}`);

/**
 * Lets apps on the local network find this server, the way Jellyfin's do: they broadcast the
 * question and every server answers with its name and port. Being found is a convenience, so
 * any failure here (the port is taken, no network) is ignored.
 */
export function announce() {
  if (isPrivate()) return;
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", () => socket.close());
  socket.on("message", (message, from) => {
    if (message.toString() !== QUESTION) return;
    socket.send(JSON.stringify({ name: hostname(), port: port() }), from.port, from.address);
  });
  socket.bind(DISCOVERY_PORT, () => socket.unref()); // never keeps the server alive by itself
}
