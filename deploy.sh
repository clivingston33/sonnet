#!/usr/bin/env bash
# Sends the committed code to the home server and restarts the app there.
# The app lives in Proxmox container 105 ("sonnet"): code in /opt/books, data in /srv/books.
# DEPLOY_CT=106 is the public demo ("sonnet-demo"), which runs in demo mode with its own books.
set -euo pipefail
HOST=${DEPLOY_HOST:?set DEPLOY_HOST to the Proxmox host, e.g. root@proxmox.lan}
CT=${DEPLOY_CT:-105}

# The source folders are replaced, not overwritten, so files deleted from the repo go away too.
git archive HEAD | ssh "$HOST" "pct exec $CT -- bash -c 'rm -rf /opt/books/app /opt/books/public && tar -x -C /opt/books'"
ssh "$HOST" "pct exec $CT -- bash -c '
  set -e
  chown -R books:books /opt/books && cd /opt/books
  run() { runuser -u books -- env HOME=/opt/books NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/srv/books/data LIBRARY_DIR=/srv/books/library \"\$@\"; }
  run npm ci --no-audit --no-fund
  run npm run build
  systemctl restart books && sleep 3 && systemctl is-active books
'"
