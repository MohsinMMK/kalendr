import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FormAnswers } from "@/lib/booking-forms";
import type {
  PreviewResult, RoutingBuilderOptions, RoutingDraft, RoutingFormDetail, RoutingFormSummary, RoutingReport, WrongAssignmentView,
} from "@/lib/routing-forms";

import { staffKeys } from "../queries/keys";
import { staffMutation, staffQuery } from "../queries/http";

const base = "/api/staff/routing-forms";

export const routingKeys = {
  all: () => [...staffKeys.all, "routing-forms"] as const,
  list: () => [...staffKeys.all, "routing-forms", "list"] as const,
  options: () => [...staffKeys.all, "routing-forms", "options"] as const,
  form: (id: string) => [...staffKeys.all, "routing-forms", "form", id] as const,
  report: (formId: string, from: string, to: string) => [...staffKeys.all, "routing-forms", "report", formId, from, to] as const,
  wrong: (status: "open" | "all") => [...staffKeys.all, "routing-forms", "wrong", status] as const,
};

/** GET /api/staff/routing-forms: every form with its status and responses in the last 30 days. */
export function useRoutingForms(enabled = true) {
  return useQuery({ queryKey: routingKeys.list(), queryFn: ({ signal }) => staffQuery<RoutingFormSummary[]>(base, signal), enabled });
}

/** GET /options: the services, people, attributes and link names the builder offers. */
export function useRoutingOptions(enabled = true) {
  return useQuery({ queryKey: routingKeys.options(), queryFn: ({ signal }) => staffQuery<RoutingBuilderOptions>(`${base}/options`, signal), enabled });
}

export function useRoutingForm(id: string | null) {
  return useQuery({
    queryKey: routingKeys.form(id ?? ""),
    queryFn: ({ signal }) => staffQuery<RoutingFormDetail>(`${base}/${encodeURIComponent(id ?? "")}`, signal),
    enabled: Boolean(id),
    // The builder owns the working copy; a background refetch must never replace what someone is typing.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** The address of the CSV for a report, with the same range the screen shows. */
export function reportQuery(formId: string, from: string, to: string): string {
  const params = new URLSearchParams({ from, to });
  if (formId) params.set("formId", formId);
  return params.toString();
}

export function useRoutingReport(formId: string, from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: routingKeys.report(formId, from, to),
    queryFn: ({ signal }) => staffQuery<RoutingReport>(`${base}/report?${reportQuery(formId, from, to)}`, signal),
    enabled,
  });
}

export function useWrongAssignments(status: "open" | "all", enabled = true) {
  return useQuery({ queryKey: routingKeys.wrong(status), queryFn: ({ signal }) => staffQuery<WrongAssignmentView[]>(`${base}/wrong-assignments?status=${status}`, signal), enabled });
}

export const createRoutingFormRequest = (draft: RoutingDraft, idempotencyKey: string) =>
  staffMutation<RoutingFormDetail>(base, "POST", draft, { idempotencyKey });
export const saveRoutingFormRequest = (id: string, draft: RoutingDraft, expectedRevision: number) =>
  staffMutation<RoutingFormDetail>(`${base}/${encodeURIComponent(id)}`, "PUT", { draft, expectedRevision });
export const publishRoutingFormRequest = (id: string, expectedRevision: number) =>
  staffMutation<RoutingFormDetail>(`${base}/${encodeURIComponent(id)}/publish`, "POST", { expectedRevision });
export const pauseRoutingFormRequest = (id: string, expectedRevision: number) =>
  staffMutation<RoutingFormDetail>(`${base}/${encodeURIComponent(id)}/pause`, "POST", { expectedRevision });
export const deleteRoutingFormRequest = (id: string) => staffMutation<unknown>(`${base}/${encodeURIComponent(id)}`, "DELETE", {});

/** POST /[id]/preview: read-only. Runs the saved form against the answers and writes nothing. */
export function usePreviewRouting(id: string) {
  return useMutation({ mutationFn: (answers: FormAnswers) => staffMutation<PreviewResult>(`${base}/${encodeURIComponent(id)}/preview`, "POST", { answers }) });
}

export function useReviewWrongAssignment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: "fixed" | "dismissed"; expectedVersion: number }) =>
      staffMutation<WrongAssignmentView>(`${base}/wrong-assignments/${encodeURIComponent(input.id)}`, "PATCH", { status: input.status, expectedVersion: input.expectedVersion }),
    onSettled: () => client.invalidateQueries({ queryKey: [...routingKeys.all(), "wrong"] }),
  });
}
