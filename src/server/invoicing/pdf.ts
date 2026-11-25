import type { PdfDocumentInput } from "./pdf-document";

export type { PdfDocumentInput, PdfLine } from "./pdf-document";
export { formatPdfMoney } from "./format";

/**
 * The invoice PDF bytes. The PDF engine (`@react-pdf/renderer`) is loaded on first use, not when the worker starts: it has to be
 * loaded as an ES module, and a worker that failed to load it would otherwise fail to start at all and stop every other job.
 */
export async function renderInvoicePdf(input: PdfDocumentInput): Promise<Buffer> {
  const { renderInvoicePdfNow } = await import("./pdf-document");
  return renderInvoicePdfNow(input);
}
