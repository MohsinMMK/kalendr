import { describe, expect, it } from "vitest";

import { demoClinic, demoPractitioners, demoResources, demoServices } from "@/lib/demo-data";
import { previewClinicWith } from "@/lib/preview-business-profile";
import { inPreviewWords, previewResourcesFor, previewServicesFor, previewTeamFor } from "@/lib/preview-sample";

const clinicWords = /dental|dentist|cleaning|implant|filling|operatory|hygien|patient|Dr\./i;

describe("preview sample data", () => {
  it("keeps the dental sample for clinics", () => {
    expect(previewServicesFor(demoClinic)).toBe(demoServices);
    expect(previewTeamFor({ businessType: "healthcare" })).toBe(demoPractitioners);
    expect(previewResourcesFor(demoClinic)).toBe(demoResources);
  });

  it("shows a salon its own services, team and stations with no clinic words", () => {
    const salon = previewClinicWith({ businessType: "wellness", terminology: {}, features: {} });
    const services = previewServicesFor(salon);
    const team = previewTeamFor(salon);
    const resources = previewResourcesFor(salon);

    expect(salon.name).toBe("Indiranagar Salon");
    expect(services.map((service) => service.name)).toEqual(["Haircut", "Hair colour", "Manicure", "Massage"]);
    expect(team.map((person) => person.name)).toEqual(["Asha Mehta", "Rohan Shah", "Mira Sen"]);
    expect(team[0].title).toBe("Senior stylist");
    expect(resources.map((resource) => resource.name)).toEqual(["Station 1", "Station 2", "Station 3"]);

    // Only what people read: ids, slugs and internal kinds keep their sample values on purpose.
    const text = [
      salon.name, salon.legalName, salon.email,
      ...services.flatMap((service) => [service.name, service.description]),
      ...team.flatMap((person) => [person.name, person.title, person.specialty]),
      ...resources.map((resource) => resource.name),
    ].join(" ");
    expect(text).not.toMatch(clinicWords);
  });

  it("keeps ids, durations and links so sample bookings still work", () => {
    const agency = previewClinicWith({ businessType: "real_estate", terminology: {}, features: {} });
    const services = previewServicesFor(agency);
    expect(services.map((service) => service.id)).toEqual(demoServices.map((service) => service.id));
    expect(services.map((service) => service.durationMinutes)).toEqual(demoServices.map((service) => service.durationMinutes));
    expect(services.map((service) => service.resourceKind)).toEqual(demoServices.map((service) => service.resourceKind));
    expect(services[0].practitionerIds).toEqual(demoServices[0].practitionerIds);
  });

  it("fills in names when a type has fewer starter services than the sample", () => {
    const other = previewClinicWith({ businessType: "other", terminology: {}, features: {} });
    const names = previewServicesFor(other).map((service) => service.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.join(" ")).not.toMatch(clinicWords);
  });

  it("shows the dental sample with its drawings", () => {
    const dental = previewClinicWith({ businessType: "dental", terminology: {}, features: {} });
    expect(dental.logoUrl).toBe("/demo/dental/logo.svg");
    expect(dental.coverUrl).toBe("/demo/dental/cover.svg");
    expect(Object.fromEntries(previewServicesFor(dental).map((service) => [service.id, service.imageUrl]))).toEqual({
      service_cleaning: "/demo/dental/cleaning.svg",
      service_consultation: "/demo/dental/consultation.svg",
      service_implant: "/demo/dental/implant.svg",
      service_filling: "/demo/dental/filling.svg",
    });
  });

  it("never shows a salon the dental drawings", () => {
    const salon = previewClinicWith({ businessType: "wellness", terminology: {}, features: {} });
    expect(salon.logoUrl).toBeNull();
    expect(salon.coverUrl).toBeNull();
    expect(previewServicesFor(salon).map((service) => service.imageUrl)).toEqual([null, null, null, null]);
    // Even a sample service renamed in the preview drops the dental drawing.
    const renamed = { ...demoServices[0], name: "Signature cut" };
    expect(previewServicesFor(salon, [renamed])[0].imageUrl).toBeNull();
    const booking = inPreviewWords({ clinic: demoClinic, service: demoServices[1], practitioner: demoPractitioners[0] }, salon);
    expect(booking.service.imageUrl).toBeNull();
    expect(booking.clinic.logoUrl).toBeNull();
  });

  it("leaves records renamed in the preview alone", () => {
    const salon = previewClinicWith({ businessType: "wellness", terminology: {}, features: {} });
    const renamed = { ...demoServices[0], name: "Signature cut" };
    expect(previewServicesFor(salon, [renamed])[0].name).toBe("Signature cut");
  });

  it("puts a preview booking in the business's own words", () => {
    const salon = previewClinicWith({ businessType: "wellness", terminology: {}, features: {} });
    const snapshot = inPreviewWords({ clinic: demoClinic, service: demoServices[0], practitioner: demoPractitioners[0] }, salon);
    expect(snapshot.clinic.name).toBe("Indiranagar Salon");
    expect(snapshot.service.name).toBe("Haircut");
    expect(snapshot.practitioner.name).toBe("Asha Mehta");
  });
});
