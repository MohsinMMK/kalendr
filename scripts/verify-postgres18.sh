#!/usr/bin/env bash
set -euo pipefail

# A disposable acceptance database; never connects to the running clinic database.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_name="kalendr-pg18-acceptance-$$"
acceptance_dir="$(mktemp -d)"
acceptance_port=5545
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$acceptance_dir"
}
trap cleanup EXIT
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'OpenSSL is required.' >&2; exit 1; }
umask 077
admin_password="$(openssl rand -hex 32)"
owner_password="$(openssl rand -hex 32)"
runtime_password="$(openssl rand -hex 32)"
worker_password="$(openssl rand -hex 32)"
auth_secret="$(openssl rand -hex 32)"
printf 'POSTGRES_PASSWORD=%s\n' "$admin_password" > "$acceptance_dir/postgres.env"
docker run --rm --name "$container_name" --env-file "$acceptance_dir/postgres.env" \
  -p "127.0.0.1:$acceptance_port:5432" -d postgres:18.6 > "$acceptance_dir/container-id"
ready=false
for attempt in {1..40}; do
  if docker exec "$container_name" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Acceptance database did not become ready.' >&2; exit 1; }
docker exec -i "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres >/dev/null <<SQL
CREATE ROLE kalendr_local_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '$owner_password';
CREATE ROLE kalendr_local_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$runtime_password';
CREATE ROLE kalendr_local_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$worker_password';
CREATE DATABASE kalendr_local OWNER kalendr_local_owner;
SQL
owner_url="postgresql://kalendr_local_owner:$owner_password@127.0.0.1:$acceptance_port/kalendr_local"
runtime_url="postgresql://kalendr_local_app:$runtime_password@127.0.0.1:$acceptance_port/kalendr_local"
worker_url="postgresql://kalendr_local_worker:$worker_password@127.0.0.1:$acceptance_port/kalendr_local"
cd "$project_root"
DATABASE_URL="$owner_url" pnpm db:migrate
docker exec -i "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres -d kalendr_local >/dev/null <<'SQL'
REVOKE CONNECT ON DATABASE kalendr_local FROM PUBLIC;
GRANT CONNECT ON DATABASE kalendr_local TO kalendr_local_owner, kalendr_local_app, kalendr_local_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kalendr_local_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kalendr_local_app;
REVOKE UPDATE, DELETE ON TABLE audit_events FROM kalendr_local_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kalendr_local_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kalendr_local_app;
REVOKE EXECUTE ON FUNCTION kalendr_claim_outbox(text, integer), kalendr_outbox_health(),
  kalendr_worker_tenants(text), kalendr_workflow_tenants(text), kalendr_storage_tenants(text), kalendr_storage_health(), kalendr_calendar_tenants(text), kalendr_import_tenants(), kalendr_payment_tenants(text), kalendr_offers_tenants(text), kalendr_crm_tenants(text), kalendr_campaign_tenants(text),
  kalendr_erase_consent_records(text, text), kalendr_scrub_audit_personal(text, text[]),
  kalendr_claim_code_deliveries(text, integer), kalendr_finish_code_delivery(text, text, text, text),
  kalendr_breach_affected(timestamptz, timestamptz), kalendr_admin_audit(text, text, text, text, jsonb), kalendr_admin_require(text, text[]), kalendr_admin_role(text), kalendr_billing_tenants(), kalendr_domain_tenants(), kalendr_onboarding_tenants(), kalendr_next_platform_invoice_number(), kalendr_staff_digest_tenants(), kalendr_owner_summary_tenants(), kalendr_email_domain_tenants(), kalendr_keep_one_owner() FROM kalendr_local_app;
GRANT USAGE ON SCHEMA public TO kalendr_local_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kalendr_local_worker;
REVOKE UPDATE, DELETE ON TABLE audit_events FROM kalendr_local_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kalendr_local_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kalendr_local_worker;
GRANT USAGE, CREATE ON SCHEMA kalendr_jobs TO kalendr_local_worker;
SQL
KALENDR_SEED_DATABASE_URL="$owner_url" KALENDR_CHECK_DATABASE_URL="$runtime_url" node scripts/seed-local-db.mjs
NODE_ENV=development DATABASE_URL="$runtime_url" KALENDR_TEST_OWNER_URL="$owner_url" \
  WORKER_DATABASE_URL="$worker_url" \
  BETTER_AUTH_SECRET="$auth_secret" BETTER_AUTH_URL=http://localhost:3101 \
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION=false KALENDR_ALLOW_CLINIC_REGISTRATION=true \
  KALENDR_PREVIEW_MODE=false pnpm test --no-file-parallelism src/server/appointment-repository.integration.test.ts src/server/booking-sources.integration.test.ts src/server/patient-records.integration.test.ts src/server/rate-limit.integration.test.ts \
  src/worker/outbox-worker.integration.test.ts src/worker/email-delivery.integration.test.ts src/worker/storage-jobs.integration.test.ts src/server/queue-door.integration.test.ts \
  src/server/workflows/workflows.integration.test.ts src/server/workflows/service.integration.test.ts src/server/video/video.integration.test.ts src/server/staff-second-factor.integration.test.ts \
  src/server/privacy/privacy.integration.test.ts src/server/privacy/privacy-erasure.integration.test.ts src/server/privacy/privacy-worker.integration.test.ts \
  src/server/staff-alerts.integration.test.ts src/server/patient-sign-in.integration.test.ts src/server/calendar-sync.integration.test.ts src/server/series.integration.test.ts src/server/payments/payments.integration.test.ts \
  src/server/waitlist-offers.integration.test.ts src/server/waitlist-staff.integration.test.ts src/server/approval.integration.test.ts src/server/cancel-policy.integration.test.ts src/server/bookings-list.integration.test.ts src/server/slot-engine \
  src/server/api-v1.integration.test.ts src/server/api-keys-admin.integration.test.ts src/worker/webhooks.integration.test.ts \
  src/server/imports/imports.integration.test.ts src/server/imports/imports-bookings.integration.test.ts \
  src/server/spam.integration.test.ts src/server/special-links.integration.test.ts src/server/service-templates.integration.test.ts src/server/calendar-wording.integration.test.ts
printf 'PostgreSQL 18.6 migration, runtime isolation, appointment, worker, email, protected-storage and rate-limit integration acceptance passed.\n'
