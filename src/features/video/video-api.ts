/** One request to a video endpoint. Responses are `{ data }` or `{ error: { code, message, fieldErrors? } }`. */
export class VideoApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "unknown",
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "VideoApiError";
  }
}

function readFieldErrors(error: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof error !== "object" || error === null || !("fieldErrors" in error)) return result;
  const raw = (error as { fieldErrors?: unknown }).fieldErrors;
  if (typeof raw !== "object" || raw === null) return result;
  for (const [path, value] of Object.entries(raw)) {
    const message = Array.isArray(value) ? value.find((item): item is string => typeof item === "string") : value;
    if (typeof message === "string" && message) result[path] = message;
  }
  return result;
}

export async function videoCall<T>(
  path: string,
  init?: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers,
      cache: "no-store",
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init?.signal,
    });
  } catch (cause: unknown) {
    if (init?.signal?.aborted) throw cause;
    throw new VideoApiError("We could not reach the server. Check your connection and try again.");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof result !== "object" || result === null || !("data" in result)) {
    const error = typeof result === "object" && result !== null && "error" in result ? (result as { error: unknown }).error : null;
    const message = typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Something went wrong. Try again.";
    const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "unknown";
    throw new VideoApiError(message, response.status, code, readFieldErrors(error));
  }
  return (result as { data: T }).data;
}
