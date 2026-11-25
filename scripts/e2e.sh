#!/usr/bin/env bash
set -euo pipefail

# Runs the browser tests on this machine the way CI does: a disposable PostgreSQL 18
# container, a fresh database seeded with the sample businesses, a production build,
# and Playwright against `next start`. Never touches .local-db or any other database.
#
#   scripts/e2e.sh                      build, then run every journey on desktop and phone
#   KALENDR_E2E_SKIP_BUILD=1 scripts/e2e.sh --project=desktop   reuse the last build
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_name="kalendr-e2e-$$"
port="${KALENDR_E2E_PORT:-5546}"
cleanup() { docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'OpenSSL is required.' >&2; exit 1; }

admin_password="$(openssl rand -hex 24)"
docker run --rm --name "$container_name" -e POSTGRES_PASSWORD="$admin_password" \
  -p "127.0.0.1:$port:5432" -d postgres:18.6 >/dev/null
for _ in {1..40}; do
  docker exec "$container_name" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
# pg_isready answers during the image's first-start restart; wait for a real login.
for _ in {1..20}; do
  docker exec "$container_name" psql -U postgres -Atc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

cd "$project_root"
KALENDR_E2E_ADMIN_URL="postgresql://postgres:$admin_password@127.0.0.1:$port/postgres" node scripts/e2e-database.mjs
# Its own build folder, so a run never writes into the .next a running dev server uses. (Once, during a run, an open dev page
# reloaded in a loop until the dev server restarted; the exact trigger was not pinned down.)
export KALENDR_NEXT_DIST_DIR="${KALENDR_NEXT_DIST_DIR:-.next-e2e}"
if [[ "${KALENDR_E2E_SKIP_BUILD:-}" != 1 ]]; then pnpm build; fi
pnpm exec playwright test "$@"
