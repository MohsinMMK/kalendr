import type { Metadata } from "next";

import { AppointmentTask } from "@/features/clinic/appointment-task";
import { scheduleViewParam } from "@/features/clinic/schedule-view";
import { currentStaffWords } from "@/server/business-profile";
import { requireStaffPageContext } from "@/server/staff-context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentStaffWords();
  return {
    title: `${t.Appointment} task`,
    description: `Review ${t.aBusiness} ${t.appointment} and complete a scheduling task.`,
  };
}

export default async function AppointmentPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; action?: string; date?: string; view?: string; location?: string; start?: string; practitioner?: string }>;
}) {
  await requireStaffPageContext();
  const [{ id }, { from, action, date, view, location, start, practitioner }] = await Promise.all([params, searchParams]);
  const returnTo = from === "dashboard" || from === "patients" || from === "bookings" ? from : "schedule";
  const initialAction = action === "checkin" || action === "start" || action === "complete" || action === "form_received" || action === "reschedule" || action === "suggest" ? action : undefined;
  const returnView = scheduleViewParam(view);
  return <AppointmentTask appointmentId={id} returnTo={returnTo} returnDate={date} returnView={returnView} returnLocation={location} initialAction={initialAction} initialStart={start} initialPractitioner={practitioner} />;
}
