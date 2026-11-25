import { profileWords } from "@/lib/terminology";
import { getManageSnapshot } from "@/server/appointment-repository";
import { loadBusinessProfileBySlug } from "@/server/business-profile";
import { customerInviteEntry } from "@/server/calendar-invite";
import { createAppointmentCalendar } from "@/server/icalendar";
import { routeErrorResponse } from "@/server/http";
import { requireLiveManageLink } from "@/server/patient-step-up";
import { resolveManageToken } from "@/server/appointment-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CalendarRouteContext {
  params: Promise<{ token: string }>;
}

export async function GET(
  _request: Request,
  context: CalendarRouteContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();

  try {
    const { token } = await context.params;
    await requireLiveManageLink(token);
    const snapshot = await getManageSnapshot(token);
    const resolved = await resolveManageToken(token);
    // A request waiting on a service that hides its address leaves the place out of the invite (the snapshot already blanked it).
    const entry = resolved ? await customerInviteEntry(resolved.tenant_id, resolved.appointment_id, { hidePlace: !snapshot.location.name }) : undefined;
    const calendar = createAppointmentCalendar({
      appointmentId: snapshot.appointment.id,
      version: snapshot.appointment.version,
      status: snapshot.appointment.status,
      startsAt: snapshot.appointment.startsAt,
      endsAt: snapshot.appointment.endsAt,
      clinicName: snapshot.clinic.name,
      clinicPhone: snapshot.clinic.phone,
      serviceName: snapshot.service.name,
      practitionerName: snapshot.practitioner.name,
      // Blank while a request waits on a service that hides its address (the snapshot already blanked them).
      locationName: snapshot.location.name,
      locationAddress: snapshot.location.address,
      locationCity: snapshot.location.city,
      words: profileWords(await loadBusinessProfileBySlug(snapshot.clinic.slug)),
      ...(entry ? { entry } : {}),
    });

    return new Response(calendar, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="kalendr-appointment.ics"',
        "Content-Type": "text/calendar; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return routeErrorResponse(error, "public.appointment.calendar", requestId);
  }
}
