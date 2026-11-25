import { sql } from "drizzle-orm";

import { financialYearOf, formatInvoiceNumber } from "../../lib/gst";
import { asNumber, type Runner } from "../workflows/runner";

export interface DrawnNumber {
  financialYear: string;
  series: string;
  sequence: number;
  number: string;
}

/**
 * The next gapless number for a business, financial year and series (feature 24). It bumps the counter row inside the
 * caller's own transaction: the upsert takes the row lock, so two issuers queue up behind each other, and a rollback
 * puts the counter back with everything else, so a failed issue never burns a number. Call it as late as possible
 * in the transaction, after every check that can refuse. Written against `Runner` so the web server and the worker share it.
 */
export async function drawNumber(run: Runner, tenantId: string, series: string, moment: Date, timeZone: string): Promise<DrawnNumber> {
  const financialYear = financialYearOf(moment, timeZone);
  const [row] = await run(sql`
    insert into invoice_counters (tenant_id, financial_year, series, last_number)
    values (${tenantId}, ${financialYear}, ${series}, 1)
    on conflict (tenant_id, financial_year, series)
    do update set last_number = invoice_counters.last_number + 1, updated_at = now()
    returning last_number
  `);
  if (!row) throw new Error("The invoice counter returned no row");
  const sequence = asNumber(row.last_number);
  return { financialYear, series, sequence, number: formatInvoiceNumber(series, financialYear, sequence) };
}
