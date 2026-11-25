import { sql, type SQL } from "drizzle-orm";

/** A list of ids as one text[] parameter: `ARRAY['a', 'b']::text[]`. A bare JS array would be spread into a row of parameters. */
export function textArray(values: readonly string[]): SQL {
  return values.length === 0 ? sql`ARRAY[]::text[]` : sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}
