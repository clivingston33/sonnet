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

Online data needs no keys: Open Library (books, covers, ratings, genres), Wikidata (series),
Audible's public catalogue (audiobook narrators and series) and AniList (manga and manhwa).
18+ titles are filtered out of search and recommendations; uploads are never filtered.
Reviews are written by the people on the server and stored in its database.

Profiles: one sign-in can hold up to 8 profiles (Settings → Account), each with its own shelves,
progress and stats, chosen from a "Who's reading?" screen. Profiles have no password of their own.

With Docker (not yet tested): `docker compose up --build`.

## Data

| Folder | Holds | Setting |
| --- | --- | --- |
| `data/` | `library.db` (accounts, shelves, ratings, progress, reading time) and cover images | `DATA_DIR` |
| `library/` | the imported book and audio files | `LIBRARY_DIR` |

Back up both. `MAX_UPLOAD_MB` caps a single upload (default 2048).

Books and their metadata are shared by everyone on the server. Shelves, ratings, progress,
bookmarks, highlights, goals and reading time belong to each account.

## Tests

```
node --test app/reading.test.ts app/sync.test.ts app/server/metadata.test.ts
```
