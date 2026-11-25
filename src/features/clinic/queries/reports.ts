import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ExportRequest, ExportStatus, ReportKey, ReportParams, ReportResult } from "@/lib/reports";

import { staffKeys } from "./keys";
import { readApiError, StaffApiError, staffQuery } from "./http";

export const reportKeysQuery = {
  report: (report: ReportKey, params: ReportParams) => [...staffKeys.all, "reports", report, params] as const,
  exports: () => [...staffKeys.all, "reports", "exports"] as const,
};

function search(params: ReportParams): string {
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.locationId) query.set("locationId", params.locationId);
  if (params.practitionerId) query.set("practitionerId", params.practitionerId);
  return query.toString();
}

/** GET /api/staff/reports/[report] */
export function useReport(report: ReportKey, params: ReportParams) {
  return useQuery({
    queryKey: reportKeysQuery.report(report, params),
    queryFn: ({ signal }) => staffQuery<ReportResult>(`/api/staff/reports/${report}?${search(params)}`, signal),
    staleTime: 60_000,
  });
}

/** GET /api/staff/reports/export: the person's own recent exports. Polls while one is being built. */
export function useReportExports(enabled: boolean) {
  return useQuery({
    queryKey: reportKeysQuery.exports(),
    queryFn: ({ signal }) => staffQuery<ExportStatus[]>("/api/staff/reports/export", signal),
    enabled,
    refetchInterval: (query) => (query.state.data?.some((item) => item.status === "pending") ? 3_000 : false),
  });
}

export type ExportResult = { kind: "file"; filename: string; blob: Blob } | { kind: "queued"; id: string };

/** POST /api/staff/reports/export: a short range comes back as the file, a long one as a queued job. */
export function useExportReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: ExportRequest): Promise<ExportResult> => {
      const response = await fetch("/api/staff/reports/export", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new StaffApiError(readApiError(body, "The export could not be made."), response.status);
      }
      if (response.status === 202) {
        const body = (await response.json()) as { data: { id: string } };
        return { kind: "queued", id: body.data.id };
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      return { kind: "file", filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "report.csv", blob: await response.blob() };
    },
    onSuccess: () => client.invalidateQueries({ queryKey: reportKeysQuery.exports() }),
  });
}
