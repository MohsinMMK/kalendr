import { z } from "zod";

import {
  getManageSnapshot,
  manageAppointment,
  recordHeardFrom,
} from "@/server/appointment-repository";
import { ApiError } from "@/server/api-error";
import { heardFromAnswerSchema, manageAppointmentActionSchema } from "@/server/contracts";
import { finishStepUp, requireLiveManageLink, requireStepUp } from "@/server/patient-step-up";
import {
  dataResponse,
  enforceLimit,
  parseJsonBody,
  routeErrorResponse,
} from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tokenSchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);

interface ManageRouteContext {
  params: Promise<{ token: string }>;
}

export async function GET(
  _request: Request,
  context: ManageRouteContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await requireLiveManageLink(token);
    return dataResponse(await getManageSnapshot(token));
  } catch (error) {
    return routeErrorResponse(error, "public.appointment.read", requestId);
  }
}

export async function PATCH(
  request: Request,
  context: ManageRouteContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await requireLiveManageLink(token);
    await enforceLimit(request, "manage_link.token", token);
    const input = await parseJsonBody(request, z.union([heardFromAnswerSchema, manageAppointmentActionSchema]));
    // How they found the business is the only thing saved without an action and a version.
    if ("heardFrom" in input) return dataResponse(await recordHeardFrom(token, input.heardFrom));
    // Cancelling or moving asks for a one-time code unless this device is the customer's own (feature 8).
    const stepUp = input.action === "confirm" ? null : await requireStepUp(request.headers, token);
    const result = await manageAppointment(token, input);
    await finishStepUp(stepUp);
    return dataResponse(result);
  } catch (error) {
    return routeErrorResponse(error, "public.appointment.manage", requestId);
  }
}

async function readToken(context: ManageRouteContext): Promise<string> {
  const { token } = await context.params;
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  return parsed.data;
}
