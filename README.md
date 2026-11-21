# Library

A self-hosted library for ebooks, audiobooks and PDFs.

## Run

```
npm install
npm run build
npm start            # http://localhost:3000
```

The first account created becomes the admin. Other people create their own accounts from the
sign-in page until the admin turns that off under Settings → Account. Requires Node 24 (it
uses the built-in `node:sqlite`).

The sign-in page offers "Continue without an account" (a shared guest) in development, and in
production only when `AUTH_BYPASS=1` is set. Leave it unset on a real server.

Forgotten passwords: the server sends no email. "Forgot password?" creates an 8-digit code,
valid for 30 minutes, that the admin sees under Settings → Account and that is printed to the
server log (`Password reset code for …`). An admin who is locked out reads it from the log.
The admin can also set anyone's password under Settings → Account. Eight wrong passwords lock
an account for 15 minutes.

Online data needs no keys: Open Library (books, covers, ratings, genres), Wikidata (series),
Audible's public catalogue (audiobook narrators and series) and AniList (manga and manhwa).
18+ titles are left out of search and recommendations unless a profile turns on "Show 18+
suggestions" (Settings → Online); uploads are never filtered.
Reviews are written by the people on the server and stored in its database.

Profiles: one sign-in can hold up to 8 profiles (Settings → Account), each with its own shelves,
progress and stats, chosen from a "Who's reading?" screen. A profile may set a PIN; signing in
with the account password always opens the account's own profile.

With Docker: `docker compose up --build` (the image has not been built yet; see the Dockerfile).

## Data

| Folder | Holds | Setting |
| --- | --- | --- |
| `data/` | `library.db` (accounts, shelves, ratings, progress, reading time) and cover images | `DATA_DIR` |
| `library/` | the imported book and audio files | `LIBRARY_DIR` |

Back up both. Settings → Library → Download Backup (admin) gives one zip of the database and
covers, and Restore puts one back; the book files in `library/` are not in it and are copied
by hand. Importing a file that is already there is skipped, and Tidy Now re-files older books
with the current rules. `MAX_UPLOAD_MB` caps a single upload (default 2048).

Books and their metadata are shared by everyone on the server. Shelves, ratings, progress,
bookmarks, highlights, goals and reading time belong to each account.

## Tests

```
node --test app/reading.test.ts app/sync.test.ts app/server/metadata.test.ts
```
