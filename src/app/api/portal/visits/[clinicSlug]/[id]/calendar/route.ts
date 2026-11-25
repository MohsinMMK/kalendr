import { profileWords } from "@/lib/terminology";
import { getPortalManageSnapshot } from "@/server/appointment-repository";
import { loadBusinessProfile } from "@/server/business-profile";
import { routeErrorResponse } from "@/server/http";
import { customerInviteEntry } from "@/server/calendar-invite";
import { createAppointmentCalendar } from "@/server/icalendar";
import { requirePatientAccount } from "@/server/patient-auth";
import { resolvePortalVisit } from "@/server/patient-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ clinicSlug: string; id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, id } = await context.params;
    const visit = await resolvePortalVisit(await requirePatientAccount(request.headers), clinicSlug, id);
    const snapshot = await getPortalManageSnapshot(visit.tenantId, visit.appointmentId);
    const entry = await customerInviteEntry(visit.tenantId, visit.appointmentId, { hidePlace: !snapshot.location.name });
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
      locationName: snapshot.location.name,
      locationAddress: snapshot.location.address,
      locationCity: snapshot.location.city,
      words: profileWords(await loadBusinessProfile(visit.tenantId)),
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
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.visit.calendar", requestId);
  }
}
