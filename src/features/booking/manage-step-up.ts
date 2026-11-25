/** Shared by the manage-link screens that may be asked for a one-time code. */

export type StepUpAction = "cancel" | "reschedule" | "contact";

export class ManageRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ManageRequestError";
  }
}

export async function manageRequest<T>(path: string, method: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = typeof payload === "object" && payload !== null && "error" in payload ? (payload as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    throw new ManageRequestError(
      typeof error?.message === "string" && error.message ? error.message : fallback,
      response.status,
      typeof error?.code === "string" ? error.code : undefined,
    );
  }
  return ((payload as { data?: T } | undefined)?.data ?? (payload as T));
}
