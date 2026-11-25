"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Accessibility, ArrowUpRight, Clock, Languages, Mail, MapPin, Phone, Tag, UserRound } from "lucide-react";

import { PersonAvatar } from "@/components/person-avatar";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "@/components/ui/preview-card";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Patient } from "@/lib/domain";
import { resourceKindLabel } from "@/lib/terminology";
import { cn } from "@/lib/utils";

import { useCatalogLookups } from "./clinic-catalog";
import { channelLabel } from "./clinic-format";
import { useStaffAccess } from "./staff-access";

/** Where each kind of thing opens. */
export const entityHref = {
  customer: (id: string) => `/patients?patient=${id}`,
  practitioner: (id: string) => `/doctors?member=${id}`,
  service: (id: string) => `/services/${id}`,
  resource: () => "/settings?section=patient&tab=edit",
};

const linkClass = "rounded-sm underline-offset-4 decoration-muted-foreground/50 outline-none hover:underline focus-visible:underline focus-visible:decoration-2";

function Fact({ icon: Icon, children }: { icon: typeof Phone; children: ReactNode }) {
  return <li className="flex min-w-0 items-start gap-2 text-muted-foreground">
    <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <span className="min-w-0 flex-1 wrap-break-word text-foreground">{children}</span>
  </li>;
}

/**
 * A name that is a link to its own page and, on hover or focus, shows a small card about it.
 * Without a page to go to (no permission), it is plain text that still shows the card.
 */
function EntityLink({ href, label, className, children, card }: { href?: string; label: string; className?: string; children: ReactNode; card: ReactNode }) {
  return <PreviewCard>
    <PreviewCardTrigger delay={350} closeDelay={150} className={cn(href && linkClass, className)} render={href ? <Link href={href} /> : <span tabIndex={0} />}>
      {children}
    </PreviewCardTrigger>
    <PreviewCardPopup className="w-72 flex-col gap-3 p-3" role="dialog" aria-label={label}>
      {card}
      {href ? <Link href={href} className="inline-flex items-center gap-1 self-start text-xs font-medium underline-offset-4 hover:underline">Open<ArrowUpRight className="size-3" aria-hidden="true" /></Link> : null}
    </PreviewCardPopup>
  </PreviewCard>;
}

function CardHead({ name, sub, image }: { name: string; sub?: string; image?: string | null }) {
  return <div className="flex items-center gap-2.5">
    <PersonAvatar name={name} image={image} className="size-9" />
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{name}</span>
      {sub ? <span className="truncate text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  </div>;
}

export function CustomerLink({ id, name, patient, phone, className, children }: { id: string; name: string; patient?: Patient; phone?: string; className?: string; children?: ReactNode }) {
  const t = useTerms();
  const tel = patient?.phone ?? phone;
  return <EntityLink href={entityHref.customer(id)} label={`${t.Customer}: ${name}`} className={className} card={<>
    <CardHead name={name} sub={t.Customer} />
    <ul className="flex flex-col gap-1.5 text-xs">
      {tel ? <Fact icon={Phone}><span className="tabular-nums">{tel}</span></Fact> : null}
      {patient?.email ? <Fact icon={Mail}>{patient.email}</Fact> : null}
      {patient?.preferredChannel ? <Fact icon={Languages}>Prefers {channelLabel(patient.preferredChannel)}</Fact> : null}
      {patient?.accessibilityNeed ? <Fact icon={Accessibility}>{patient.accessibilityNeed}</Fact> : null}
    </ul>
  </>}>{children ?? name}</EntityLink>;
}

export function PractitionerLink({ id, name: fallback, className, children }: { id: string; name?: string; className?: string; children?: ReactNode }) {
  const catalog = useCatalogLookups();
  const t = useTerms();
  const person = catalog.getPractitioner(id);
  const name = person?.name ?? fallback ?? catalog.practitionerName(id);
  const places = (person?.locationIds ?? []).map((location) => catalog.locationName(location)).filter(Boolean);
  return <EntityLink href={entityHref.practitioner(id)} label={`${t.Practitioner}: ${name}`} className={className} card={<>
    <CardHead name={name} sub={[person?.title, person?.specialty].filter(Boolean).join(" · ") || t.Practitioner} image={person?.photoUrl} />
    <ul className="flex flex-col gap-1.5 text-xs">
      {person?.phone ? <Fact icon={Phone}><span className="tabular-nums">{person.phone}</span></Fact> : null}
      {person?.languages ? <Fact icon={Languages}>{person.languages}</Fact> : null}
      {places.length > 1 ? <Fact icon={MapPin}>{places.join(", ")}</Fact> : null}
      {person?.bio ? <li className="line-clamp-3 text-muted-foreground">{person.bio}</li> : null}
    </ul>
  </>}>{children ?? name}</EntityLink>;
}

export function ServiceLink({ id, name: fallback, className, children }: { id: string; name?: string; className?: string; children?: ReactNode }) {
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const service = catalog.getService(id);
  const name = service?.name ?? fallback ?? catalog.serviceName(id);
  const people = (service?.practitionerIds ?? []).map((person) => catalog.practitionerName(person));
  return <EntityLink href={access.can("services.manage") ? entityHref.service(id) : undefined} label={`Service: ${name}`} className={className} card={<>
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">{name}</span>
      {service?.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{service.description}</span> : null}
    </div>
    <ul className="flex flex-col gap-1.5 text-xs">
      {service ? <Fact icon={Clock}><span className="tabular-nums">{service.durationMinutes} min</span></Fact> : null}
      {service?.priceLabel ? <Fact icon={Tag}>{service.priceLabel}</Fact> : null}
      {people.length ? <Fact icon={UserRound}>{people.length > 3 ? `${people.slice(0, 3).join(", ")} and ${people.length - 3} more` : people.join(", ")}</Fact> : null}
    </ul>
  </>}>{children ?? name}</EntityLink>;
}

export function ResourceLink({ id, className, children }: { id: string; className?: string; children?: ReactNode }) {
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const t = useTerms();
  const resource = catalog.getResource(id);
  const name = resource?.name ?? catalog.resourceName(id);
  return <EntityLink href={access.can("settings.manage") ? entityHref.resource() : undefined} label={`${t.Resource}: ${name}`} className={className} card={<>
    <span className="font-medium">{name}</span>
    <ul className="flex flex-col gap-1.5 text-xs">
      {resource ? <Fact icon={Tag}>{resourceKindLabel(resource.kind)}</Fact> : null}
      {resource ? <Fact icon={MapPin}>{catalog.locationName(resource.locationId)}</Fact> : null}
    </ul>
  </>}>{children ?? name}</EntityLink>;
}

