import { z } from "zod";

import { publicBookingFields, requireFullName } from "@/lib/contracts";
import { bookingBotFieldNames, minimumBookingFillMs } from "@/lib/bot-check";
import { normalizePhone } from "@/lib/patient-contact";
import { ApiError } from "@/server/api-error";
import { createAppointment } from "@/server/appointment-repository";
import { canonicalJsonHash } from "@/server/crypto";
import {
  dataResponse,
  enforceLimit,
  getIdempotencyKey,
  parseJsonBody,
  routeErrorResponse,
} from "@/server/http";
import { applyFeatureLimits, loadBusinessProfileBySlug } from "@/server/business-profile";
import { clientAddress, recordRefusal } from "@/server/rate-limit";
import { requireHumanWhenRisky } from "@/server/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The booking form adds two bot filters to the booking: a field people never see (bots fill it)
 * and how long the form was open. A business's own server posting through the website API sends
 * neither, so a missing fill time is not checked. Neither is part of the booking or its hash.
 */
const bookingRequestSchema = publicBookingFields.extend({
  [bookingBotFieldNames.honeypot]: z.string().max(500).optional(),
  [bookingBotFieldNames.fillMs]: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1_000).optional(),
  // Feature 45: how the booking was reached. Not part of the booking or its hash.
  specialLinkToken: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/).optional(),
  // Feature 46: the token of the routing form's answer. Not part of the booking or its hash.
  routingToken: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/).optional(),
  combinedLink: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60).optional(),
}).superRefine(requireFullName);

const refusedMessage = "We could not take this booking. Wait a moment and try again, or call to book.";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const address = clientAddress(request.headers);
    const attempt = await enforceLimit(request, "booking.ip", address);
    const idempotencyKey = getIdempotencyKey(request);
    const {
      [bookingBotFieldNames.honeypot]: honeypot,
      [bookingBotFieldNames.fillMs]: fillMs,
      specialLinkToken,
      combinedLink,
      routingToken,
      ...body
    } = await parseJsonBody(request, bookingRequestSchema, { maxBytes: 64 * 1_024 });
    if (honeypot?.trim()) {
      recordRefusal("bot_check.honeypot");
      throw new ApiError(400, "booking_refused", refusedMessage);
    }
    if (fillMs !== undefined && fillMs < minimumBookingFillMs) {
      recordRefusal("bot_check.too_fast");
      throw new ApiError(400, "booking_refused", refusedMessage);
    }
    // A service can take only a phone or only an email; an empty one must not share a single counter between everyone.
    if (body.phone) await enforceLimit(request, "booking.contact", `phone:${normalizePhone(body.phone)}`);
    if (body.email) await enforceLimit(request, "booking.contact", `email:${body.email.trim().toLowerCase()}`);
    await requireHumanWhenRisky(request, attempt, address);
    const input = applyFeatureLimits(body, await loadBusinessProfileBySlug(body.clinicSlug));
    const result = await createAppointment(
      input,
      idempotencyKey,
      canonicalJsonHash(input),
      { ...(specialLinkToken ? { specialLinkToken } : {}), ...(combinedLink ? { combinedSlug: combinedLink } : {}), ...(routingToken ? { routingToken } : {}) },
    );
    return dataResponse(result, 201);
  } catch (error) {
    return routeErrorResponse(error, "public.appointment.create", requestId);
  }
}
