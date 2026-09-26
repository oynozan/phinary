#!/bin/sh
set -eu
: "${DATABASE_URL:?Set DATABASE_URL to the Railway Postgres private connection string}"
: "${RAILWAY_DEPLOYMENT_ID:?A Railway deployment ID is required for the Ponder schema}"
if [ -n "${PONDER_PGLITE_DIR:-}" ]; then
  echo 'Unset PONDER_PGLITE_DIR: production must use persistent Postgres.' >&2
  exit 1
fi
exec node node_modules/ponder/dist/esm/bin/ponder.js start \
  --hostname :: --port "${PORT:-42069}" --schema "$RAILWAY_DEPLOYMENT_ID"
