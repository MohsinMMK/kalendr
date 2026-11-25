import { ApiError } from "../api-error";

/**
 * Runs a search and, if it fails for a reason other than a plain refusal, throws a new error that carries no database
 * message. The driver's own message repeats the query parameters, which here are what a person typed (a name, a phone
 * number); the error reporter would otherwise send that text on. The five-character database code is kept for operators.
 */
export async function withoutSearchText<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
    const safe = new Error("The search failed.");
    safe.name = "SearchError";
    if (code && /^[0-9A-Z]{5}$/.test(code)) Object.assign(safe, { code });
    throw safe;
  }
}
