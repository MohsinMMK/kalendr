"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { StaffApiError, isDataResponse, readApiError, readFieldErrors, staffQuery } from "../queries/http";
import { staffKeys } from "../queries/keys";
import type { ImportJob, ImportKind, ImportMapping, ImportOptions, ImportRowView, ImportSetup, ImportStatus, PreviewRow, RowStatus } from "./types";
import { pollingStatuses } from "./types";

const base = "/api/staff/imports";

export const importKeys = {
  list: () => [...staffKeys.all, "imports", "list"] as const,
  job: (id: string) => [...staffKeys.all, "imports", "job", id] as const,
  rows: (id: string, status: RowStatus) => [...staffKeys.all, "imports", "rows", id, status] as const,
};

export const sampleUrl = (kind: ImportKind) => `${base}/samples/${kind}`;
export const errorsUrl = (id: string) => `${base}/${encodeURIComponent(id)}/errors`;

/** A version conflict means someone else (or another tab) changed the job since this screen loaded it. */
export function isVersionConflict(error: unknown): boolean {
  return error instanceof StaffApiError && (error.status === 409 || error.code === "version_conflict");
}

export function isPolling(status: ImportStatus | undefined): boolean {
  return status !== undefined && pollingStatuses.includes(status);
}

async function send(path: string, init: RequestInit, fallback: string): Promise<unknown> {
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let code = "unknown";
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = body.error;
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") code = error.code;
    }
    throw new StaffApiError(readApiError(body, fallback), response.status, code, readFieldErrors(body));
  }
  return body;
}

function dataOf(body: unknown): unknown {
  return isDataResponse(body) ? body.data : null;
}

// ---- Setup kept in this tab so a reload can still show the column step. ----

const setupKey = (id: string) => `kalendr-import-setup-${id}`;

export function rememberSetup(setup: ImportSetup): void {
  try { window.sessionStorage.setItem(setupKey(setup.job.id), JSON.stringify({ headers: setup.headers, suggestedMapping: setup.suggestedMapping, fields: setup.fields })); } catch { /* storage may be blocked */ }
}

export function recallSetup(id: string): Omit<ImportSetup, "job"> | null {
  try {
    const raw = window.sessionStorage.getItem(setupKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("headers" in parsed) || !("fields" in parsed)) return null;
    return parsed as Omit<ImportSetup, "job">;
  } catch {
    return null;
  }
}

// ---- Reads ----

export function useImportList(enabled: boolean) {
  return useQuery({
    queryKey: importKeys.list(),
    queryFn: async ({ signal }) => (await staffQuery<{ jobs: ImportJob[] }>(base, signal)).jobs,
    enabled,
  });
}

/** Answer of GET one job. The server may also hand back the file's columns, which saves the browser from remembering them. */
export type JobAnswer = { job: ImportJob } & Partial<Omit<ImportSetup, "job">>;

export function useImportJob(id: string | null) {
  return useQuery({
    queryKey: importKeys.job(id ?? "none"),
    queryFn: ({ signal }) => staffQuery<JobAnswer>(`${base}/${encodeURIComponent(id ?? "")}`, signal),
    enabled: id !== null,
    // Poll only while the server is working; a finished job stops asking.
    refetchInterval: (query) => (isPolling(query.state.data?.job.status) ? 1500 : false),
  });
}

export function useImportRows(id: string, status: RowStatus, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: importKeys.rows(id, status),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ status, limit: "50" });
      if (pageParam) params.set("cursor", pageParam);
      return staffQuery<{ rows: ImportRowView[]; nextCursor: string | null }>(`${base}/${encodeURIComponent(id)}/rows?${params.toString()}`, signal);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

// ---- Writes ----

function putJob(client: QueryClient, job: ImportJob): void {
  client.setQueryData<JobAnswer>(importKeys.job(job.id), (current) => ({ ...current, job }));
  void client.invalidateQueries({ queryKey: importKeys.list() });
}

export function useUploadImport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, kind }: { file: File; kind: ImportKind }) => {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      const body = await send(base, { method: "POST", body: form }, "The file could not be uploaded. Check your connection and try again.");
      return dataOf(body) as ImportSetup;
    },
    onSuccess: (setup) => {
      rememberSetup(setup);
      putJob(client, setup.job);
    },
  });
}

export interface MappingResult {
  job: ImportJob;
  preview: PreviewRow[];
}

export function useSaveMapping(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { mapping: ImportMapping; options: ImportOptions; expectedVersion: number }) => {
      const body = await send(`${base}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }, "Your choices could not be saved.");
      return dataOf(body) as MappingResult;
    },
    onSuccess: ({ job }) => putJob(client, job),
  });
}

function useJobAction(id: string, name: "check" | "commit" | "undo") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { expectedVersion?: number } | void) => {
      const body = await send(`${base}/${encodeURIComponent(id)}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
      }, "That did not start. Try again in a moment.");
      return body;
    },
    // The job moves on at the server; ask again so the screen starts following it.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: importKeys.job(id) });
      void client.invalidateQueries({ queryKey: importKeys.list() });
    },
  });
}

export const useStartCheck = (id: string) => useJobAction(id, "check");
export const useCommitImport = (id: string) => useJobAction(id, "commit");
export const useUndoImport = (id: string) => useJobAction(id, "undo");

export function useDiscardImport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { await send(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" }, "This import could not be discarded."); },
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: importKeys.job(id) });
      void client.invalidateQueries({ queryKey: importKeys.list() });
    },
  });
}
