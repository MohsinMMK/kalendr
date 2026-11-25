import "server-only";

import { dehydrate, QueryClient, type DehydratedState } from "@tanstack/react-query";

/**
 * Staff data loaded with the page (TanStack Query's server prefetch), so the first HTML carries it instead of
 * waiting for the scripts and then a request. A query that fails is left out and the browser asks for it as
 * before. A fresh client per request, so nothing is shared between people.
 */
export async function prefetchStaffData(fill: (client: QueryClient) => Promise<void>): Promise<DehydratedState> {
  const client = new QueryClient();
  await fill(client);
  return dehydrate(client);
}

/** The value as the API would send it (`Response.json`), so the browser's cache holds the shape its own fetch returns. */
export function asApiJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
