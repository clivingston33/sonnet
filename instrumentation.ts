/** Runs once when the server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Imported here, not at the top: this file is also built for the edge runtime, which has no UDP.
  (await import("./app/server/discovery")).announce();

  // A public demo starts with its books in place and its admin seat taken, by an account
  // nobody can sign in to: otherwise the first visitor would become the admin.
  const { DEMO, db } = await import("./app/server/db");
  if (!DEMO) return;
  if (!db.prepare("SELECT 1 FROM users WHERE admin = 1").get())
    db.prepare("INSERT INTO users (first, username, password, admin) VALUES ('Demo', 'admin', ?, 1)").run(
      (await import("./app/server/auth")).hashPassword(crypto.randomUUID()),
    );
  const { addFolder, scan } = await import("./app/server/folders");
  await addFolder(DEMO); // refused when it is already there, which is fine
  scan();
}
