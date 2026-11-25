/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FieldKind } from "@/lib/customer-contracts";
import { resolvePermissions } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { ApiError } from "@/server/api-error";
import { createFieldDefinition, listFieldDefinitions, listFieldValuesForGrid, setFieldValues, updateFieldDefinition } from "@/server/customers/fields";
import { mergeCustomers, undoMerge } from "@/server/customers/merge";
import { eraseCustomer } from "@/server/privacy/erasure";
import { collectCustomerExport } from "@/server/privacy/export";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

async function expectApiError(promise: Promise<unknown>, code: string, status?: number): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  if (status) expect((error as ApiError).status).toBe(status);
  return error as ApiError;
}

describeIsolated("a business's own customer fields", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;
  const key = () => `test-${randomUUID()}`;

  const inTenant = <T>(fixture: TenantFixture, work: (tenantDb: postgres.TransactionSql) => Promise<T>): Promise<T> => worker.begin(async (tenantDb) => {
    await tenantDb`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
    return work(tenantDb);
  }) as Promise<T>;

  const as = (fixture: TenantFixture, role: "owner" | "admin" | "receptionist" | "practitioner", userId?: string) =>
    staffContext(fixture, { role, permissions: resolvePermissions(role, {}), ...(userId ? { userId } : {}) });

  const stored = async (patientId: string, fieldId: string): Promise<string | undefined> => {
    const [row] = await owner<{ value: string }[]>`select value from customer_field_values where patient_id = ${patientId} and field_id = ${fieldId}`;
    return row?.value;
  };

  async function define(context: ReturnType<typeof staffContext>, label: string, kind: FieldKind, choices: string[] = []) {
    return createFieldDefinition(context, { label, kind, choices });
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    a = await createTenant(owner, "fields-a");
    b = await createTenant(owner, "fields-b");
  });

  afterAll(async () => {
    await owner.end();
    await worker.end();
  });

  describe("kinds", () => {
    it("stores each kind in its own form and refuses what does not fit", async () => {
      const tenant = await createTenant(owner, "kinds");
      const context = as(tenant, "owner");
      const customer = await createCustomer(owner, tenant.tenantId);
      const picks = await define(context, "Interests", "multichoice", ["Yoga", "Pilates", "Spin"]);
      const consent = await define(context, "Likes texts", "boolean");
      const mobile = await define(context, "Mobile", "phone");
      const mail = await define(context, "Work email", "email");
      const site = await define(context, "Website", "link");
      await setFieldValues(context, customer.id, {
        [picks.id]: JSON.stringify(["Spin", "Yoga"]), [consent.id]: "Yes", [mobile.id]: "+91 98765 43210", [mail.id]: "  Asha@Example.COM ", [site.id]: "example.com/asha",
      });
      // A list comes back in the order of the field's own choices, an email in lower case, a link with its scheme.
      expect(await stored(customer.id, picks.id)).toBe(JSON.stringify(["Yoga", "Spin"]));
      expect(await stored(customer.id, consent.id)).toBe("true");
      expect(await stored(customer.id, mobile.id)).toBe("+91 98765 43210");
      expect(await stored(customer.id, mail.id)).toBe("asha@example.com");
      expect(await stored(customer.id, site.id)).toBe("https://example.com/asha");

      for (const [field, bad] of [
        [picks, JSON.stringify(["Swimming"])], [picks, "Yoga"], [picks, JSON.stringify(["Yoga", "Swimming"])], [consent, "maybe"], [mobile, "call me"],
        [mail, "not-an-email"], [site, "javascript:alert(1)"], [site, "localhost"],
      ] as const) {
        const error = await expectApiError(setFieldValues(context, customer.id, { [field.id]: bad }), "validation_error", 400);
        expect(error.fieldErrors?.[field.id]?.length).toBe(1);
      }
      await expectApiError(setFieldValues(context, customer.id, { [mail.id]: "x".repeat(2501) }), "validation_error");
      // A refused batch saves none of it.
      expect(await stored(customer.id, mail.id)).toBe("asha@example.com");
    });

    it("keeps a long text answer up to the new limit and no more", async () => {
      const tenant = await createTenant(owner, "long");
      const context = as(tenant, "owner");
      const customer = await createCustomer(owner, tenant.tenantId);
      const story = await define(context, "Story", "text");
      await setFieldValues(context, customer.id, { [story.id]: "w".repeat(2500) });
      expect((await stored(customer.id, story.id))?.length).toBe(2500);
      await expectApiError(setFieldValues(context, customer.id, { [story.id]: "w".repeat(2501) }), "validation_error");
    });

    it("needs two different choices for a choice kind and none for the others", async () => {
      const tenant = await createTenant(owner, "choices");
      const context = as(tenant, "owner");
      const text = await define(context, "Note", "text");
      expect(text.choices).toEqual([]);
      const level = await define(context, "Level", "choice", ["Low", "High"]);
      await expectApiError(updateFieldDefinition(context, level.id, { choices: ["Only"], version: level.version }), "validation_error", 400);
      await expectApiError(updateFieldDefinition(context, level.id, { choices: ["Low", "low"], version: level.version }), "validation_error", 400);
      await expectApiError(updateFieldDefinition(context, text.id, { choices: ["A", "B"], version: text.version }), "validation_error", 400);
      await expectApiError(updateFieldDefinition(context, text.id, { kind: "choice", version: text.version }), "validation_error", 400);
      await expectApiError(updateFieldDefinition(context, level.id, { renames: { Nope: "Low" }, version: level.version }), "validation_error", 400);
      const toText = await updateFieldDefinition(context, level.id, { kind: "text", version: level.version });
      expect(toText.definition).toMatchObject({ kind: "text", choices: [] });
    });
  });

  describe("changing a field", () => {
    it("converts values to the new kind, clears the ones that do not fit and says how many", async () => {
      const tenant = await createTenant(owner, "convert");
      const context = as(tenant, "owner");
      const [one, two, three] = [await createCustomer(owner, tenant.tenantId), await createCustomer(owner, tenant.tenantId), await createCustomer(owner, tenant.tenantId)];
      const field = await define(context, "Reference", "text");
      await setFieldValues(context, one.id, { [field.id]: "42" });
      await setFieldValues(context, two.id, { [field.id]: "Rex" });
      await setFieldValues(context, three.id, { [field.id]: " 7.50" });
      const result = await updateFieldDefinition(context, field.id, { kind: "number", version: field.version });
      expect(result.cleared).toBe(1);
      expect(result.definition).toMatchObject({ kind: "number", version: field.version + 1 });
      expect(await stored(one.id, field.id)).toBe("42");
      expect(await stored(two.id, field.id)).toBeUndefined();
      expect(await stored(three.id, field.id)).toBe("7.5");
      await expectApiError(updateFieldDefinition(context, field.id, { kind: "text", version: field.version }), "version_conflict", 409);
    });

    it("turns one choice into a list of one, and a list back into one only when one is picked", async () => {
      const tenant = await createTenant(owner, "choice-shapes");
      const context = as(tenant, "owner");
      const [one, two] = [await createCustomer(owner, tenant.tenantId), await createCustomer(owner, tenant.tenantId)];
      const field = await define(context, "Goal", "choice", ["Fitness", "Rehab", "Fun"]);
      await setFieldValues(context, one.id, { [field.id]: "Rehab" });
      const toMany = await updateFieldDefinition(context, field.id, { kind: "multichoice", version: field.version });
      expect(toMany.cleared).toBe(0);
      expect(await stored(one.id, field.id)).toBe(JSON.stringify(["Rehab"]));
      await setFieldValues(context, two.id, { [field.id]: JSON.stringify(["Fitness", "Fun"]) });
      const back = await updateFieldDefinition(context, field.id, { kind: "choice", version: toMany.definition.version });
      expect(back.cleared).toBe(1);
      expect(await stored(one.id, field.id)).toBe("Rehab");
      expect(await stored(two.id, field.id)).toBeUndefined();
    });

    it("follows a renamed choice, and clears the answers of a choice that was removed", async () => {
      const tenant = await createTenant(owner, "rename");
      const context = as(tenant, "owner");
      const [one, two, three] = [await createCustomer(owner, tenant.tenantId), await createCustomer(owner, tenant.tenantId), await createCustomer(owner, tenant.tenantId)];
      const field = await define(context, "Level", "choice", ["Beginner", "Advanced", "Pro"]);
      await setFieldValues(context, one.id, { [field.id]: "Advanced" });
      await setFieldValues(context, two.id, { [field.id]: "Beginner" });
      await setFieldValues(context, three.id, { [field.id]: "Pro" });
      const result = await updateFieldDefinition(context, field.id, { choices: ["Beginner", "Expert"], renames: { Advanced: "Expert" }, version: field.version });
      expect(result.cleared).toBe(1);
      expect(result.definition.choices).toEqual(["Beginner", "Expert"]);
      expect(await stored(one.id, field.id)).toBe("Expert");
      expect(await stored(two.id, field.id)).toBe("Beginner");
      expect(await stored(three.id, field.id)).toBeUndefined();
    });

    it("renames inside a list of choices without losing the rest of the list", async () => {
      const tenant = await createTenant(owner, "rename-many");
      const context = as(tenant, "owner");
      const customer = await createCustomer(owner, tenant.tenantId);
      const field = await define(context, "Days", "multichoice", ["Mon", "Tue", "Wed"]);
      await setFieldValues(context, customer.id, { [field.id]: JSON.stringify(["Mon", "Wed"]) });
      await updateFieldDefinition(context, field.id, { choices: ["Monday", "Tue", "Wed"], renames: { Mon: "Monday" }, version: field.version });
      expect(await stored(customer.id, field.id)).toBe(JSON.stringify(["Monday", "Wed"]));
    });

    it("keeps values when a field is archived and brings them back when it returns", async () => {
      const tenant = await createTenant(owner, "archive");
      const context = as(tenant, "owner");
      const customer = await createCustomer(owner, tenant.tenantId);
      const field = await define(context, "Locker", "text");
      await setFieldValues(context, customer.id, { [field.id]: "B-12" });
      const archived = await updateFieldDefinition(context, field.id, { archived: true, version: field.version });
      expect(archived.definition.archived).toBe(true);
      expect(archived.cleared).toBe(0);
      expect(await listFieldDefinitions(context)).toEqual([]);
      expect(await listFieldDefinitions(context, { includeArchived: true })).toHaveLength(1);
      expect(await stored(customer.id, field.id)).toBe("B-12");
      await expectApiError(setFieldValues(context, customer.id, { [field.id]: "C-1" }), "validation_error");
      const returned = await updateFieldDefinition(context, field.id, { archived: false, version: archived.definition.version });
      expect(returned.definition.archived).toBe(false);
      expect((await listFieldDefinitions(context)).map((entry) => entry.id)).toEqual([field.id]);
    });

    it("keeps names unique, caps the fields at twenty and writes only ids and counts to the activity log", async () => {
      const tenant = await createTenant(owner, "cap");
      const context = as(tenant, "owner");
      const first = await define(context, "Secret label", "choice", ["Hidden one", "Hidden two"]);
      await expectApiError(define(context, "secret LABEL", "text"), "field_exists", 409);
      const second = await define(context, "Other", "text");
      await expectApiError(updateFieldDefinition(context, second.id, { label: "SECRET label", version: second.version }), "field_exists", 409);
      const customer = await createCustomer(owner, tenant.tenantId);
      await setFieldValues(context, customer.id, { [first.id]: "Hidden one" });
      await updateFieldDefinition(context, first.id, { choices: ["Renamed one", "Hidden two"], renames: { "Hidden one": "Renamed one" }, version: first.version });
      const audit = await owner<{ metadata: string }[]>`select metadata::text as metadata from audit_events where tenant_id = ${tenant.tenantId} and action like 'customer.field%'`;
      expect(audit.length).toBeGreaterThanOrEqual(3);
      for (const row of audit) expect(row.metadata).not.toMatch(/Secret label|Hidden|Renamed|secret/i);
      for (let index = 0; index < 18; index += 1) await define(context, `Field ${index}`, "text");
      await expectApiError(define(context, "One too many", "text"), "too_many_fields", 409);
      // Archiving makes room, and bringing it back past the cap is refused.
      const archived = await updateFieldDefinition(context, second.id, { archived: true, version: second.version });
      const extra = await define(context, "Fits now", "text");
      await expectApiError(updateFieldDefinition(context, second.id, { archived: false, version: archived.definition.version }), "too_many_fields", 409);
      expect(extra.id).toBeTruthy();
    });
  });

  describe("who may do what", () => {
    it("lets a receptionist fill in values but not define or change fields; owners and admins may", async () => {
      const tenant = await createTenant(owner, "roles");
      const receptionist = as(tenant, "receptionist");
      const error = await expectApiError(define(receptionist, "Nope", "text"), "forbidden", 403);
      expect(error.message.length).toBeGreaterThan(10);
      const field = await define(as(tenant, "admin"), "Allergies", "text");
      await expectApiError(updateFieldDefinition(receptionist, field.id, { label: "Changed", version: field.version }), "forbidden", 403);
      await expectApiError(updateFieldDefinition(receptionist, field.id, { archived: true, version: field.version }), "forbidden", 403);
      const customer = await createCustomer(owner, tenant.tenantId);
      await setFieldValues(receptionist, customer.id, { [field.id]: "Latex" });
      expect(await stored(customer.id, field.id)).toBe("Latex");
      // They can still read the definitions.
      expect((await listFieldDefinitions(receptionist)).map((entry) => entry.id)).toEqual([field.id]);
      expect((await updateFieldDefinition(as(tenant, "owner"), field.id, { label: "Allergy", version: field.version })).definition.label).toBe("Allergy");
    });

    it("keeps one business's fields and values away from another", async () => {
      const mine = as(a, "owner");
      const theirs = as(b, "owner");
      const field = await define(mine, "Mine only", "text");
      const customer = await createCustomer(owner, a.tenantId);
      await setFieldValues(mine, customer.id, { [field.id]: "private" });
      expect((await listFieldDefinitions(theirs, { includeArchived: true })).some((entry) => entry.id === field.id)).toBe(false);
      await expectApiError(updateFieldDefinition(theirs, field.id, { label: "Taken", version: field.version }), "field_not_found", 404);
      const theirCustomer = await createCustomer(owner, b.tenantId);
      await expectApiError(setFieldValues(theirs, theirCustomer.id, { [field.id]: "x" }), "validation_error", 400);
      await expectApiError(setFieldValues(theirs, customer.id, { [field.id]: "x" }), "customer_not_found", 404);
      expect(JSON.stringify(await listFieldValuesForGrid(theirs))).not.toContain("private");
      expect(await stored(customer.id, field.id)).toBe("private");
      // The same label in the other business is a different field.
      expect((await define(theirs, "Mine only", "text")).id).not.toBe(field.id);
    });
  });

  describe("reading values for a table", () => {
    it("returns every customer's values, and leaves out merged, erased and archived ones", async () => {
      const tenant = await createTenant(owner, "grid");
      const context = as(tenant, "owner");
      const visible = await createCustomer(owner, tenant.tenantId);
      const merged = await createCustomer(owner, tenant.tenantId);
      const erased = await createCustomer(owner, tenant.tenantId);
      const kept = await define(context, "Plan", "text");
      const old = await define(context, "Old locker", "text");
      for (const customer of [visible, merged, erased]) await setFieldValues(context, customer.id, { [kept.id]: `plan-${customer.id}`, [old.id]: "L1" });
      await owner`update patients set merged_into_id = ${visible.id}, merged_at = now() where id = ${merged.id}`;
      await owner`update patients set erased_at = now() where id = ${erased.id}`;
      await updateFieldDefinition(context, old.id, { archived: true, version: old.version });
      const grid = await listFieldValuesForGrid(context);
      expect(grid).toEqual({ [visible.id]: { [kept.id]: `plan-${visible.id}` } });
      expect(await listFieldValuesForGrid({ ...context, preview: true })).toEqual({});
    });

    it("shows a practitioner only the customers they have seen", async () => {
      const tenant = await createTenant(owner, "grid-own");
      const owners = as(tenant, "owner");
      const [mine, other] = [await createCustomer(owner, tenant.tenantId), await createCustomer(owner, tenant.tenantId)];
      const field = await define(owners, "Plan", "text");
      await setFieldValues(owners, mine.id, { [field.id]: "mine" });
      await setFieldValues(owners, other.id, { [field.id]: "other" });
      const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values ('Dr Grid', ${`grid-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
      await owner`update practitioners set auth_user_id = ${user!.id} where id = ${tenant.practitionerId}`;
      const practitioner = as(tenant, "practitioner", user!.id);
      expect(await listFieldValuesForGrid(practitioner)).toEqual({});
      await createBooking(owner, tenant, mine.id);
      expect(await listFieldValuesForGrid(practitioner)).toEqual({ [mine.id]: { [field.id]: "mine" } });
      expect(Object.keys(await listFieldValuesForGrid(owners)).sort()).toEqual([mine.id, other.id].sort());
      // Someone else's practitioner account sees none of it.
      expect(await listFieldValuesForGrid(as(tenant, "practitioner", `stranger-${randomUUID().slice(0, 8)}`))).toEqual({});
    });
  });

  describe("privacy and merging", () => {
    it("puts every value in a customer's export in readable words, archived fields included, and removes them on erasure", async () => {
      const tenant = await createTenant(owner, "privacy");
      const context = as(tenant, "owner");
      const customer = await createCustomer(owner, tenant.tenantId);
      const bystander = await createCustomer(owner, tenant.tenantId);
      const picks = await define(context, "Interests", "multichoice", ["Yoga", "Spin"]);
      const likes = await define(context, "Likes texts", "boolean");
      const locker = await define(context, "Locker", "text");
      await setFieldValues(context, customer.id, { [picks.id]: JSON.stringify(["Yoga", "Spin"]), [likes.id]: "true", [locker.id]: "B-12" });
      await setFieldValues(context, bystander.id, { [likes.id]: "false" });
      await updateFieldDefinition(context, locker.id, { archived: true, version: locker.version });

      const data = await inTenant(tenant, (tenantDb) => collectCustomerExport(tenantDb, tenant.tenantId, customer.id, new Date()));
      const details = data.extraDetails ?? [];
      expect(details).toEqual(expect.arrayContaining([
        { field: "Interests", value: "Yoga, Spin" }, { field: "Likes texts", value: "Yes" }, { field: "Locker", value: "B-12" },
      ]));
      expect(details).toHaveLength(3);

      // Merging first leaves the other profile's own copy, which an erasure of the kept profile must remove as well.
      const twin = await createCustomer(owner, tenant.tenantId);
      await setFieldValues(context, twin.id, { [likes.id]: "true", [picks.id]: JSON.stringify(["Spin"]) });
      await mergeCustomers(context, { keepId: customer.id, mergeId: twin.id }, key());
      const [request] = await owner<{ id: string }[]>`insert into data_requests (tenant_id, patient_id, type, status, note) values (${tenant.tenantId}, ${customer.id}, 'erasure', 'approved', 'test') returning id`;
      await inTenant(tenant, (tenantDb) => eraseCustomer(tenantDb, tenant.tenantId, request!.id, new Date()));
      expect(await owner`select 1 from customer_field_values where tenant_id = ${tenant.tenantId} and patient_id in (${customer.id}, ${twin.id})`).toHaveLength(0);
      expect(await stored(bystander.id, likes.id)).toBe("false");
    });

    it("carries values to the kept profile on a merge, lets the kept answer win, and undoes it", async () => {
      const tenant = await createTenant(owner, "merge-fields");
      const context = as(tenant, "owner");
      const keep = await createCustomer(owner, tenant.tenantId);
      const merge = await createCustomer(owner, tenant.tenantId);
      const both = await define(context, "Plan", "text");
      const onlyMerged = await define(context, "Goal", "choice", ["Fitness", "Fun"]);
      const onlyKept = await define(context, "Locker", "text");
      await setFieldValues(context, keep.id, { [both.id]: "kept answer", [onlyKept.id]: "L9" });
      await setFieldValues(context, merge.id, { [both.id]: "merged answer", [onlyMerged.id]: "Fun" });

      const result = await mergeCustomers(context, { keepId: keep.id, mergeId: merge.id }, key());
      expect(await stored(keep.id, both.id)).toBe("kept answer");
      expect(await stored(keep.id, onlyMerged.id)).toBe("Fun");
      expect(await stored(keep.id, onlyKept.id)).toBe("L9");
      expect(await stored(merge.id, both.id)).toBe("merged answer");
      const audit = await owner<{ metadata: string }[]>`select metadata::text as metadata from audit_events where tenant_id = ${tenant.tenantId} and action like 'customer.merge%'`;
      for (const row of audit) expect(row.metadata).not.toMatch(/answer|Fun|L9/);

      await undoMerge(context, result.mergeId);
      expect(await stored(keep.id, both.id)).toBe("kept answer");
      expect(await stored(keep.id, onlyKept.id)).toBe("L9");
      expect(await stored(keep.id, onlyMerged.id)).toBeUndefined();
      expect(await stored(merge.id, both.id)).toBe("merged answer");
      expect(await stored(merge.id, onlyMerged.id)).toBe("Fun");
    });
  });
});
