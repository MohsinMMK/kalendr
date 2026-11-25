#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
local_root="$project_root/.local-db"
data_dir="$local_root/data"
socket_dir="$local_root/socket"
log_file="$local_root/postgres.log"
credentials_file="$local_root/database.env"
runtime_file="$local_root/runtime.env"
cluster_marker="$local_root/kalendr-local-cluster"
cluster_marker_value="kalendr-local-cluster-v1"
port=5544
database_name=kalendr_local
admin_role=kalendr_local_admin
owner_role=kalendr_local_owner
runtime_role=kalendr_local_app
# The outbox worker's role: no BYPASSRLS, and the only role that may call the worker's
# cross-business definer functions. Added after the Nira rename, so every cluster uses this name.
worker_role=kalendr_local_worker

# Legacy cluster: the product was called Nira before it became Kalendr. A .local-db made
# then has a nira-local-cluster marker, nira_local_* roles and a nira_local database, and
# its env files use NIRA_* keys. Keep using those names for that cluster so the owner's
# data stays reachable; nothing inside .local-db is renamed or moved. New clusters get the
# Kalendr names. This is the one place the old name is meant to remain in the code.
legacy_marker="$local_root/nira-local-cluster"
if [[ ! -f "$cluster_marker" ]] && [[ -f "$legacy_marker" ]]; then
  cluster_marker="$legacy_marker"
  cluster_marker_value="nira-local-cluster-v1"
  database_name=nira_local
  admin_role=nira_local_admin
  owner_role=nira_local_owner
  runtime_role=nira_local_app
fi

# Reads a legacy cluster's NIRA_* keys under their Kalendr names.
use_legacy_keys() {
  KALENDR_LOCAL_OWNER_PASSWORD="${KALENDR_LOCAL_OWNER_PASSWORD:-${NIRA_LOCAL_OWNER_PASSWORD:-}}"
  KALENDR_LOCAL_APP_PASSWORD="${KALENDR_LOCAL_APP_PASSWORD:-${NIRA_LOCAL_APP_PASSWORD:-}}"
  KALENDR_LOCAL_AUTH_SECRET="${KALENDR_LOCAL_AUTH_SECRET:-${NIRA_LOCAL_AUTH_SECRET:-}}"
  KALENDR_ALLOW_CLINIC_REGISTRATION="${KALENDR_ALLOW_CLINIC_REGISTRATION:-${NIRA_ALLOW_CLINIC_REGISTRATION:-}}"
  KALENDR_PREVIEW_MODE="${KALENDR_PREVIEW_MODE:-${NIRA_PREVIEW_MODE:-}}"
}

# Homebrew installs versioned PostgreSQL "keg-only", so its tools are not on PATH. Use the installed
# version that matches the existing data directory, or the newest one for a new cluster.
if ! command -v pg_ctl >/dev/null 2>&1; then
  wanted_version=""
  [[ -f "$data_dir/PG_VERSION" ]] && wanted_version="$(cat "$data_dir/PG_VERSION")"
  for candidate in "$wanted_version" 18 17; do
    [[ -n "$candidate" ]] || continue
    for prefix in /opt/homebrew/opt /usr/local/opt; do
      if [[ -x "$prefix/postgresql@$candidate/bin/pg_ctl" ]]; then
        PATH="$prefix/postgresql@$candidate/bin:$PATH"
        break 2
      fi
    done
  done
  export PATH
fi
# The server refuses to start on macOS without a valid locale.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing command: $1" >&2; exit 1; }
}

assert_cluster_owned() {
  if [[ ! -f "$cluster_marker" ]] || [[ "$(cat "$cluster_marker")" != "$cluster_marker_value" ]]; then
    echo "Local database marker is missing or unrecognized; refusing to use $local_root" >&2
    exit 1
  fi
}

load_credentials() {
  [[ -f "$credentials_file" ]] || { echo "Local database credentials are missing; run start first." >&2; exit 1; }
  # Generated values contain only hexadecimal characters and fixed identifiers.
  # shellcheck disable=SC1090
  source "$credentials_file"
  use_legacy_keys
}

socket_psql() {
  psql -X -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -U "$admin_role" "$@"
}

