"use client";

import { useMemo, useSyncExternalStore } from "react";

import { demoClinic, demoLocations } from "@/lib/demo-data";
import { getPreviewBusinessClinic, getServerPreviewBusinessClinic, subscribePreviewBusiness } from "@/lib/preview-business-profile";
import { previewResourcesFor, previewServicesFor, previewTeamFor } from "@/lib/preview-sample";
import { getPreviewDoctorState, getServerPreviewDoctorState, subscribePreviewDoctors, type PreviewDoctorState } from "@/lib/preview-doctors";
import type {
  Clinic,
  Location,
  Practitioner,
  Resource,
  Service,
} from "@/lib/domain";
import type { ClinicCatalog, StaffSnapshot } from "@/lib/staff-snapshot";
import { profileWords, resolveBusinessProfile } from "@/lib/terminology";

import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

export interface CatalogLookups {
  database: boolean;
  clinic: Clinic;
  locations: Location[];
  services: Service[];
  practitioners: Practitioner[];
  resources: Resource[];
  snapshot: StaffSnapshot | null;
  getService: (id: string) => Service | undefined;
  getPractitioner: (id: string) => Practitioner | undefined;
  getResource: (id: string) => Resource | undefined;
  getLocation: (id: string) => Location | undefined;
  serviceName: (id: string) => string;
  practitionerName: (id: string) => string;
  resourceName: (id: string) => string;
  locationName: (id: string) => string;
}

function previewCatalog({ doctors, services }: PreviewDoctorState, clinic: Clinic = demoClinic): ClinicCatalog {
  return {
    clinic,
    profile: resolveBusinessProfile(clinic),
    locations: demoLocations,
    services: previewServicesFor(clinic, services),
    practitioners: previewTeamFor(clinic, doctors),
    resources: previewResourcesFor(clinic),
    initialSlots: [],
    preview: true,
  };
}

export function catalogLookups(catalog: ClinicCatalog, historicalNames?: StaffSnapshot["historicalNames"]): CatalogLookups {
  const servicesById = new Map(catalog.services.map((item) => [item.id, item]));
  const practitionersById = new Map(catalog.practitioners.map((item) => [item.id, item]));
  const resourcesById = new Map(catalog.resources.map((item) => [item.id, item]));
  const locationsById = new Map(catalog.locations.map((item) => [item.id, item]));
  return {
    database: !catalog.preview,
    clinic: catalog.clinic,
    locations: catalog.locations,
    services: catalog.services,
    practitioners: catalog.practitioners,
    resources: catalog.resources,
    snapshot: null,
    getService: (id) => servicesById.get(id),
    getPractitioner: (id) => practitionersById.get(id),
    getResource: (id) => resourcesById.get(id),
    getLocation: (id) => locationsById.get(id),
    serviceName: (id) => servicesById.get(id)?.name ?? historicalNames?.services[id] ?? "Service",
    practitionerName: (id) => practitionersById.get(id)?.name ?? historicalNames?.practitioners[id] ?? profileWords(catalog.profile).Practitioner,
    resourceName: (id) => resourcesById.get(id)?.name ?? "Room",
    locationName: (id) => locationsById.get(id)?.name ?? historicalNames?.locations[id] ?? "Location",
  };
}

export function useCatalogLookups(): CatalogLookups {
  const staff = useOptionalStaffSnapshot();
  const snapshot = staff?.snapshot ?? null;
  const doctors = useSyncExternalStore(subscribePreviewDoctors, getPreviewDoctorState, getServerPreviewDoctorState);
  const previewClinic = useSyncExternalStore(subscribePreviewBusiness, getPreviewBusinessClinic, getServerPreviewBusinessClinic);
  return useMemo(
    () => ({ ...catalogLookups(snapshot?.catalog ?? previewCatalog(doctors, previewClinic), snapshot?.historicalNames), snapshot }),
    [doctors, previewClinic, snapshot],
  );
}

export function clinicDayBounds(dateKey: string): { from: string; to: string } {
  return { from: `${dateKey}T00:00:00+05:30`, to: `${dateKey}T23:59:59+05:30` };
}
