import "server-only";

import { addDays } from "date-fns";
import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, invoiceLinks } from "@/db/schema";
import type { InvoiceLinkResult } from "@/lib/invoicing-contracts";

import { ApiError } from "../api-error";
import { createOpaqueToken, sha256 } from "../crypto";
import { getFileStore } from "../file-store";
import { isPreviewMode } from "../preview-repository";
import { loadRecordKeys, openBytes } from "../record-crypto";
import { assertInvoiceVisibleHere } from "./invoice";
import { requirePermission, type StaffContext } from "../staff-context";

/** A link works for 90 days. Making a new one never cancels the earlier ones. */
const LINK_DAYS = 90;

/** A fresh tokenised link to an invoice's (or one of its credit notes') PDF. Only the token's hash is stored. */
export async function createInvoiceLink(context: StaffContext, invoiceId: string, creditNoteId: string | null, origin: string): Promise<InvoiceLinkResult> {
  requirePermission(context, "payments.collect");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Invoice links are not available in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    const [invoice] = await transaction.execute<{ id: string }>(sql`select id from invoices where tenant_id = ${context.tenantId} and id = ${invoiceId}`);
    if (!invoice) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
    await assertInvoiceVisibleHere(transaction, context, invoiceId);
    if (creditNoteId) {
      const [note] = await transaction.execute<{ id: string }>(sql`select id from credit_notes where tenant_id = ${context.tenantId} and id = ${creditNoteId} and invoice_id = ${invoiceId}`);
      if (!note) throw new ApiError(404, "credit_note_not_found", "That credit note could not be found.");
    }
    const token = createOpaqueToken();
    const expiresAt = addDays(new Date(), LINK_DAYS);
    await transaction.insert(invoiceLinks).values({
      tenantId: context.tenantId, invoiceId: creditNoteId ? null : invoiceId, creditNoteId, tokenHash: sha256(token), expiresAt, createdByUserId: context.userId,
    });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "invoice.link_made", outcome: "success", metadata: { invoiceId, creditNoteId },
    });
    return { url: `${origin}/api/public/invoices/${token}`, expiresAt: expiresAt.toISOString() };
  });
}

export type PublicInvoice = { state: "ready"; bytes: Buffer; filename: string } | { state: "preparing" } | { state: "unknown" };

/** The PDF behind a link. The token is the only credential, so an unknown or expired one answers exactly the same. */
export async function readInvoiceByToken(token: string): Promise<PublicInvoice> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return { state: "unknown" };
  const resolved = await resolveLink(sha256(token));
  if (!resolved) return { state: "unknown" };
  const found = await withTenant(resolved.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ file_key: string | null; number: string }>(resolved.creditNoteId
      ? sql`select d.file_key, c.number from credit_notes c left join invoice_documents d on d.tenant_id = c.tenant_id and d.credit_note_id = c.id
            where c.tenant_id = ${resolved.tenantId} and c.id = ${resolved.creditNoteId}`
      : sql`select d.file_key, i.number from invoices i left join invoice_documents d on d.tenant_id = i.tenant_id and d.invoice_id = i.id
            where i.tenant_id = ${resolved.tenantId} and i.id = ${resolved.invoiceId}`);
    if (!row) return null;
    if (!row.file_key) return { fileKey: null, number: row.number };
    await loadRecordKeys(transaction, resolved.tenantId);
    return { fileKey: row.file_key, number: row.number };
  });
  if (!found) return { state: "unknown" };
  if (!found.fileKey) return { state: "preparing" };
  const bytes = openBytes(resolved.tenantId, await getFileStore().get(found.fileKey));
  return { state: "ready", bytes, filename: `${found.number.replace(/[^A-Za-z0-9-]/g, "-")}.pdf` };
}

async function resolveLink(tokenHash: string): Promise<{ tenantId: string; invoiceId: string | null; creditNoteId: string | null } | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<{ tenant_id: string; invoice_id: string | null; credit_note_id: string | null }>(sql`select * from kalendr_resolve_invoice_link(${tokenHash})`);
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, invoiceId: row.invoice_id, creditNoteId: row.credit_note_id } : null;
}
