// The release step: applies every pending migration as the owner role, then gives the
// runtime role (the web app) and the worker role what they need on the tables and functions
// the migrations created. The web app and worker never run migrations and never connect as
// the owner. Neither role has BYPASSRLS. Only the worker may call the three cross-business
// definer functions, and those return ids and counts only.
//
//   DATABASE_OWNER_URL=postgres://owner…  KALENDR_RUNTIME_ROLE=kalendr_app \
//   KALENDR_WORKER_ROLE=kalendr_worker  node dist/migrate.mjs
//
// One-time provisioning (the roles, CONNECT, schema USAGE, REVOKE CREATE) is in
// docs/OPERATIONS.md; it needs a superuser and is not repeated on every release.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ownerUrl = process.env.DATABASE_OWNER_URL;
const runtimeRole = process.env.KALENDR_RUNTIME_ROLE ?? "kalendr_app";
const workerRole = process.env.KALENDR_WORKER_ROLE ?? "kalendr_worker";
if (!ownerUrl) {
  console.error("DATABASE_OWNER_URL is not set. Migrations run as the database owner role.");
  process.exit(1);
}
for (const [name, role] of [["KALENDR_RUNTIME_ROLE", runtimeRole], ["KALENDR_WORKER_ROLE", workerRole]]) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    console.error(`${name} must be a plain lower-case role name.`);
    process.exit(1);
  }
}

// The folder sits next to this file in the image (dist/../drizzle) and in the repository (scripts/../drizzle).
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = [resolve(here, "../drizzle"), resolve(here, "drizzle")].find((folder) => existsSync(folder));
if (!migrationsFolder) {
  console.error("No drizzle/ migrations folder found next to the migrate script.");
  process.exit(1);
}

const sql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
const started = Date.now();
try {
  await migrate(drizzle(sql), { migrationsFolder });
  await sql.unsafe(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole};
    REVOKE UPDATE, DELETE ON TABLE audit_events FROM ${runtimeRole};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${runtimeRole};
    REVOKE EXECUTE ON FUNCTION kalendr_claim_outbox(text, integer), kalendr_outbox_health(),
      kalendr_worker_tenants(text), kalendr_workflow_tenants(text), kalendr_storage_tenants(text), kalendr_storage_health(), kalendr_calendar_tenants(text), kalendr_payment_tenants(text), kalendr_offers_tenants(text), kalendr_crm_tenants(text), kalendr_campaign_tenants(text), kalendr_import_tenants(),
      kalendr_erase_consent_records(text, text), kalendr_scrub_audit_personal(text, text[]),
      kalendr_claim_code_deliveries(text, integer), kalendr_finish_code_delivery(text, text, text, text),
      kalendr_breach_affected(timestamptz, timestamptz), kalendr_admin_audit(text, text, text, text, jsonb), kalendr_admin_require(text, text[]), kalendr_admin_role(text), kalendr_billing_tenants(), kalendr_domain_tenants(), kalendr_onboarding_tenants(), kalendr_next_platform_invoice_number(), kalendr_staff_digest_tenants(), kalendr_owner_summary_tenants(), kalendr_email_domain_tenants(), kalendr_keep_one_owner() FROM ${runtimeRole};
  `);
  const [workerExists] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${workerRole}`;
  if (workerExists) {
    await sql.unsafe(`
      GRANT USAGE ON SCHEMA public TO ${workerRole};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${workerRole};
      REVOKE UPDATE, DELETE ON TABLE audit_events FROM ${workerRole};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${workerRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${workerRole};
      GRANT USAGE, CREATE ON SCHEMA kalendr_jobs TO ${workerRole};
    `);
  } else {
    console.warn(`Role ${workerRole} does not exist yet; the worker gets no grants. See docs/OPERATIONS.md.`);
  }
  const [{ version }] = await sql`SELECT kalendr_schema_version() AS version`;
  console.log(`Migrations applied in ${Date.now() - started} ms; schema version ${version}.`);
} catch (error) {
  // The message names the failing statement; it never holds row data.
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
