import { routeErrorResponse, enforceLimit } from "@/server/http";
import { readInvoiceByToken } from "@/server/invoicing/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const page = (title: string, body: string, status: number, refresh = false): Response =>
  new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">${refresh ? '<meta http-equiv="refresh" content="6">' : ""}<title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#1b1b1f;background:#fafafa}main{max-width:26rem;padding:1.5rem;text-align:center}</style></head><body><main><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></main></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

/** The PDF behind a link a business sent. The token is the only credential; an unknown or expired one looks the same. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "payments.ip");
    const result = await readInvoiceByToken((await context.params).token);
    if (result.state === "ready") {
      return new Response(new Uint8Array(result.bytes), {
        headers: {
          "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${result.filename}"`, "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (result.state === "preparing") return page("Your invoice is being prepared", "This page will refresh by itself in a few seconds.", 202, true);
    return page("This link doesn't work", "It may have expired. Ask the business to send you a new one.", 404);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.invoices.get", requestId);
  }
}
