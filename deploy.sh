#!/usr/bin/env bash
# Sends the committed code to the home server and restarts the app there.
# The app lives in Proxmox container 105 ("sonnet"): code in /opt/books, data in /srv/books.
set -euo pipefail
HOST=root@192.0.2.1
CT=105

git archive HEAD | ssh "$HOST" "pct exec $CT -- tar -x -C /opt/books"
ssh "$HOST" "pct exec $CT -- bash -c '
  set -e
  chown -R books:books /opt/books && cd /opt/books
  run() { runuser -u books -- env HOME=/opt/books NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/srv/books/data LIBRARY_DIR=/srv/books/library \"\$@\"; }
  run npm ci --no-audit --no-fund
  run npm run build
  systemctl restart books && sleep 3 && systemctl is-active books
'"
