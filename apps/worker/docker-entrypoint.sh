#!/bin/sh
# Entrypoint image Reza AI: jalankan migrasi Prisma dulu (idempotent,
# aman bila beberapa container mulai bersamaan via advisory lock),
# lalu exec CMD aslinya.
set -e

PRISMA_SCHEMA="/app/packages/core/prisma/schema.prisma"

if [ -f "$PRISMA_SCHEMA" ] && [ -n "${DATABASE_URL:-}" ]; then
  PRISMA_BIN="/app/node_modules/.bin/prisma"
  if [ ! -x "$PRISMA_BIN" ]; then
    PRISMA_BIN="$(find /app/node_modules/.pnpm -maxdepth 4 -path '*/node_modules/prisma/build/index.js' 2>/dev/null | head -1)"
  fi
  if [ -n "$PRISMA_BIN" ]; then
    echo "[entrypoint] prisma migrate deploy..."
    node "$PRISMA_BIN" migrate deploy --schema "$PRISMA_SCHEMA"
  else
    echo "[entrypoint] prisma CLI tidak ditemukan — lewati migrasi."
  fi
else
  echo "[entrypoint] lewati migrasi (schema/DATABASE_URL tidak ada)."
fi

exec "$@"
