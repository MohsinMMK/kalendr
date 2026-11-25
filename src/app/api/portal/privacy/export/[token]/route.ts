import { enforceLimit, routeErrorResponse } from "@/server/http";
import { consumeExportDownload } from "@/server/privacy/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The link in the export email. It works once and expires after 7 days; the token in the address is the only
 * credential, so no sign-in is needed. A used, expired or unknown link all answer 410 with the same words.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "privacy_download.ip");
    const { token } = await context.params;
    const download = await consumeExportDownload(token);
    return new Response(new Uint8Array(download.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${download.filename}"`,
        "Content-Length": String(download.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.privacy.export", requestId);
  }
}