is_running() {
  [[ -f "$data_dir/PG_VERSION" ]] && pg_ctl -D "$data_dir" status >/dev/null 2>&1
}

start_database() {
  require_command initdb
  require_command pg_ctl
  require_command psql
  require_command openssl
  umask 077
  if [[ -e "$local_root" ]] && [[ ! -f "$cluster_marker" ]]; then
    echo "Existing $local_root has no Kalendr marker; refusing to modify it." >&2
    exit 1
  fi
  mkdir -p "$local_root" "$socket_dir"
  chmod 700 "$local_root" "$socket_dir"
  if [[ ! -f "$cluster_marker" ]]; then
    printf '%s\n' "$cluster_marker_value" > "$cluster_marker"
  fi
  assert_cluster_owned
  if [[ ! -f "$data_dir/PG_VERSION" ]]; then
    [[ ! -e "$data_dir" ]] || { echo "Incomplete or foreign data directory; refusing to overwrite it." >&2; exit 1; }
    initdb -D "$data_dir" -U "$admin_role" --auth-local=trust --auth-host=scram-sha-256 --no-instructions > "$local_root/initdb.log" 2>&1 || {
      echo "PostgreSQL initialization failed; see $local_root/initdb.log" >&2
      exit 1
    }
  fi
  if [[ ! -f "$credentials_file" ]]; then
    local owner_password runtime_password auth_secret
    owner_password="$(openssl rand -hex 32)"
    runtime_password="$(openssl rand -hex 32)"
    auth_secret="$(openssl rand -hex 32)"
    {
      printf 'KALENDR_LOCAL_OWNER_PASSWORD=%s\n' "$owner_password"
      printf 'KALENDR_LOCAL_APP_PASSWORD=%s\n' "$runtime_password"
      printf 'KALENDR_LOCAL_AUTH_SECRET=%s\n' "$auth_secret"
    } > "$credentials_file"
    chmod 600 "$credentials_file"
  fi
  load_credentials
  if [[ -z "${KALENDR_LOCAL_WORKER_PASSWORD:-}" ]]; then
    KALENDR_LOCAL_WORKER_PASSWORD="$(openssl rand -hex 32)"
    printf 'KALENDR_LOCAL_WORKER_PASSWORD=%s\n' "$KALENDR_LOCAL_WORKER_PASSWORD" >> "$credentials_file"
  fi
  if ! is_running; then
    pg_ctl -D "$data_dir" -l "$log_file" -o "-h 127.0.0.1 -p $port -k '$socket_dir'" -w start >/dev/null || {
      echo "PostgreSQL startup failed; see $log_file" >&2
      exit 1
    }
  fi
  # Local socket access is restricted by the project directory. TCP logins
  # always use SCRAM authentication, including for the app's runtime role.
  if [[ "$(socket_psql -d postgres -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '$owner_role'")" == 0 ]]; then
    printf "CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '%s';\n" \
      "$owner_role" "$KALENDR_LOCAL_OWNER_PASSWORD" | socket_psql -d postgres >/dev/null
  fi
  if [[ "$(socket_psql -d postgres -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '$runtime_role'")" == 0 ]]; then
    printf "CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '%s';\n" \
      "$runtime_role" "$KALENDR_LOCAL_APP_PASSWORD" | socket_psql -d postgres >/dev/null
  fi
  if [[ "$(socket_psql -d postgres -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '$worker_role'")" == 0 ]]; then
    printf "CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '%s';\n" \
      "$worker_role" "$KALENDR_LOCAL_WORKER_PASSWORD" | socket_psql -d postgres >/dev/null
  fi
  if [[ "$(socket_psql -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '$database_name'")" == 0 ]]; then
    socket_psql -d postgres -c "CREATE DATABASE $database_name OWNER $owner_role" >/dev/null
  fi
  socket_psql -d "$database_name" -c "REVOKE CONNECT ON DATABASE $database_name FROM PUBLIC" >/dev/null
  socket_psql -d "$database_name" -c "GRANT CONNECT ON DATABASE $database_name TO $runtime_role, $worker_role" >/dev/null
  cat > "$runtime_file" <<EOF
DATABASE_URL=postgresql://$runtime_role:$KALENDR_LOCAL_APP_PASSWORD@127.0.0.1:$port/$database_name
WORKER_DATABASE_URL=postgresql://$worker_role:$KALENDR_LOCAL_WORKER_PASSWORD@127.0.0.1:$port/$database_name
BETTER_AUTH_SECRET=$KALENDR_LOCAL_AUTH_SECRET
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000
BETTER_AUTH_ALLOW_SIGNUP=false
BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION=false
KALENDR_ALLOW_CLINIC_REGISTRATION=true
KALENDR_PREVIEW_MODE=false
EOF
  chmod 600 "$runtime_file"
  echo "Kalendr local PostgreSQL is running on 127.0.0.1:$port (project data: .local-db/data)."
}

require_running() {
  assert_cluster_owned
  is_running || { echo "Kalendr local PostgreSQL is stopped; run start first." >&2; exit 1; }
  load_credentials
}

owner_url() {
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "$owner_role" "$KALENDR_LOCAL_OWNER_PASSWORD" "$port" "$database_name"
}

runtime_url() {
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "$runtime_role" "$KALENDR_LOCAL_APP_PASSWORD" "$port" "$database_name"
}

# The one-time provisioning that scripts/migrate.mjs leaves to the operator (docs/OPERATIONS.md).
# Table, sequence and function grants come from migrate.mjs itself, so the local cluster gets
# exactly the release grants: every function for the web app except the worker-only ones.
apply_provisioning() {
  socket_psql -d "$database_name" >/dev/null <<EOF
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $runtime_role;
GRANT USAGE ON SCHEMA public TO $worker_role;
EOF
}

case "${1:-}" in
  start)
    start_database
    ;;
  stop)
    assert_cluster_owned
    if is_running; then pg_ctl -D "$data_dir" -m fast -w stop >/dev/null; fi
    echo "Kalendr local PostgreSQL is stopped."
    ;;
  status)
    assert_cluster_owned
    if is_running; then echo "Kalendr local PostgreSQL is running on 127.0.0.1:$port."; else echo "Kalendr local PostgreSQL is stopped."; fi
    ;;
  migrate)
    require_running
    require_command pnpm
    apply_provisioning
    # The release migrate step: applies migrations as the owner, then grants the app and worker roles.
    (cd "$project_root" && DATABASE_OWNER_URL="$(owner_url)" KALENDR_RUNTIME_ROLE="$runtime_role" \
      KALENDR_WORKER_ROLE="$worker_role" node scripts/migrate.mjs)
    echo "Migrations applied and runtime privileges refreshed."
    ;;
  seed)
    require_running
    (cd "$project_root" && KALENDR_SEED_DATABASE_URL="$(owner_url)" KALENDR_CHECK_DATABASE_URL="$(runtime_url)" KALENDR_LOCAL_OWNER_ROLE="$owner_role" KALENDR_LOCAL_APP_ROLE="$runtime_role" node scripts/seed-local-db.mjs)
    ;;
  check)
    require_running
    (cd "$project_root" && KALENDR_SEED_DATABASE_URL="$(owner_url)" KALENDR_CHECK_DATABASE_URL="$(runtime_url)" KALENDR_LOCAL_OWNER_ROLE="$owner_role" KALENDR_LOCAL_APP_ROLE="$runtime_role" node scripts/seed-local-db.mjs --check)
    ;;
  run)
    require_running
    shift
    [[ $# -gt 0 ]] || { echo "Usage: scripts/local-db.sh run <command> [args...]" >&2; exit 1; }
    # shellcheck disable=SC1090
    source "$runtime_file"
    use_legacy_keys
    export DATABASE_URL WORKER_DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL BETTER_AUTH_TRUSTED_ORIGINS
    export BETTER_AUTH_ALLOW_SIGNUP BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION KALENDR_PREVIEW_MODE
    export KALENDR_ALLOW_CLINIC_REGISTRATION
    exec "$@"
    ;;
  *)
    echo "Usage: scripts/local-db.sh {start|stop|status|migrate|seed|check|run <command> [args...]}" >&2
    exit 2
    ;;
esac
