/**
 * The browser side of the staff API: one place that sends a request and turns a failed answer into an
 * error a receptionist can read. Every screen's data layer (react-query fetchers and mutations) goes through here.
 */

/** A staff request the server refused. `code` is the API's own code, such as `version_conflict`. */
export class StaffApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Messages by field path, such as `fields.2.showWhen.0.fieldId`, when the server named the fields. */
  readonly fieldErrors: Record<string, string[]>;
  /** Structured facts the server attached, such as the plan limit behind a `plan_limit` refusal. */
  readonly details: unknown;

  constructor(message: string, status = 0, code = "unknown", fieldErrors: Record<string, string[]> = {}, details: unknown = undefined) {
    super(message);
    this.name = "StaffApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}

export function isDataResponse(value: unknown): value is { data: unknown } {
  return typeof value === "object" && value !== null && "data" in value;
}

export function readApiError(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = value.error;
    if (typeof error === "object" && error !== null) {
      if ("fieldErrors" in error && error.fieldErrors && typeof error.fieldErrors === "object") {
        for (const entry of Object.values(error.fieldErrors as Record<string, unknown>)) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].trim()) return entry[0];
        }
      }
      if ("message" in error && typeof error.message === "string") return error.message;
    }
  }
  return fallback;
}

export function readApiDetails(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = value.error;
    if (typeof error === "object" && error !== null && "details" in error) return error.details;
  }
  return undefined;
}

function readApiCode(value: unknown): string {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = value.error;
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  }
  return "unknown";
}

export function readFieldErrors(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (typeof value !== "object" || value === null || !("error" in value)) return result;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("fieldErrors" in error) || typeof error.fieldErrors !== "object" || error.fieldErrors === null) return result;
  for (const [path, entry] of Object.entries(error.fieldErrors as Record<string, unknown>)) {
    if (Array.isArray(entry)) result[path] = entry.filter((item): item is string => typeof item === "string");
  }
  return result;
}

async function readBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function staffMutation<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: unknown,
  options?: { idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(path, { method, headers, body: JSON.stringify(body) });
  const result = await readBody(response);
  if (!response.ok || !isDataResponse(result)) {
    throw new StaffApiError(readApiError(result, "The change could not be saved."), response.status, readApiCode(result), readFieldErrors(result), readApiDetails(result));
  }
  return result.data as T;
}

/** Sends a file to a staff route as multipart form data; the browser sets the boundary. */
export async function staffUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: "POST", body: form });
  const result = await readBody(response);
  if (!response.ok || !isDataResponse(result)) {
    throw new StaffApiError(readApiError(result, "The picture could not be saved."), response.status, readApiCode(result));
  }
  return result.data as T;
}

export async function staffQuery<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal });
  const result = await readBody(response);
  if (!response.ok || !isDataResponse(result)) {
    throw new StaffApiError(readApiError(result, "This could not be loaded."), response.status, readApiCode(result), {}, readApiDetails(result));
  }
  return result.data as T;
}
