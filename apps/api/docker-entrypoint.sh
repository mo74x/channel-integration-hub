#!/bin/sh
set -e

# Run Prisma database migrations if DATABASE_URL is defined
if [ -n "$DATABASE_URL" ]; then
  echo "==> Running Prisma migration deploy..."
  MAX_RETRIES=15
  RETRY_COUNT=0
  until pnpm --filter @cih/database migrate:deploy || [ $RETRY_COUNT -eq $MAX_RETRIES ]; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for PostgreSQL to be ready (attempt $RETRY_COUNT/$MAX_RETRIES)..."
    sleep 2
  done

  if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "❌ PostgreSQL was not reachable after $MAX_RETRIES attempts. Exiting."
    exit 1
  fi
  echo "==> Prisma migrations applied successfully."
fi

exec "$@"
