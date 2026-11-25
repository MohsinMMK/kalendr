// Prepares a throwaway database for the browser tests: fresh owner and runtime roles,
// every migration, the runtime grants, and the sample businesses. It then writes
// .e2e/runtime.env, which playwright.config.ts reads to start the built app.
//
// KALENDR_E2E_ADMIN_URL must be a superuser on a disposable PostgreSQL 18 server on this
// machine (scripts/e2e.sh starts one in Docker; CI uses a service container). The
// database it creates is dropped and made again on every run. Never point it at a
// database that holds real data.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// KALENDR_E2E_NAME (letters and digits) lets several sessions share one scratch server, each with its own
// database, roles and state folder. Without it the names are the ones the browser tests have always used.
const nameSuffix = /^[a-z0-9]{1,12}$/.test(process.env.KALENDR_E2E_NAME ?? "") ? `_${process.env.KALENDR_E2E_NAME}` : "";
const stateDir = resolve(projectRoot, nameSuffix ? `.e2e-${nameSuffix.slice(1)}` : ".e2e");
const databaseName = `kalendr_e2e${nameSuffix}`;
const ownerRole = `kalendr_e2e${nameSuffix}_owner`;
const runtimeRole = `kalendr_e2e${nameSuffix}_app`;
const workerRole = `kalendr_e2e${nameSuffix}_worker`;

const adminUrl = process.env.KALENDR_E2E_ADMIN_URL;
if (!adminUrl) throw new Error("Set KALENDR_E2E_ADMIN_URL to a superuser on a disposable PostgreSQL 18 server.");
const admin = new URL(adminUrl);
if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(admin.hostname)) {
  throw new Error("KALENDR_E2E_ADMIN_URL must point at a database on this machine.");
}

const hex = () => randomBytes(32).toString("hex");
const ownerPassword = hex();
const runtimePassword = hex();
const workerPassword = hex();

function urlFor(role, password) {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  url.pathname = `/${databaseName}`;
  url.search = "";
  return url.toString();
}

const ownerUrl = urlFor(ownerRole, ownerPassword);
const runtimeUrl = urlFor(runtimeRole, runtimePassword);
const workerUrl = urlFor(workerRole, workerPassword);

const server = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  await server.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  for (const [role, password, rls] of [
    [ownerRole, ownerPassword, "BYPASSRLS"],
    [runtimeRole, runtimePassword, "NOBYPASSRLS"],
    [workerRole, workerPassword, "NOBYPASSRLS"],
  ]) {
    const [exists] = await server`select 1 from pg_roles where rolname = ${role}`;
    const verb = exists ? "ALTER" : "CREATE";
    await server.unsafe(`${verb} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${rls} PASSWORD '${password}'`);
  }
  await server.unsafe(`CREATE DATABASE ${databaseName} OWNER ${ownerRole}`);
  await server.unsafe(`REVOKE CONNECT ON DATABASE ${databaseName} FROM PUBLIC`);
  await server.unsafe(`GRANT CONNECT ON DATABASE ${databaseName} TO ${ownerRole}, ${runtimeRole}, ${workerRole}`);
} finally {
  await server.end();
}

// Migrations run as the owner role, as they do in a real release.
const ownerSql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  await migrate(drizzle(ownerSql), { migrationsFolder: resolve(projectRoot, "drizzle") });
} finally {
  await ownerSql.end();
}

// The same runtime grants scripts/local-db.sh applies. The runtime role never owns tables.
const grantUrl = new URL(adminUrl);
grantUrl.pathname = `/${databaseName}`;
const grants = postgres(grantUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
try {
  await grants.unsafe(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO ${runtimeRole};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole};
    REVOKE UPDATE, DELETE ON TABLE audit_events FROM ${runtimeRole};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${runtimeRole};
    REVOKE EXECUTE ON FUNCTION kalendr_claim_outbox(text, integer), kalendr_outbox_health(),
      kalendr_worker_tenants(text), kalendr_workflow_tenants(text), kalendr_storage_tenants(text), kalendr_storage_health(), kalendr_calendar_tenants(text), kalendr_import_tenants(), kalendr_payment_tenants(text), kalendr_offers_tenants(text), kalendr_crm_tenants(text), kalendr_campaign_tenants(text),
      kalendr_erase_consent_records(text, text), kalendr_scrub_audit_personal(text, text[]),
      kalendr_claim_code_deliveries(text, integer), kalendr_finish_code_delivery(text, text, text, text),
      kalendr_breach_affected(timestamptz, timestamptz), kalendr_admin_audit(text, text, text, text, jsonb), kalendr_admin_require(text, text[]), kalendr_admin_role(text), kalendr_billing_tenants(), kalendr_domain_tenants(), kalendr_onboarding_tenants(), kalendr_next_platform_invoice_number(), kalendr_staff_digest_tenants(), kalendr_owner_summary_tenants(), kalendr_email_domain_tenants(), kalendr_keep_one_owner() FROM ${runtimeRole};
    GRANT USAGE ON SCHEMA public TO ${workerRole};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${workerRole};
    REVOKE UPDATE, DELETE ON TABLE audit_events FROM ${workerRole};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${workerRole};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${workerRole};
    GRANT USAGE, CREATE ON SCHEMA kalendr_jobs TO ${workerRole};
  `);
} finally {
  await grants.end();
}

rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const credentialsPath = resolve(stateDir, "staff-credentials.json");
const seeded = spawnSync(process.execPath, [resolve(projectRoot, "scripts/seed-local-db.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    KALENDR_SEED_DATABASE_URL: ownerUrl,
    KALENDR_CHECK_DATABASE_URL: runtimeUrl,
    KALENDR_LOCAL_OWNER_ROLE: ownerRole,
    KALENDR_LOCAL_APP_ROLE: runtimeRole,
    KALENDR_SEED_CREDENTIALS_PATH: credentialsPath,
  },
});
if (seeded.status !== 0) throw new Error("Seeding the browser-test database failed.");

const runtimeEnv = {
  DATABASE_URL: runtimeUrl,
  WORKER_DATABASE_URL: workerUrl,
  KALENDR_E2E_OWNER_URL: ownerUrl,
  BETTER_AUTH_SECRET: hex(),
  KALENDR_RECORDS_KEY: randomBytes(32).toString("base64"),
  KALENDR_KEY_PROVIDER: "local",
  KALENDR_LOCAL_MASTER_KEY: randomBytes(32).toString("base64"),
  KALENDR_STAFF_CREDENTIALS: credentialsPath,
};
writeFileSync(
  resolve(stateDir, "runtime.env"),
  `${Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  { mode: 0o600 },
);
console.log(`Browser-test database ${databaseName} is ready.`);
