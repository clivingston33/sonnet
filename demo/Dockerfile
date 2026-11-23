# The public demo: the published server plus a library of public-domain books, in demo mode
# (SONNET_DEMO, see app/server/db.ts). Build with this folder as the context: `docker build demo`.
FROM ghcr.io/clivingston33/sonnet:latest
COPY fetch.mjs demo/fetch.mjs
RUN node demo/fetch.mjs
# Accounts and progress live in /tmp, so every restart of the container starts the demo afresh.
ENV SONNET_DEMO=/app/demo/books DATA_DIR=/tmp/data LIBRARY_DIR=/tmp/library
