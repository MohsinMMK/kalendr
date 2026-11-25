import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword, verifyPassword } from "better-auth/crypto";
import postgres from "postgres";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The browser tests seed their own throwaway database and keep its passwords apart from the local cluster's.
const credentialsPath = resolve(projectRoot, process.env.KALENDR_SEED_CREDENTIALS_PATH ?? ".local-db/staff-credentials.json");
const ownerUrl = process.env.KALENDR_SEED_DATABASE_URL;
const runtimeUrl = process.env.KALENDR_CHECK_DATABASE_URL;
// scripts/local-db.sh passes the role names; a cluster made before the rename keeps nira_local_* roles.
const ownerRoleName = process.env.KALENDR_LOCAL_OWNER_ROLE ?? "kalendr_local_owner";
const runtimeRoleName = process.env.KALENDR_LOCAL_APP_ROLE ?? "kalendr_local_app";
// A cluster made before the rename was seeded with differently named sample businesses and ids, and may
// hold the owner's own businesses under slugs this seed now uses. It is never reseeded; `--check` runs a
// generic isolation check over whatever businesses it holds.
const legacyCluster = ownerRoleName.startsWith("nira_");

if (!ownerUrl || !runtimeUrl) {
  throw new Error("Use scripts/local-db.sh seed or check to select the isolated local database.");
}

const clinics = [
  {
    key: "lotus-dental",
    businessType: "dental",
    locationName: "Main clinic",
    name: "Lotus Dental Studio",
    legalName: "Lotus Dental Studio (Local Demo)",
    city: "New Delhi",
    address: "12 Example Road, New Delhi",
    phone: "+919000000101",
    email: "lotus-dental@example.com",
    owner: { name: "Asha Mehta", email: "kalendr.owner@example.com" },
    practitioners: [
      { name: "Dr Kavya Rao", email: "kalendr.kavya@example.com", title: "Dentist", initials: "KR", specialty: "General dentistry" },
      { name: "Dr Arjun Shah", email: "kalendr.arjun@example.com", title: "Dentist", initials: "AS", specialty: "Preventive dentistry" },
    ],
    services: [
      { name: "Dental consultation", description: "A general dental visit.", duration: 30, resourceKind: "chair" },
      { name: "Dental cleaning", description: "A routine cleaning visit.", duration: 45, resourceKind: "chair" },
    ],
    resources: [
      { name: "Chair 1", kind: "chair" },
      { name: "Chair 2", kind: "chair" },
    ],
  },
  {
    key: "riverbend-care",
    businessType: "healthcare",
    locationName: "Main clinic",
    name: "Riverbend Family Clinic",
    legalName: "Riverbend Family Clinic (Local Demo)",
    city: "Bengaluru",
    address: "34 Sample Street, Bengaluru",
    phone: "+919000000202",
    email: "riverbend-care@example.com",
    owner: { name: "Neha Nair", email: "riverbend.owner@example.com" },
    practitioners: [
      { name: "Dr Ishan Nair", email: "riverbend.ishan@example.com", title: "Physician", initials: "IN", specialty: "Family medicine" },
      { name: "Dr Sana Ali", email: "riverbend.sana@example.com", title: "Physician", initials: "SA", specialty: "Preventive care" },
    ],
    services: [
      { name: "Family consultation", description: "A routine family medicine visit.", duration: 30, resourceKind: "room" },
      { name: "Follow-up visit", description: "A scheduled follow-up visit.", duration: 20, resourceKind: "room" },
    ],
    resources: [
      { name: "Consultation room 1", kind: "room" },
      { name: "Consultation room 2", kind: "room" },
    ],
  },
  {
    // A business that is not healthcare, so local checks cover the salon words and screens.
    key: "cedar-hair",
    businessType: "wellness",
    locationName: "Main studio",
    name: "Cedar Hair Studio",
    legalName: "Cedar Hair Studio (Local Demo)",
    city: "Pune",
    address: "8 Demo Lane, Pune",
    phone: "+919000000303",
    email: "cedar-hair@example.com",
    owner: { name: "Meera Kulkarni", email: "cedar.owner@example.com" },
    practitioners: [
      { name: "Rohan Desai", email: "cedar.rohan@example.com", title: "Senior stylist", initials: "RD", specialty: "Cuts and colour" },
      { name: "Tara Iyer", email: "cedar.tara@example.com", title: "Stylist", initials: "TI", specialty: "Styling" },
    ],
    services: [
      { name: "Haircut", description: "A wash, cut and finish.", duration: 45, resourceKind: "chair" },
      { name: "Hair colour", description: "Full colour with a finish.", duration: 90, resourceKind: "chair" },
    ],
    resources: [
      { name: "Station 1", kind: "chair" },
      { name: "Station 2", kind: "chair" },
    ],
  },
];

