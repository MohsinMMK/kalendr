import { getBusinessType, resourceKindLabels, type BusinessTypePreset } from "@/lib/business-types";
import { demoPractitioners, demoResources, demoServices } from "@/lib/demo-data";
import type { Clinic, Practitioner, Resource, Service } from "@/lib/domain";

/**
 * The preview's sample data is a dental clinic. When someone previews Kalendr as another kind of business,
 * the same sample records are shown under that business's own service, team and resource names, so a
 * salon preview never shows "Routine cleaning" or "Dr. Asha Mehta".
 *
 * Only what people read changes. Ids, durations, links and resource kinds stay the same, because the
 * preview's slot and booking checks compare these records with the stored sample, which keeps its kinds.
 */

const clinicTypes = new Set(["healthcare", "dental"]);

/** Extra names for business types whose starter set has fewer services than the sample. */
const spareServices = [
  { name: "Follow-up", description: "A shorter appointment after an earlier one." },
  { name: "Longer appointment", description: "More time for a bigger job. We confirm a suitable time." },
  { name: "Quick check-in", description: "A short slot to touch base." },
];

const sampleTeam = [
  { name: "Asha Mehta", initials: "AM" },
  { name: "Rohan Shah", initials: "RS" },
  { name: "Mira Sen", initials: "MS" },
];

const demoServiceNames = new Map(demoServices.map((service) => [service.id, service.name]));
const demoTeamNames = new Map(demoPractitioners.map((person) => [person.id, person.name]));
const demoResourceNames = new Map(demoResources.map((resource) => [resource.id, resource.name]));

function usesSampleClinicData(clinic: Pick<Clinic, "businessType"> | null | undefined) {
  return !clinic?.businessType || clinicTypes.has(clinic.businessType);
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sampleKind(preset: BusinessTypePreset) {
  return preset.resourceKinds[0] ?? "room";
}

function serviceText(preset: BusinessTypePreset, index: number) {
  // The first starter is the general visit; the sample services stand for the specific ones after it.
  const starters = preset.starterServices.slice(1);
  return starters[index] ?? spareServices[(index - starters.length) % spareServices.length];
}

/** The sample drawings are of a dental clinic, so other business types never show them. */
function withoutSampleDrawing(service: Service): Service {
  return service.imageUrl?.startsWith("/demo/dental/") ? { ...service, imageUrl: null } : service;
}

function previewService(service: Service, preset: BusinessTypePreset): Service {
  const index = demoServices.findIndex((item) => item.id === service.id);
  // Only rename sample services nobody has renamed in the preview.
  if (index < 0 || service.name !== demoServiceNames.get(service.id)) return withoutSampleDrawing(service);
  const text = serviceText(preset, index);
  return {
    ...service,
    name: text.name,
    description: text.description,
    imageUrl: null,
    // The sample groups are dental words, so other business types show no chips.
    category: undefined,
  };
}

function previewPerson(person: Practitioner, preset: BusinessTypePreset): Practitioner {
  const index = demoPractitioners.findIndex((item) => item.id === person.id);
  if (index < 0 || person.name !== demoTeamNames.get(person.id)) return person;
  const sample = sampleTeam[index] ?? sampleTeam[0];
  return {
    ...person,
    name: sample.name,
    initials: sample.initials,
    title: index === 0 ? preset.providerFields.titlePlaceholder : capitalise(preset.terms.provider.singular),
    specialty: preset.providerFields.specialtyPlaceholder,
  };
}

function previewResource(resource: Resource, preset: BusinessTypePreset): Resource {
  const index = demoResources.findIndex((item) => item.id === resource.id);
  if (index < 0 || resource.name !== demoResourceNames.get(resource.id)) return resource;
  return { ...resource, name: `${resourceKindLabels[sampleKind(preset)]} ${index + 1}` };
}

/** Sample services under the preview business type's own names. Clinics keep the sample as it is. */
export function previewServicesFor(clinic: Pick<Clinic, "businessType"> | null | undefined, services: Service[] = demoServices): Service[] {
  if (usesSampleClinicData(clinic)) return services;
  const preset = getBusinessType(clinic?.businessType);
  return services.map((service) => previewService(service, preset));
}

/** The sample team under neutral names and the business type's own job titles. */
export function previewTeamFor(clinic: Pick<Clinic, "businessType"> | null | undefined, team: Practitioner[] = demoPractitioners): Practitioner[] {
  if (usesSampleClinicData(clinic)) return team;
  const preset = getBusinessType(clinic?.businessType);
  return team.map((person) => previewPerson(person, preset));
}

/** Sample rooms and chairs named after the business type's first resource kind. */
export function previewResourcesFor(clinic: Pick<Clinic, "businessType"> | null | undefined, resources: Resource[] = demoResources): Resource[] {
  if (usesSampleClinicData(clinic)) return resources;
  const preset = getBusinessType(clinic?.businessType);
  return resources.map((resource) => previewResource(resource, preset));
}

/** A preview booking's service, team member and business, in the preview business type's own words. */
export function inPreviewWords<T extends { clinic: Clinic; service: Service; practitioner: Practitioner }>(snapshot: T, clinic: Clinic): T {
  return {
    ...snapshot,
    clinic,
    service: previewServicesFor(clinic, [snapshot.service])[0],
    practitioner: previewTeamFor(clinic, [snapshot.practitioner])[0],
  };
}
