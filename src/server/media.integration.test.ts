/** @vitest-environment node */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { deleteMedia, readPublicMedia, saveMedia } from "@/server/media";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return (
    parsed.hostname === "127.0.0.1" &&
    ["5544", "5545"].includes(parsed.port) &&
    ["/kalendr_local", "/nira_local"].includes(parsed.pathname) // nira_local: a local cluster made before the rename (see scripts/local-db.sh)
  );
};
const describeLocal =
  localDatabase(runtimeUrl) &&
  localDatabase(ownerUrl) &&
  process.env.KALENDR_PREVIEW_MODE === "false"
    ? describe
    : describe.skip;

describeLocal("business pictures stay with their business", () => {
  it("serves a saved picture only through its own business, under row-level security", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const serviceId = randomUUID();
    let tenantId = "";
    let mediaId = "";
    let context: StaffContext | undefined;

    try {
      const tenants = await owner<{ id: string; name: string }[]>`
        select id, name from tenants where slug = 'lotus-dental' limit 1
      `;
      tenantId = tenants[0]?.id ?? "";
      if (!tenantId) throw new Error("Seed the isolated local database before this test");
      const other = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care' limit 1`;
      const otherTenantId = other[0]?.id ?? "";
      const memberships = await owner<{ user_id: string }[]>`
        select user_id from memberships
        where tenant_id = ${tenantId} and role = 'owner' and is_active
        limit 1
      `;
      const userId = memberships[0]?.user_id ?? "";
      if (!otherTenantId || !userId) throw new Error("Local seed is incomplete");

      // A throwaway service, so no seeded picture is replaced.
      await owner`
        insert into services (
          id, tenant_id, name, description, duration_minutes,
          buffer_before_minutes, buffer_after_minutes, slot_interval_minutes,
          minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types
        ) values (
          ${serviceId}, ${tenantId}, 'Picture Test Service', 'Local integration test', 15,
          0, 0, 15, 120, 90, 'instant', ${["new", "returning"]}
        )
      `;

      context = {
        tenantId,
        clinicSlug: "lotus-dental",
        clinicName: tenants[0]!.name,
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId,
        userName: "Picture Test",
        userEmail: "picture-test@example.com",
        preview: false,
      };

      const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), "public", "onboarding", "delhi-india-gate.webp")));
      const saved = await saveMedia(context, { kind: "service", ownerId: serviceId, bytes });
      mediaId = saved.id;
      expect(saved.url).toBe(`/api/public/media/lotus-dental/${mediaId}`);

      const own = await readPublicMedia("lotus-dental", mediaId);
      expect(own?.contentType).toBe("image/webp");
      expect(Buffer.from(own!.bytes).equals(Buffer.from(bytes))).toBe(true);

      // The same id through another business's address finds nothing.
      await expect(readPublicMedia("riverbend-care", mediaId)).resolves.toBeNull();
      await expect(readPublicMedia("no-such-business", mediaId)).resolves.toBeNull();

      // Row-level security hides the row from the other business even without a tenant filter.
      const seenByOther = await withTenant(otherTenantId, (transaction) =>
        transaction.execute(sql`select id from media_assets where id = ${mediaId}`),
      );
      expect(seenByOther.length).toBe(0);

      // Another business cannot delete it either.
      await expect(
        deleteMedia({ ...context, tenantId: otherTenantId, clinicSlug: "riverbend-care" }, mediaId),
      ).rejects.toMatchObject({ status: 404 });

      // A second save replaces the first, so one service keeps one picture.
      const replaced = await saveMedia(context, { kind: "service", ownerId: serviceId, bytes });
      await expect(readPublicMedia("lotus-dental", mediaId)).resolves.toBeNull();
      mediaId = replaced.id;

      await deleteMedia(context, mediaId);
      await expect(readPublicMedia("lotus-dental", mediaId)).resolves.toBeNull();
      mediaId = "";
    } finally {
      if (mediaId) await owner`delete from media_assets where id = ${mediaId}`;
      await owner`delete from services where id = ${serviceId}`;
      await owner.end();
    }
  });
  it("lets a person remove only their own staff photo", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const mine = randomUUID();
    const theirs = randomUUID();
    let created: string[] = [];
    try {
      const [tenant] = await owner<{ id: string; name: string }[]>`select id, name from tenants where slug = 'lotus-dental' limit 1`;
      if (!tenant) throw new Error("Seed the isolated local database before this test");
      const desk = (userId: string): StaffContext => ({
        tenantId: tenant.id, clinicSlug: "lotus-dental", clinicName: tenant.name, role: "receptionist",
        permissions: resolvePermissions("receptionist", {}), membershipId: null, userId, userName: "Desk", userEmail: "desk@example.com", preview: false,
      });
      const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), "public", "onboarding", "delhi-india-gate.webp")));
      const first = await saveMedia(desk(mine), { kind: "staff_photo", ownerId: theirs, bytes });
      const second = await saveMedia(desk(theirs), { kind: "staff_photo", ownerId: mine, bytes });
      created = [first.id, second.id];
      // The owner named in the request is ignored: each photo belongs to whoever sent it.
      expect(first.ownerId).toBe(mine);
      expect(second.ownerId).toBe(theirs);
      // Someone else's photo is refused as if it did not exist, and stays.
      await expect(deleteMedia(desk(theirs), first.id)).rejects.toMatchObject({ status: 404 });
      const stillThere = await owner`select id from media_assets where id = ${first.id}`;
      expect(stillThere.length).toBe(1);
      // Their own, they may remove without any switch.
      await deleteMedia(desk(mine), first.id);
      const gone = await owner`select id from media_assets where id = ${first.id}`;
      expect(gone.length).toBe(0);
    } finally {
      if (created.length > 0) await owner`delete from media_assets where id in ${owner(created)}`;
      await owner.end();
    }
  });
});
