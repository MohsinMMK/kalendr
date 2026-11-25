import { randomUUID } from "node:crypto";

import Papa from "papaparse";
import postgres from "postgres";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";
import { localCaptureSink } from "@/worker/delivery";
import { createHandlers, type HandlerRegistry } from "@/worker/handlers";
import { claimOutboxBatch, MAX_ATTEMPTS, processClaimedEvent } from "@/worker/outbox-worker";

/** Shared setup for the import integration tests: three connections, two businesses, a staff identity for each, and a worker loop. */

export const urls = {
  runtime: process.env.DATABASE_URL,
  owner: process.env.KALENDR_TEST_OWNER_URL,
  worker: process.env.WORKER_DATABASE_URL,
};

export interface Harness {
  owner: postgres.Sql;
  worker: postgres.Sql;
  runtime: postgres.Sql;
  tenantA: string;
  tenantB: string;
  staffA: StaffContext;
  staffB: StaffContext;
  suffix: string;
  /** Runs worker batches until `done` is true, or fails after `seconds`. */
  drain(done: () => Promise<boolean>, seconds?: number, registry?: HandlerRegistry): Promise<void>;
  handlers: HandlerRegistry;
  close(): Promise<void>;
}

async function staffFor(owner: postgres.Sql, tenantId: string): Promise<StaffContext> {
  const [tenant] = await owner<{ slug: string; name: string }[]>`select slug, name from tenants where id = ${tenantId}`;
  const [member] = await owner<{ id: string; user_id: string }[]>`
    select id, user_id from memberships where tenant_id = ${tenantId} and is_active and role = 'owner' order by created_at, id limit 1`;
  return {
    tenantId, clinicSlug: tenant!.slug, clinicName: tenant!.name, role: "owner", permissions: resolvePermissions("owner", {}),
    membershipId: member!.id, userId: member!.user_id, userName: "Import Tester", userEmail: "tester@example.com", preview: false,
  };
}

export async function openHarness(): Promise<Harness> {
  const owner = postgres(urls.owner!, { max: 2, prepare: false, onnotice: () => undefined });
  const worker = postgres(urls.worker!, { max: 6, prepare: false, transform: { undefined: null }, onnotice: () => undefined });
  const runtime = postgres(urls.runtime!, { max: 2, prepare: false, onnotice: () => undefined });
  const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
  const [b] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
  const handlers = createHandlers({ sink: localCaptureSink, now: () => new Date(), databaseUrl: urls.worker });
  const harness: Harness = {
    owner, worker, runtime, tenantA: a!.id, tenantB: b!.id,
    staffA: await staffFor(owner, a!.id), staffB: await staffFor(owner, b!.id),
    suffix: randomUUID().slice(0, 8), handlers,
    async drain(done, seconds = 110, registry = handlers) {
      const deadline = Date.now() + seconds * 1_000;
      const failures: string[] = [];
      while (Date.now() < deadline) {
        if (await done()) return;
        const claims = await claimOutboxBatch(worker, `import-test-${harness.suffix}`, 25);
        if (claims.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        for (const claim of claims) {
          await processClaimedEvent(worker, claim, {
            handlers: registry, maxAttempts: MAX_ATTEMPTS,
            // Test only: show why an event failed, so a broken handler is not a silent timeout.
            reportError: (error) => { failures.push(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)); },
          });
        }
        if (failures.length > 0) throw new Error(`A worker event failed:\n${failures.slice(0, 3).join("\n---\n")}`);
      }
      throw new Error("The worker did not finish in time");
    },
    async close() {
      await Promise.all([owner.end(), worker.end(), runtime.end()]);
    },
  };
  return harness;
}

export const csvOf = (rows: string[][]): Uint8Array => new TextEncoder().encode(Papa.unparse(rows, { newline: "\n" }));
