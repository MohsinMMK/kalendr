import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices } from "@/lib/demo-data";
import { clinicSetupState } from "@/lib/clinic-setup";
import type { StaffSnapshot } from "@/lib/staff-snapshot";
import { resolveBusinessProfile } from "@/lib/terminology";

export const staffSnapshotFixture: StaffSnapshot = {
  catalog: { clinic: demoClinic, profile: resolveBusinessProfile(demoClinic), locations: demoLocations, services: demoServices, practitioners: demoPractitioners, resources: demoResources, initialSlots: [], preview: false },
  patients: [], appointments: [], waitlist: [], recalls: [], team: [], availability: [], scheduleBlocks: [], messages: [],
  setup: clinicSetupState({ slug: demoClinic.slug, services: demoServices, practitioners: demoPractitioners, resources: demoResources, practitionerIdsWithHours: [] }),
  fetchedAt: "initial", historicalNames: { services: {}, practitioners: {}, locations: {} },
  limits: { appointmentsTruncated: false, patientsTruncated: false, waitlistTruncated: false, recallsTruncated: false, appointmentWindow: "test" },
};
