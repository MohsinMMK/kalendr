import { getIdempotencyKey } from "./http";

/** Creating routes honour an Idempotency-Key when the screen sends one, so a double click makes one. */
export function optionalIdempotencyKey(request: Request): string | null {
  return request.headers.get("idempotency-key") ? getIdempotencyKey(request) : null;
}

export function requiredQuery(request: Request, name: string): string {
  return new URL(request.url).searchParams.get(name) ?? "";
}
