import { defaultBusinessProfile, profileWords, type TermWords } from "@/lib/terminology";

export type SetupGap =
  "service" | "resource" | "practitioner" | "assignment" | "hours";

export interface ClinicSetupState {
  complete: boolean;
  missing: SetupGap[];
  bookingPath: string;
}

export function clinicSetupState(input: {
  slug: string;
  services: Array<{
    resourceKind?: string;
    isActive?: boolean;
    practitionerIds?: string[];
    locationIds?: string[];
  }>;
  practitioners: Array<{
    id: string;
    isActive?: boolean;
    locationIds?: string[];
  }>;
  resources: Array<{ kind: string; locationId?: string; isActive?: boolean }>;
  activeLocationIds?: string[];
  practitionerIdsWithHours: string[];
}): ClinicSetupState {
  const missing: SetupGap[] = [];
  const services = input.services.filter(
    (service) => service.isActive !== false,
  );
  const practitioners = input.practitioners.filter(
    (person) => person.isActive !== false,
  );
  if (services.length === 0) missing.push("service");
  const resources = input.resources.filter(
    (resource) => resource.isActive !== false,
  );
  if (
    services.some(
      (service) =>
        service.resourceKind &&
        !resources.some(
          (resource) =>
            resource.kind === service.resourceKind &&
            (!service.locationIds?.length ||
              !resource.locationId ||
              service.locationIds.includes(resource.locationId)),
        ),
    )
  )
    missing.push("resource");
  if (practitioners.length === 0) missing.push("practitioner");
  else {
    const eligiblePeople = (service: (typeof services)[number]) =>
      practitioners.filter(
        (person) =>
          (!service.practitionerIds ||
            service.practitionerIds.includes(person.id)) &&
          (!service.locationIds ||
            !person.locationIds ||
            service.locationIds.some(
              (id) =>
                person.locationIds?.includes(id) &&
                (!input.activeLocationIds ||
                  input.activeLocationIds.includes(id)),
            )),
      );
    if (services.some((service) => eligiblePeople(service).length === 0))
      missing.push("assignment");
    if (
      !practitioners.some((person) =>
        input.practitionerIdsWithHours.includes(person.id),
      ) ||
      services.some(
        (service) =>
          eligiblePeople(service).length > 0 &&
          !eligiblePeople(service).some((person) =>
            input.practitionerIdsWithHours.includes(person.id),
          ),
      )
    )
      missing.push("hours");
  }
  return {
    complete: missing.length === 0,
    missing,
    bookingPath: `/book/${input.slug}`,
  };
}

/** The next setup step, in the business's own words. Defaults to the healthcare words. */
export function nextSetupLabel(missing: SetupGap[], words?: TermWords, clinical = true): string {
  const t = words ?? profileWords(defaultBusinessProfile);
  switch (missing[0]) {
    case "service":
      return `Add ${clinical ? "a service" : t.aService} ${t.customers} can book`;
    case "resource":
      return clinical ? "Add a room or chair" : `Add ${t.aResource}`;
    case "practitioner":
      return `Add ${t.aPractitioner}`;
    case "hours":
      return `Set working hours so ${t.customers} can see openings`;
    case "assignment":
      return `Connect ${t.aPractitioner} to each ${clinical ? "service" : t.service} and ${t.location}`;
    default:
      return clinical ? "Finish clinic setup" : "Finish setup";
  }
}
