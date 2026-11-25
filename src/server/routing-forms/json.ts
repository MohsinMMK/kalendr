/**
 * Raw SQL (`transaction.execute`) hands back a jsonb column as text through this driver, while the query builder parses it.
 * This reads either, so a stored value comes out the same however it was fetched.
 */
export function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
