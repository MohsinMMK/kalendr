/**
 * The one way adapters call a provider: a timeout, a bounded body, JSON parsed through zod, and a
 * ProviderError that says whether trying again could help. `fetch` is passed in so tests never touch a network.
 * No "server-only": the worker imports this.
 */
import { z } from "zod";

import { ProviderError } from "./types";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export async function callProvider<T extends z.ZodType>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  schema: T,
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch {
    throw new ProviderError("provider_unreachable", true, "The payment provider could not be reached.");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError("provider_response_too_large", false);
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    const code = response.status === 401 || response.status === 403 ? "provider_rejected_keys" : retryable ? "provider_unavailable" : "provider_rejected_request";
    throw new ProviderError(code, retryable, `The payment provider answered ${response.status}.`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ProviderError("provider_unexpected_response", false, "The payment provider's answer was not in the expected shape.");
  return parsed.data;
}
