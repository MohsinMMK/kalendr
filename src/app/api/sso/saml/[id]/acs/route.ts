import { NextResponse } from "next/server";
import { z } from "zod";

import { absolute, finishSamlSignIn, ssoErrorPath } from "@/server/enterprise/sso-flow";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const formSchema = z.object({ SAMLResponse: z.string().min(50).max(300_000), RelayState: z.string().max(500).optional() });

/**
 * Public. The identity provider posts the signed reply here (a cross-site form post, so no cookie is used). The reply is
 * checked, a one-time ticket is made, and the browser is sent on to trade the ticket for a session.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "sso.ip");
    const { id } = await params;
    const raw = Object.fromEntries((await request.formData()).entries());
    const parsed = formSchema.safeParse({ SAMLResponse: raw.SAMLResponse, ...(typeof raw.RelayState === "string" && raw.RelayState ? { RelayState: raw.RelayState } : {}) });
    if (!parsed.success) return NextResponse.redirect(absolute(ssoErrorPath("invalid_response")), 303);
    return NextResponse.redirect(absolute(await finishSamlSignIn(id, parsed.data)), 303);
  } catch (error: unknown) {
    return routeErrorResponse(error, "sso.saml.acs", requestId);
  }
}