function stableId(key) {
  const bytes = createHash("sha256").update(`kalendr-local-demo-v1:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function staffIdentities() {
  return clinics.flatMap((clinic) => [clinic.owner, ...clinic.practitioners]);
}

function readOrCreateCredentials() {
  if (existsSync(credentialsPath)) {
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
    let added = false;
    for (const staff of staffIdentities()) {
      if (credentials[staff.email] === undefined) {
        // A staff member added to the seed after the file was made: give them a password, never replace one.
        credentials[staff.email] = randomBytes(32).toString("base64url");
        added = true;
      } else if (typeof credentials[staff.email] !== "string" || credentials[staff.email].length < 32) {
        throw new Error("Local staff credential file is incomplete; refusing to replace stored passwords.");
      }
    }
    if (added) writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    return credentials;
  }

  const credentials = Object.fromEntries(
    staffIdentities().map((staff) => [staff.email, randomBytes(32).toString("base64url")]),
  );
  // A fresh checkout (CI) has no .local-db folder yet.
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return credentials;
}

async function insertStaff(transaction, clinic, staff, role, credentials) {
  const userId = stableId(`staff:${staff.email}`);
  const membershipId = stableId(`membership:${clinic.key}:${staff.email}`);
  const accountId = stableId(`account:${staff.email}`);
  const passwordHash = await hashPassword(credentials[staff.email]);

  await transaction`
    INSERT INTO auth_users (id, name, email, email_verified, password_set_at)
    VALUES (${userId}, ${staff.name}, ${staff.email}, true, now())
    ON CONFLICT (id) DO NOTHING
  `;
  await transaction`
    INSERT INTO auth_accounts (id, issuer, account_id, provider_id, user_id, password)
    VALUES (${accountId}, 'local:credential', ${userId}, 'credential', ${userId}, ${passwordHash})
    ON CONFLICT (id) DO NOTHING
  `;
  await transaction`
    INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${membershipId}, ${stableId(`tenant:${clinic.key}`)}, ${userId}, ${role})
    ON CONFLICT (id) DO NOTHING
  `;
  return userId;
}

async function seedClinic(transaction, clinic, credentials) {
  const tenantId = stableId(`tenant:${clinic.key}`);
  const locationId = stableId(`location:${clinic.key}`);
  await transaction`
    INSERT INTO tenants (id, slug, name, legal_name, phone, email, timezone, locale, business_type)
    VALUES (${tenantId}, ${clinic.key}, ${clinic.name}, ${clinic.legalName}, ${clinic.phone}, ${clinic.email}, 'Asia/Kolkata', 'en-IN', ${clinic.businessType})
    ON CONFLICT (id) DO UPDATE SET business_type = EXCLUDED.business_type
  `;
  await transaction`
    INSERT INTO locations (id, tenant_id, name, address, city, timezone, accessible_entrance)
    VALUES (${locationId}, ${tenantId}, ${clinic.locationName}, ${clinic.address}, ${clinic.city}, 'Asia/Kolkata', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await insertStaff(transaction, clinic, clinic.owner, "owner", credentials);

  for (const [index, service] of clinic.services.entries()) {
    const serviceId = stableId(`service:${clinic.key}:${index}`);
    await transaction`
      INSERT INTO services (
        id, tenant_id, name, description, duration_minutes, slot_interval_minutes,
        minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, required_resource_kind
      ) VALUES (
        ${serviceId}, ${tenantId}, ${service.name}, ${service.description}, ${service.duration}, 15,
        60, 90, 'instant', ${["new", "returning"]}, ${service.resourceKind}
      ) ON CONFLICT (id) DO UPDATE
        SET patient_types = EXCLUDED.patient_types
    `;
    await transaction`
      INSERT INTO service_locations (tenant_id, service_id, location_id)
      VALUES (${tenantId}, ${serviceId}, ${locationId})
      ON CONFLICT DO NOTHING
    `;
  }

  for (const [index, resource] of clinic.resources.entries()) {
    await transaction`
      INSERT INTO resources (id, tenant_id, location_id, name, kind)
      VALUES (${stableId(`resource:${clinic.key}:${index}`)}, ${tenantId}, ${locationId}, ${resource.name}, ${resource.kind})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  for (const [index, practitioner] of clinic.practitioners.entries()) {
    const practitionerId = stableId(`practitioner:${clinic.key}:${index}`);
    const userId = await insertStaff(transaction, clinic, practitioner, "practitioner", credentials);
    await transaction`
      INSERT INTO practitioners (id, tenant_id, auth_user_id, name, title, initials, specialty)
      VALUES (${practitionerId}, ${tenantId}, ${userId}, ${practitioner.name}, ${practitioner.title}, ${practitioner.initials}, ${practitioner.specialty})
      ON CONFLICT (id) DO NOTHING
    `;
    await transaction`
      INSERT INTO practitioner_locations (tenant_id, practitioner_id, location_id)
      VALUES (${tenantId}, ${practitionerId}, ${locationId})
      ON CONFLICT DO NOTHING
    `;
    for (const serviceIndex of clinic.services.keys()) {
      await transaction`
        INSERT INTO practitioner_services (tenant_id, practitioner_id, service_id)
        VALUES (${tenantId}, ${practitionerId}, ${stableId(`service:${clinic.key}:${serviceIndex}`)})
        ON CONFLICT DO NOTHING
      `;
    }
    for (let dayOfWeek = 1; dayOfWeek <= 6; dayOfWeek += 1) {
      await transaction`
        INSERT INTO availability_rules (
          id, tenant_id, location_id, practitioner_id, day_of_week,
          starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes
        ) VALUES (
          ${stableId(`availability:${clinic.key}:${index}:${dayOfWeek}`)}, ${tenantId},
          ${locationId}, ${practitionerId}, ${dayOfWeek}, '09:00', '17:00',
          'Asia/Kolkata', '2025-01-01', 15
        ) ON CONFLICT (id) DO NOTHING
      `;
    }
  }
}

async function checkIsolation(owner, runtime, credentials) {
  const roles = await owner`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles WHERE rolname IN (${ownerRoleName}, ${runtimeRoleName})
  `;
  const ownerRole = roles.find((role) => role.rolname === ownerRoleName);
  const runtimeRole = roles.find((role) => role.rolname === runtimeRoleName);
  assert(ownerRole && ownerRole.rolbypassrls, "Migration owner must bypass RLS for tenant resolvers");
  assert(runtimeRole && !runtimeRole.rolsuper && !runtimeRole.rolbypassrls, "Runtime role must have no RLS bypass");

  const noContext = await runtime`SELECT count(*)::int AS count FROM tenants`;
  assert.equal(noContext[0].count, 0, "Runtime role must see no tenants without a tenant context");

  for (const clinic of clinics) {
    const tenantId = stableId(`tenant:${clinic.key}`);
    const resolved = await runtime`SELECT tenant_id FROM kalendr_resolve_tenant(${clinic.key}, null)`;
    assert.equal(resolved[0]?.tenant_id, tenantId, `Tenant resolver failed for ${clinic.key}`);
    const staffMemberships = await runtime`
      SELECT tenant_id FROM kalendr_resolve_staff_memberships(${stableId(`staff:${clinic.owner.email}`)})
    `;
    assert.deepEqual(staffMemberships.map((membership) => membership.tenant_id), [tenantId],
      `Staff membership resolver failed for ${clinic.key}`);
    await runtime.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const rows = await transaction`
        SELECT (SELECT count(*)::int FROM tenants) AS tenants,
               (SELECT business_type FROM tenants LIMIT 1) AS business_type,
               (SELECT count(*)::int FROM locations) AS locations,
               (SELECT count(*)::int FROM services) AS services,
               (SELECT count(*)::int FROM practitioners) AS practitioners,
               (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM memberships) AS memberships,
               (SELECT count(*)::int FROM availability_rules) AS availability_rules
      `;
      assert.equal(rows[0].tenants, 1, `Wrong visible tenant count for ${clinic.key}`);
      assert.equal(rows[0].business_type, clinic.businessType, `Wrong business type for ${clinic.key}`);
      for (const [tableName, minimumCount] of Object.entries({
        locations: 1,
        services: 2,
        practitioners: 2,
        resources: 2,
        memberships: 3,
        availability_rules: 12,
      })) {
        assert(rows[0][tableName] >= minimumCount,
          `Missing ${tableName} seed rows for ${clinic.key}`);
      }
      const otherIds = clinics.filter((candidate) => candidate.key !== clinic.key).map((candidate) => stableId(`tenant:${candidate.key}`));
      const otherRows = await transaction`SELECT count(*)::int AS count FROM tenants WHERE id = ANY(${otherIds})`;
      assert.equal(otherRows[0].count, 0, "Runtime role read another business");
    });
  }

  let crossTenantWriteDenied = false;
  try {
    await runtime.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${stableId(`tenant:${clinics[0].key}`)}, true)`;
      await transaction`
        INSERT INTO locations (tenant_id, name, address, city, timezone)
        VALUES (${stableId(`tenant:${clinics[1].key}`)}, 'Forbidden local check', 'Never persisted', 'Nowhere', 'Asia/Kolkata')
      `;
      throw new Error("Cross-tenant write unexpectedly succeeded");
    });
  } catch (error) {
    if (error?.code === "42501") crossTenantWriteDenied = true;
    else throw error;
  }
  assert(crossTenantWriteDenied, "Runtime role accepted a cross-tenant write");

  const sampleEmail = clinics[0].owner.email;
  const account = await owner`
    SELECT password FROM auth_accounts
    WHERE issuer = 'local:credential' AND account_id = ${stableId(`staff:${sampleEmail}`)}
  `;
  assert(account[0]?.password, "Local staff credential account is missing");
  assert(await verifyPassword({ hash: account[0].password, password: credentials[sampleEmail] }),
    "Local staff password does not match its Better Auth hash");

  console.log(`Local seed verified: ${clinics.length} businesses (${clinics.map((clinic) => clinic.businessType).join(", ")}), ${clinics.length * 2} staff members who take bookings, ${clinics.length * 2} services, ${clinics.length * 2} resources, ${staffIdentities().length} staff identities, scoped availability and RLS denial.`);
}

