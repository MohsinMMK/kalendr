import type { Metadata } from "next";

import { scheduleViewParam } from "@/features/clinic/schedule-view";
import { NewAppointmentTask } from "@/features/clinic/new-appointment-task";
import { currentStaffWords } from "@/server/business-profile";
import { requirePageAccess } from "@/server/staff-page-guard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentStaffWords();
  return {
    title: `Add ${t.appointment}`,
    description: `Create ${t.aBusiness} preview ${t.appointment} with a compatible opening.`,
  };
}

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ from?: string; date?: string; view?: string; location?: string; service?: string; start?: string; practitioner?: string; resource?: string; patient?: string }> }) {
  await requirePageAccess("appointment-new");
  const context = await searchParams;
  const from = context.from === "schedule" ? "schedule" : "dashboard";
  const view = scheduleViewParam(context.view);
  return <NewAppointmentTask from={from} initialDate={context.date} initialView={view} initialLocation={context.location} initialService={context.service} initialStart={context.start} initialPractitioner={context.practitioner} initialPatient={context.patient} initialResource={context.resource} />;
}
