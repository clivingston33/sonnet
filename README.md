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

Forgotten passwords: the server sends no email. "Forgot password?" creates an 8-digit code,
valid for 30 minutes, that the admin sees under Settings → Account and that is printed to the
server log (`Password reset code for …`). An admin who is locked out reads it from the log.
The admin can also set anyone's password under Settings → Account. Eight wrong passwords lock
an account for 15 minutes.

Online data needs no keys: Open Library (books, covers, ratings, genres), Wikidata (series),
Audible's public catalogue (audiobook narrators and series) and AniList (manga and manhwa).
Adult manga (hentai) is never shown: AniList flags it and it is always excluded. Books are not
filtered, and neither is anything you upload.
Reviews are written by the people on the server and stored in its database.

Profiles: one sign-in can hold up to 8 profiles (Settings → Account), each with its own shelves,
progress and stats, chosen from a "Who's reading?" screen. A profile may set a PIN; signing in
with the account password always opens the account's own profile.

With Docker: `docker compose up --build`.

Home server: the app runs in Proxmox container 105 (`sonnet`, 192.0.2.10, systemd unit
`books.service`, port 3000), with code in `/opt/books` and data in `/srv/books` (on the host:
`/mnt/data/books`). Like Jellyfin, it is published by adding a public hostname to the
existing Cloudflare tunnel: `sonnet.example.com` → `http://192.0.2.10:3000`.
`./deploy.sh` sends the committed code there, rebuilds and restarts.
Cloudflare caps uploads at 100 MB on the free plan, so larger files (audiobooks) have to be
imported from the home network address.

## Data

| Folder | Holds | Setting |
| --- | --- | --- |
| `data/` | `library.db` (accounts, shelves, ratings, progress, reading time) and cover images | `DATA_DIR` |
| `library/` | the imported book and audio files | `LIBRARY_DIR` |

Back up both. Settings → Library → Download Backup (admin) gives one zip of the database and
covers, and Restore puts one back; the book files in `library/` are not in it and are copied
by hand. Importing a file that is already there is skipped, and Tidy Now re-files older books
with the current rules. `MAX_UPLOAD_MB` caps a single upload (default 2048).

Sharing: shared shelves, recommendations between people and a "what others are reading" list
on Home. A profile can turn off sharing its reading under Settings → Account.

Offline reading: the app installs to a phone or tablet's home screen, and the cloud button on a
book keeps it on the device (`public/sw.js`, `app/offline.ts`). Progress made offline is queued
and sent when the server is back. Browsers only allow this over HTTPS or on localhost, so put
the server behind HTTPS (a reverse proxy such as Caddy, or Tailscale) to use it from other
devices.

Books are shared by everyone on the server. Shelves, ratings, progress, bookmarks, highlights,
goals, reading time and any details a person edits (title, author, description, series, tags)
belong to that person's profile.

## Tests

```
node --test app/reading.test.ts app/sync.test.ts app/server/metadata.test.ts
```