async function checkLegacyIsolation(owner, runtime) {
  const roles = await owner`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles WHERE rolname IN (${ownerRoleName}, ${runtimeRoleName})
  `;
  const ownerRole = roles.find((role) => role.rolname === ownerRoleName);
  const runtimeRole = roles.find((role) => role.rolname === runtimeRoleName);
  assert(ownerRole && ownerRole.rolbypassrls, "Migration owner must bypass RLS for tenant resolvers");
  assert(runtimeRole && !runtimeRole.rolsuper && !runtimeRole.rolbypassrls, "Runtime role must have no RLS bypass");

  const noContext = await runtime`SELECT count(*)::int AS count FROM tenants`;
  assert.equal(noContext[0].count, 0, "Runtime role must see no tenants without a tenant context");

  const tenants = await owner`SELECT id, slug FROM tenants WHERE is_active ORDER BY slug`;
  for (const tenant of tenants) {
    const resolved = await runtime`SELECT tenant_id FROM kalendr_resolve_tenant(${tenant.slug}, null)`;
    assert.equal(resolved[0]?.tenant_id, tenant.id, `Tenant resolver failed for ${tenant.slug}`);
    await runtime.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      const rows = await transaction`SELECT id FROM tenants`;
      assert.deepEqual(rows.map((row) => row.id), [tenant.id], `Wrong visible businesses for ${tenant.slug}`);
    });
  }

  if (tenants.length >= 2) {
    let crossTenantWriteDenied = false;
    try {
      await runtime.begin(async (transaction) => {
        await transaction`SELECT set_config('app.tenant_id', ${tenants[0].id}, true)`;
        await transaction`
          INSERT INTO locations (tenant_id, name, address, city, timezone)
          VALUES (${tenants[1].id}, 'Forbidden local check', 'Never persisted', 'Nowhere', 'Asia/Kolkata')
        `;
        throw new Error("Cross-tenant write unexpectedly succeeded");
      });
    } catch (error) {
      if (error?.code === "42501") crossTenantWriteDenied = true;
      else throw error;
    }
    assert(crossTenantWriteDenied, "Runtime role accepted a cross-tenant write");
  }

  console.log(`Local database verified (created before the rename, not reseeded): ${tenants.length} businesses, each visible only in its own context, cross-business write denied.`);
}

const owner = postgres(ownerUrl, { max: 1, prepare: false });
const runtime = postgres(runtimeUrl, { max: 1, prepare: false });
try {
  if (legacyCluster) {
    if (process.argv[2] !== "--check") {
      throw new Error("This local database was created before the rename to Kalendr and already holds its own businesses. It is not reseeded. Use `scripts/local-db.sh check`, or start a fresh cluster to get the Kalendr sample businesses.");
    }
    await checkLegacyIsolation(owner, runtime);
  } else {
  const credentials = readOrCreateCredentials();
  if (process.argv[2] !== "--check") {
    await owner.begin(async (transaction) => {
      for (const clinic of clinics) await seedClinic(transaction, clinic, credentials);
    });
  }
  await checkIsolation(owner, runtime, credentials);
  }
} finally {
  await Promise.all([owner.end(), runtime.end()]);
}
