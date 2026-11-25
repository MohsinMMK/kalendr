import { z } from "zod";

import { reportKeys, reportParamsSchema } from "../lib/reports";
import { reportFilename, reportToCsv } from "../server/reports/csv";
import { buildReport } from "../server/reports";
import { postgresRunner } from "../server/workflows/runner";
import type { EventHandler } from "./handlers/types";

const payloadSchema = z.object({ exportId: z.string().min(1) });
const scopeSchema = z.object({ practitionerId: z.string().nullable(), locationId: z.string().nullable(), locationIds: z.array(z.string()).nullish(), canSeeRevenue: z.boolean() });

/**
 * Builds a large report export (feature 26). The job row holds the visibility the person had when they asked, so the file
 * never holds more than they could see on screen. The CSV is written into the row and downloaded from an authenticated route.
 */
export function reportExportHandler(): EventHandler {
  return async (tenantDb, event) => {
    const payload = payloadSchema.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const [job] = await tenantDb`select id, report, params, scope, status from report_exports where tenant_id = ${event.tenantId} and id = ${payload.data.exportId} for update`;
    if (!job || job.status !== "pending") return "delivered";
    const fail = async (code: string) => {
      await tenantDb`update report_exports set status = 'failed', failure_code = ${code} where tenant_id = ${event.tenantId} and id = ${payload.data.exportId}`;
      return "delivered" as const;
    };
    const report = z.enum(reportKeys).safeParse(job.report);
    const params = reportParamsSchema.safeParse(job.params);
    const scope = scopeSchema.safeParse(job.scope);
    if (!report.success || !params.success || !scope.success) return fail("invalid_job");
    const [tenant] = await tenantDb`select timezone from tenants where id = ${event.tenantId}`;
    const result = await buildReport(report.data, {
      run: postgresRunner(tenantDb), params: params.data, timezone: String(tenant?.timezone ?? "Asia/Kolkata"), now: new Date(),
      scope: {
        tenantId: event.tenantId, locationId: scope.data.locationId ?? undefined, ...(scope.data.locationIds?.length ? { locationIds: scope.data.locationIds } : {}), practitionerId: scope.data.practitionerId ?? undefined,
        forcedPractitioner: scope.data.practitionerId !== null, canSeeRevenue: scope.data.canSeeRevenue,
      },
    });
    await tenantDb`
      update report_exports set status = 'ready', body = ${reportToCsv(result)}, filename = ${reportFilename(report.data, params.data.from, params.data.to)}, ready_at = now()
      where tenant_id = ${event.tenantId} and id = ${payload.data.exportId}`;
    return "delivered";
  };
}
