import type { Metadata } from "next";
import { Armchair, Layers, ListChecks, PanelLeft, SquarePen, UserCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardPanel } from "@/components/ui/card";
import { IndustriesDemo } from "@/features/marketing/industries/industries-demo";
import { allTypes, capitalize } from "@/features/marketing/industries/words";
import { ClosingBand, PageHero, PointGrid, Section, StartActions } from "@/features/marketing/page-parts";
import { businessTypes, resourceKindLabels, type ResourceKind } from "@/lib/business-types";

export const metadata: Metadata = {
  title: "Businesses",
  description:
    "One booking product for salons, tutors, studios, clinics and more, set up in your own words for the people who book, the people who serve them and the bookings themselves.",
};

/** The starter services that need a room, chair or similar, read from the presets, not retyped. */
const resourceExamples = Object.values(businessTypes)
  .flatMap((type) =>
    type.starterServices
      .filter((service): service is typeof service & { requiredResourceKind: ResourceKind } => Boolean(service.requiredResourceKind))
      .map((service) => ({ key: `${type.id}-${service.name}`, service: service.name, kind: service.requiredResourceKind, business: type.label })),
  )
  .filter((item, index, all) => all.findIndex((other) => other.service === item.service && other.kind === item.kind) === index)
  .filter((item) => ["Dental cleaning", "Haircut", "Massage", "Exam preparation"].includes(item.service));

const yours = [
  {
    title: "Rename any word",
    body: "Pick Settings, then Business profile. Change what you call the people who book, the people who serve them, a booking and the rest. Your booking page, messages and staff pages follow.",
    icon: <SquarePen />,
  },
  {
    title: "Name your team's roles",
    body: "Settings, Business profile, Role names. The Team page, invites and the account menu use your names. Customers never see them.",
    icon: <UserCog />,
  },
  {
    title: "Arrange your sidebar",
    body: "Rename pages, drag them into the order you use them and hide the ones you do not. Settings, Help and My profile stay put.",
    icon: <PanelLeft />,
  },
  {
    title: "Start with a general visit",
    body: "Every new business gets a ready-made 30 minute service the owner offers. It is called Consultation for general practice and dental, General visit for salons and shops, General meeting for consulting and General session for tutoring. Edit it or delete it like any service.",
    icon: <ListChecks />,
  },
  {
    title: "Copy a service across branches",
    body: "A service template holds a service's description, lengths, prices and rules. Make one new service per branch from it, and lock the fields you want kept in line.",
    icon: <Layers />,
  },
] as const;

export default function IndustriesPage() {
  return (
    <>
      <PageHero
        eyebrow="Businesses"
        title="One product."
        titleMuted="Your own words."
        lead="Kalendr is set up for the business you run. A salon books clients with stylists. A tutor books students into sessions. A clinic books patients with doctors for visits. The screens and the booking page use those words."
        actions={<StartActions secondary={{ href: "/online-booking", label: "See how booking works" }} />}
        demo={
          <figure aria-label="The same Today screen set up three ways: a salon says clients, stylists and appointments; tutoring says students, tutors and sessions; a clinic says patients, doctors and visits.">
            <div aria-hidden="true">
              <IndustriesDemo />
            </div>
          </figure>
        }
      />

      <Section
        id="types"
        title="Pick your business."
        lead="Choosing a type when you set up sets the starting words, services and features. Everything below can be changed later."
      >
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {allTypes.map((type) => (
            <li key={type.id} className="min-w-0">
              <Card className="h-full">
                <CardPanel className="flex h-full flex-col gap-3 p-5">
                  <div>
                    <h3 className="font-heading text-lg font-semibold">{type.label}</h3>
                    <p className="mt-1 text-pretty text-sm text-muted-foreground">{type.description}</p>
                    <p className="mt-1 text-pretty text-xs text-muted-foreground">{capitalize(type.examples)}</p>
                  </div>
                  <ul aria-label={`Words for ${type.label}`} className="mt-auto flex flex-wrap gap-1.5">
                    {type.words.map((word) => (
                      <li key={word}>
                        <Badge variant="outline">{word}</Badge>
                      </li>
                    ))}
                  </ul>
                </CardPanel>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="yours"
        title="Then make it yours."
        lead="The type is a starting point. Change the words, the roles and the sidebar in Settings, so staff see the names your business already uses."
      >
        <PointGrid points={yours} />
      </Section>

      <Section
        id="resources"
        title="A room or a chair, booked with the person."
        lead="Some bookings need more than a person. Mark a service as needing a room, chair, station or piece of equipment, and a time is offered only when both are free. Two people cannot book the last one at once."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {resourceExamples.map((item) => (
              <li key={item.key} className="flex items-center gap-3 text-sm">
                <Armchair aria-hidden="true" className="size-5 shrink-0 text-primary" />
                <span>
                  <span className="font-medium">{item.service}</span>
                  <span className="text-muted-foreground"> needs a {resourceKindLabels[item.kind].toLowerCase()} · {item.business}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="max-w-prose text-pretty text-muted-foreground">
            These are the starter services Kalendr suggests at setup. You choose which rooms and equipment you have, and which services use them. A clinic can book a dental chair with the doctor; a studio can book a room with the instructor.
          </p>
        </div>
      </Section>

      <ClosingBand title="Set it up in your words." />
    </>
  );
}
