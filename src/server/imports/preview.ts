import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";

import type { ImportKind, ImportMapping, ImportOptions, ImportPreviewRow } from "./contracts";
import { applyMapping } from "./map";
import type { ParsedFile } from "./parse";
import { normaliseAppointment, normaliseCustomer, normaliseService, type RowSettings } from "./validate";

/** Country for numbers with no +code: the owner's choice, else the business's holiday country, else India. */
export async function regionFor(transaction: KalendrTransaction, tenantId: string, options: Pick<ImportOptions, "defaultCountry">): Promise<string> {
  if (options.defaultCountry) return options.defaultCountry;
  const [row] = await transaction.execute<{ country: string }>(sql`select country from holiday_settings where tenant_id = ${tenantId}`);
  return row?.country?.toUpperCase() ?? "IN";
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

/**
 * The first five rows the way they will be saved. A field that cannot be read is shown as it was typed, so the owner can
 * see what is wrong. Goes to the signed-in person only; never logged.
 */
export function previewRows(kind: ImportKind, file: ParsedFile, mapping: ImportMapping, settings: RowSettings): ImportPreviewRow[] {
  return file.rows.slice(0, 5).map((row, index) => {
    const raw = applyMapping(row, mapping, kind);
    const values: Record<string, string> = { ...raw };
    if (kind === "customers") {
      const result = normaliseCustomer(raw, settings);
      if (result.ok) {
        const customer = result.value;
        Object.assign(values, {
          firstName: customer.firstName, lastName: customer.lastName, phone: customer.phone, email: customer.email,
          dateOfBirth: customer.dateOfBirth ?? "", preferredChannel: customer.preferredChannel,
        });
        if (raw.messagingConsent !== undefined) values.messagingConsent = yesNo(customer.messagingConsent);
      }
    } else if (kind === "services") {
      const result = normaliseService(raw);
      if (result.ok) {
        const service = result.value;
        Object.assign(values, { name: service.name, durationMinutes: String(service.durationMinutes), price: service.priceLabel ?? "", description: service.description, category: service.category ?? "", mode: service.bookingMode });
      }
    } else {
      const result = normaliseAppointment(raw, settings);
      if (result.ok) Object.assign(values, { startsAt: result.value.date, startTime: result.value.time });
    }
    return { rowNumber: index + 1, values };
  });
}
