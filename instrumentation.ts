/** Runs once when the server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Imported here, not at the top: this file is also built for the edge runtime, which has no UDP.
  (await import("./app/server/discovery")).announce();
}
