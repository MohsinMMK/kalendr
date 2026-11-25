"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { ExternalLink, GripVertical, ImageIcon, Link2, MapPin, X } from "lucide-react";

import { OptionSelect, SelectField, TextField, TextareaField } from "@/components/form-fields";
import { ImageUpload } from "@/components/image-upload";
import { ServiceEditorButton } from "./service-editor";
import { Sortable, SortableItem, SortableItemHandle } from "@/components/reui/sortable";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Group, GroupSeparator } from "@/components/ui/group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { unusedPresetsForBusiness, type AppointmentTypePreset } from "@/lib/appointment-types";
import { isClinicalBusinessType } from "@/lib/business-types";
import { capitalize, resourceKindLabel } from "@/lib/terminology";
import type { BookingMode, Service } from "@/lib/domain";
import { visitTypeCreateBody, visitTypeUpdateBody } from "@/lib/visit-type-write";
import { formatHoursSummary } from "@/lib/working-hours";
import { getDurationLabel, phoneHref } from "@/features/booking/booking-format";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";

import { arrangeList, serviceOrderList, serviceOrderPage, withListLayout } from "@/lib/workspace-layout";

import { useCatalogLookups } from "./clinic-catalog";
import { MinutesField } from "./onboarding-choice";
import { BookingLimitsButton } from "./booking-limits-panel";
import { ResourcesSettings } from "./resources-settings";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { usePageLayout } from "./workspace-layout-provider";


/** Healthcare and dental say "visit type"; every other business uses its own word for what can be booked. */
function useBookableWords() {
  const t = useTerms();
  const profile = useBusinessProfile();
  const clinical = isClinicalBusinessType(profile.businessType);
  const many = clinical ? "visit types" : t.services;
  return { t, profile, clinical, many, Many: capitalize(many), kind: clinical ? "visit" : t.service };
}

export function PatientPageSettings() {
  // `?tab=edit` opens the editing side and `?service=<id>` that service's editor, so links from elsewhere land on them.
  const [mode, setMode] = useQueryState("tab", parseAsStringLiteral(["view", "edit"] as const).withDefault("view"));
  const [service] = useQueryState("service");
  const [message, setMessage] = useState("");
  const t = useTerms();
  const router = useRouter();

  // The service editor is a page now. An older link with `?service=<id>` lands on it, in the same tab.
  useEffect(() => {
    if (service) router.replace(`/services/${encodeURIComponent(service)}`);
  }, [service, router]);

  return (
    <>
    <Tabs value={mode} onValueChange={(value) => void setMode(value === "edit" ? "edit" : null)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <TabsList aria-label={`${t.Customer} page`}>
          <TabsTab value="view">View</TabsTab>
          <TabsTab value="edit">Edit</TabsTab>
        </TabsList>
        {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
        <Link href="/services" className="text-sm font-medium text-primary underline-offset-4 hover:underline">Manage your {t.services}</Link>
      </div>
      <TabsPanel value="view"><PatientPageView /></TabsPanel>
      <TabsPanel value="edit"><PatientPageEdit onMessage={setMessage} /></TabsPanel>
    </Tabs>
    </>
  );
}

/** The public booking link with this service already chosen, so owners never build a URL from an id. */
export function serviceBookingUrl(origin: string, slug: string, serviceId: string): string {
  return `${origin}/book/${encodeURIComponent(slug)}?service=${encodeURIComponent(serviceId)}`;
}

function CopyServiceLink({ slug, service }: { slug: string; service: Service }) {
  async function copy() {
    const url = serviceBookingUrl(window.location.origin, slug, service.id);
    try {
      await navigator.clipboard.writeText(url);
      toastManager.add({ title: `Link to ${service.name} copied.`, description: "It opens your booking page with this already chosen.", type: "success" });
    } catch {
      toastManager.add({ title: "Could not copy the link.", description: url, type: "error" });
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={`Copy link to book ${service.name}`}>
      <Link2 aria-hidden="true" />
      Copy link
    </Button>
  );
}

function PatientPageView() {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const hours = formatHoursSummary(staff?.snapshot?.availability ?? []) || (catalog.database ? "Not set yet" : "Mon–Sat 8:30 am–5:30 pm");
  const visibleTypes = catalog.services.filter((service) => service.isActive !== false);
  const { t, clinical } = useBookableWords();

  return (
    <Frame className="mt-3">
      <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Choose {t.aLocation} and {t.visit}</h3>
          <FrameDescription className="text-xs">This is the page {t.customers} use to book. Usual hours: {hours}.</FrameDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {catalog.clinic.phone ? (
            <Button variant="ghost" size="sm" render={<a href={phoneHref(catalog.clinic.phone)} />}>
              Call {t.business}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" render={<Link href={`/b/${catalog.clinic.slug}`} />}>
            Open your page
            <ExternalLink aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" render={<Link href={`/book/${catalog.clinic.slug}`} />}>
            Open booking
            <ExternalLink aria-hidden="true" />
          </Button>
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Kalendr</p>
          <p className="truncate text-sm font-medium">Booking for {catalog.clinic.name}</p>
        </div>
        {catalog.locations.length ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">{catalog.locations.length === 1 ? `${t.Business} ${t.location}` : `${t.Business} ${t.locations}`}</h4>
            {catalog.locations.map((location) => (
              <div key={location.id} className="flex items-start gap-3 rounded-lg border p-3">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{location.name}</p>
                  <p className="text-xs text-muted-foreground">{[location.address, location.city].filter(Boolean).join(", ") || "No address yet"}</p>
                </div>
                {catalog.database ? <BookingLimitsButton scope="location" scopeId={location.id} label={location.name} variant="ghost" /> : null}
              </div>
            ))}
          </section>
        ) : null}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{clinical ? "Reason for visit" : t.Services}</h4>
          {visibleTypes.length === 0 ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyDescription>No {t.services} are visible yet. Open Edit to add the {t.visits} {t.customers} can book.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {visibleTypes.map((service) => (
                <li key={service.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 p-3">
                  <ServiceThumbnail url={service.imageUrl} />
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-sm font-medium">{service.name}</p>
                    <p className="text-xs text-muted-foreground">{service.description}</p>
                  </div>
                  <p className="flex shrink-0 gap-3 text-xs text-muted-foreground tabular-nums sm:flex-col sm:items-end sm:gap-0.5">
                    <span>{getDurationLabel(service.durationMinutes)}</span>
                    {service.priceLabel ? <span>{service.priceLabel}</span> : null}
                  </p>
                  <div className="flex w-full justify-end sm:w-auto sm:self-center">
                    <CopyServiceLink slug={catalog.clinic.slug} service={service} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </FramePanel>
    </Frame>
  );
}

/** A small 4:3 picture of the service, or a quiet tile when it has none. */
function ServiceThumbnail({ url }: { url?: string | null }) {
  return (
    <div className="relative flex aspect-[4/3] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-accent">
      {url ? (
        <Image src={url} alt="" fill unoptimized sizes="64px" className="object-cover" />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}

interface VisitTag {
  key: string;
  id?: string;
  name: string;
  description: string;
  durationMinutes: number;
  bookingMode: BookingMode;
  priceLabel: string;
  category: string;
  resourceKind: string;
  practitionerIds: string[];
  /** Where it is offered. Empty means every location, as when it was created. */
  locationIds: string[];
}

function visitTagFromService(service: Service): VisitTag {
  return {
    key: service.id,
    id: service.id,
    name: service.name,
    description: service.description,
    durationMinutes: service.durationMinutes,
    bookingMode: service.bookingMode,
    priceLabel: service.priceLabel ?? "",
    category: service.category ?? "",
    resourceKind: service.resourceKind ?? "",
    practitionerIds: service.practitionerIds,
    locationIds: service.locationIds,
  };
}

/** What the clinic PATCH takes. Empty optional names are left out so they are never sent as blanks. */
export function clinicProfileBody(fields: { name: string; legalName: string; phone: string; locationName: string; address: string; city: string; about: string }) {
  const legalName = fields.legalName.trim();
  const locationName = fields.locationName.trim();
  return {
    name: fields.name,
    phone: fields.phone,
    address: fields.address,
    city: fields.city,
    about: fields.about.trim() || null,
    ...(legalName ? { legalName } : {}),
    ...(locationName ? { locationName } : {}),
  };
}

function PatientPageEdit({ onMessage }: { onMessage: (value: string) => void }) {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const location = catalog.locations[0];
  const [name, setName] = useState(catalog.clinic.name);
  const [legalName, setLegalName] = useState(catalog.clinic.legalName ?? "");
  const [locationName, setLocationName] = useState(location?.name ?? "");
  const [phone, setPhone] = useState(catalog.clinic.phone);
  const [address, setAddress] = useState(location?.address ?? "");
  const [city, setCity] = useState(location?.city ?? "");
  const [about, setAbout] = useState(catalog.clinic.about ?? "");
  const [pending, setPending] = useState(false);
  const t = useTerms();

  if (!catalog.database) {
    return (
      <Empty className="mt-3">
        <EmptyHeader>
          <EmptyDescription>{t.Business} details and {t.services} are saved on the {t.business} database. The preview uses {catalog.clinic.name}.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  async function saveClinic() {
    setPending(true);
    onMessage("");
    try {
      await staffMutation("/api/staff/clinic", "PATCH", clinicProfileBody({ name, legalName, phone, locationName, address, city, about }));
      await staff?.refresh();
      toastManager.add({ title: `${t.Customers} now see this ${t.business} name, phone, and address.`, type: "success" });
    } catch (cause: unknown) {
      onMessage(cause instanceof Error ? cause.message : `Could not save ${t.business} details.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-4">
      <form onSubmit={(event) => { event.preventDefault(); void saveClinic(); }}>
        <Frame>
          <FrameHeader>
            <h3 className="text-sm font-semibold">{t.Business} {t.customers} call</h3>
            <FrameDescription className="text-xs">Name, phone, address, and a few lines about you on the booking page.</FrameDescription>
          </FrameHeader>
          <FramePanel className="grid gap-4 sm:grid-cols-2">
            <TextField id="clinic-name" label={`${t.Business} name`} value={name} onChange={(event) => setName(event.target.value)} required />
            <TextField id="clinic-legal-name" label="Legal name" optional hint="The registered name, used on invoices and records." value={legalName} onChange={(event) => setLegalName(event.target.value)} />
            <TextField id="clinic-phone" label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} required />
            {location ? <TextField id="clinic-location-name" label={`${t.Location} name`} value={locationName} onChange={(event) => setLocationName(event.target.value)} required /> : null}
            <TextField id="clinic-address" label="Address" value={address} onChange={(event) => setAddress(event.target.value)} required />
            <TextField id="clinic-city" label="City" value={city} onChange={(event) => setCity(event.target.value)} required />
            <div className="sm:col-span-2">
              <TextareaField id="clinic-about" label="About" optional maxLength={1500} hint={`A few lines on your ${t.business}, shown on your page.`} value={about} onChange={(event) => setAbout(event.target.value)} className="min-h-24" />
            </div>
          </FramePanel>
          <FrameFooter className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner aria-hidden="true" /> : null}
              {pending ? "Saving…" : `Save ${t.business} details`}
            </Button>
          </FrameFooter>
        </Frame>
      </form>
      <ReasonForVisitEditor pending={pending} onPending={setPending} onMessage={onMessage} />
      <ResourcesSettings />
    </div>
  );
}

function ReasonForVisitEditor({
  pending,
  onPending,
  onMessage,
}: {
  pending: boolean;
  onPending: (value: boolean) => void;
  onMessage: (value: string) => void;
}) {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  // The order tags were dragged into is saved with the business's workspace layout, like other arrangement settings.
  const { layout, canEdit: canReorder, update: updateLayout } = usePageLayout(serviceOrderPage);
  const orderLayout = layout.lists?.[serviceOrderList];
  const savedTypes = useMemo(
    () => arrangeList(catalog.services.filter((service) => service.isActive !== false), orderLayout).map(({ item }) => visitTagFromService(item)),
    [catalog.services, orderLayout],
  );
  const [draft, setDraft] = useState<VisitTag[] | null>(null);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const types = draft ?? savedTypes;
  const [selectedKey, setSelectedKey] = useState(types[0]?.key ?? "");
  const [newName, setNewName] = useState("");
  const [newMinutes, setNewMinutes] = useState("30");
  const { t, profile, clinical, many, Many, kind } = useBookableWords();
  const unused = unusedPresetsForBusiness(profile.businessType, catalog.clinic.name, types.map((type) => type.name));
  const fallbackDescription = clinical ? "A scheduled clinic visit." : `A scheduled ${t.appointment}.`;
  const resourceOptions = clinical
    ? [{ value: "", label: "None" }, { value: "chair", label: "Chair" }, { value: "room", label: "Room" }]
    : [{ value: "", label: "None" }, ...profile.resourceKinds.map((value) => ({ value, label: resourceKindLabel(value) }))];
  const selected = types.find((type) => type.key === selectedKey) ?? types[0];

  function setTypes(next: VisitTag[], nextSelected = selectedKey) {
    setDraft(next);
    setSelectedKey(next.some((type) => type.key === nextSelected) ? nextSelected : next[0]?.key ?? "");
  }

  function reorderTags(next: VisitTag[]) {
    setTypes(next);
    updateLayout(withListLayout(layout, serviceOrderList, {
      ...orderLayout,
      order: next.flatMap((type) => (type.id ? [type.id] : [])),
    }));
  }

  function addTag(input: AppointmentTypePreset | { name: string; durationMinutes: number }) {
    if (types.some((type) => type.name.trim().toLowerCase() === input.name.trim().toLowerCase())) {
      onMessage(`${input.name} is already ${clinical ? "a visit type" : t.aService}.`);
      return;
    }
    const tag: VisitTag = {
      key: `new-${crypto.randomUUID()}`,
      name: input.name.trim(),
      description: "description" in input ? input.description : fallbackDescription,
      durationMinutes: input.durationMinutes,
      bookingMode: "bookingMode" in input ? input.bookingMode : "instant",
      priceLabel: "priceLabel" in input ? input.priceLabel ?? "" : "",
      category: "",
      resourceKind: "requiredResourceKind" in input ? input.requiredResourceKind ?? "" : "",
      practitionerIds: catalog.practitioners.filter((person) => person.isActive !== false).map((person) => person.id),
      locationIds: catalog.locations.map((place) => place.id),
    };
    setTypes([...types, tag], tag.key);
    onMessage(`${tag.name} is ready. Save ${many} to show it on the booking page.`);
  }

  function removeTag(key: string) {
    const current = types.find((type) => type.key === key);
    if (current?.id) setRemovedIds((ids) => [...ids, current.id!]);
    const next = types.filter((type) => type.key !== key);
    setTypes(next, selectedKey === key ? next[0]?.key ?? "" : selectedKey);
  }

  function patchSelected(update: Partial<VisitTag>) {
    if (!selected) return;
    setTypes(types.map((type) => type.key === selected.key ? { ...type, ...update } : type), selected.key);
  }

  function takePendingCustomTag(): VisitTag | null {
    const minutes = Number(newMinutes);
    const name = newName.trim();
    if (!name || !Number.isFinite(minutes) || minutes < 5) return null;
    if (types.some((type) => type.name.trim().toLowerCase() === name.toLowerCase())) return null;
    const tag: VisitTag = {
      key: `new-${crypto.randomUUID()}`,
      name,
      description: fallbackDescription,
      durationMinutes: minutes,
      bookingMode: "instant",
      priceLabel: "",
      category: "",
      resourceKind: "",
      practitionerIds: catalog.practitioners.filter((person) => person.isActive !== false).map((person) => person.id),
      locationIds: catalog.locations.map((place) => place.id),
    };
    setNewName("");
    setNewMinutes("30");
    return tag;
  }

  async function saveTypes() {
    const pendingTag = takePendingCustomTag();
    const toSave = pendingTag ? [...types, pendingTag] : types;
    if (pendingTag) setTypes(toSave, pendingTag.key);
    onPending(true);
    onMessage("");
    try {
      for (const id of removedIds) {
        await staffMutation(`/api/staff/services/${id}`, "PATCH", { isActive: false });
      }
      for (const type of toSave) {
        if (type.id) await staffMutation(`/api/staff/services/${type.id}`, "PATCH", visitTypeUpdateBody(type));
        else await staffMutation("/api/staff/services", "POST", visitTypeCreateBody(type));
      }
      await staff?.refresh();
      setDraft(null);
      setRemovedIds([]);
      const hasDoctor = catalog.practitioners.some((person) => person.isActive !== false);
      toastManager.add({
        title: hasDoctor
          ? `${Many} are on the public booking page.`
          : `${Many} saved. Add ${t.aPractitioner} on the ${t.Practitioners} page so ${t.customers} can book them.`,
        type: "success",
      });
    } catch (cause: unknown) {
      onMessage(cause instanceof Error ? cause.message : `Could not save ${many}.`);
    } finally {
      onPending(false);
    }
  }

  return (
    <Frame>
      <FrameHeader>
        <h3 className="text-sm font-semibold">{clinical ? "Reason for visit" : t.Services}</h3>
        <FrameDescription className="text-xs">Add each {kind} as a tag with its time. Clear a tag to remove it, then save to update the booking page.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <Sortable
          value={types}
          onValueChange={reorderTags}
          getItemValue={(type) => type.key}
          strategy="grid"
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={`${Many}, in the order shown on your page`}
        >
          {types.length === 0 ? <p className="text-sm text-muted-foreground">No {many} yet.</p> : null}
          {types.map((type) => {
            const selectedType = type.key === (selected?.key ?? "");
            return (
              <SortableItem key={type.key} value={type.key} disabled={!canReorder || types.length < 2} role="group" tabIndex={-1} className="max-w-full">
                <Group className="max-w-full">
                  {canReorder && types.length > 1 ? (
                    <>
                      <SortableItemHandle render={<Button variant={selectedType ? "secondary" : "outline"} size="icon-sm" aria-label={`Move ${type.name}. Press space, then use the arrow keys.`} />}>
                        <GripVertical aria-hidden="true" />
                      </SortableItemHandle>
                      <GroupSeparator />
                    </>
                  ) : null}
                  <Button variant={selectedType ? "secondary" : "outline"} size="sm" className="h-auto min-w-0 whitespace-normal text-start" onClick={() => setSelectedKey(type.key)}>
                    {type.name} · {getDurationLabel(type.durationMinutes)}
                  </Button>
                  <GroupSeparator />
                  <Button variant={selectedType ? "secondary" : "outline"} size="icon-sm" aria-label={`Remove ${type.name}`} onClick={() => removeTag(type.key)}>
                    <X aria-hidden="true" />
                  </Button>
                </Group>
              </SortableItem>
            );
          })}
        </Sortable>
        {unused.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {unused.map((preset) => (
              <Button
                key={preset.name}
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => addTag(preset)}
                className="border-dashed text-muted-foreground"
              >
                Add {preset.name.toLowerCase()}
              </Button>
            ))}
          </div>
        ) : null}
        <form className="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end" onSubmit={(event) => {
          event.preventDefault();
          const minutes = Number(newMinutes);
          if (!newName.trim() || !Number.isFinite(minutes) || minutes < 5) return;
          addTag({ name: newName.trim(), durationMinutes: minutes });
          setNewName("");
          setNewMinutes("30");
        }}>
          <TextField id="visit-tag-name" label="Your own type" value={newName} onChange={(event) => setNewName(event.target.value)} />
          <MinutesField id="visit-tag-minutes" label="Minutes" min={5} max={480} value={newMinutes} onChange={setNewMinutes} />
          <Button type="submit" size="lg" variant="outline" disabled={pending}>Add tag</Button>
        </form>
      </FramePanel>
      {selected ? (
        <form className="contents" onSubmit={(event) => { event.preventDefault(); void saveTypes(); }}>
          <FramePanel className="mt-1 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{selected.name}</p>{selected.id ? <ServiceEditorButton serviceId={selected.id} /> : null}</div>
            {selected.id ? (
              <ImageUpload
                key={selected.id}
                kind="service"
                ownerId={selected.id}
                label="Photo"
                description={`Shown on the booking page. Cropped to 4:3. Saves as soon as you add it.`}
                url={catalog.services.find((service) => service.id === selected.id)?.imageUrl}
                saves={catalog.database}
                onChanged={() => staff?.refresh()}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Save {many} first, then add a photo of {selected.name}.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <MinutesField id="visit-minutes" label="Minutes" min={5} max={480} value={String(selected.durationMinutes)} onChange={(value) => patchSelected({ durationMinutes: Number(value) || selected.durationMinutes })} />
              <TextField id="visit-price" label={`Price ${t.customers} see`} optional value={selected.priceLabel} onChange={(event) => patchSelected({ priceLabel: event.target.value })} />
              <TextField id="visit-category" label="Category" optional maxLength={60} hint={`Groups ${t.services} into filters on your page`} value={selected.category} onChange={(event) => patchSelected({ category: event.target.value })} />
              <div className="flex flex-col items-start gap-2">
                <Label render={<span />}>Booking</Label>
                <OptionSelect aria-label={`Booking mode for ${selected.name}`} value={selected.bookingMode} onValueChange={(value) => patchSelected({ bookingMode: value as BookingMode })} options={[{ value: "instant", label: "Instant booking" }, { value: "request", label: `${t.Business} approval` }]} />
              </div>
              <SelectField label={clinical ? "Chair or room" : t.Resource} value={selected.resourceKind} onValueChange={(value) => patchSelected({ resourceKind: value })} options={resourceOptions.some((option) => option.value === selected.resourceKind) ? resourceOptions : [...resourceOptions, { value: selected.resourceKind, label: capitalize(selected.resourceKind) }]} />
              <div className="sm:col-span-2">
                <TextareaField id="visit-description" label={`What ${t.customers} read`} value={selected.description} onChange={(event) => patchSelected({ description: event.target.value })} className="min-h-20" />
              </div>
            </div>
            <Fieldset className="max-w-none gap-2">
              <FieldsetLegend className="text-sm font-medium">{t.Practitioners} who offer this</FieldsetLegend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {catalog.practitioners.map((person) => (
                  <Label key={person.id} className="min-h-9 font-normal">
                    <Checkbox checked={selected.practitionerIds.includes(person.id)} onCheckedChange={(checked) => patchSelected({ practitionerIds: checked ? [...selected.practitionerIds, person.id] : selected.practitionerIds.filter((id) => id !== person.id) })} />
                    {person.name}{person.isActive === false ? " (inactive)" : ""}
                  </Label>
                ))}
              </div>
            </Fieldset>
            {catalog.locations.length > 1 ? (
              <Fieldset className="max-w-none gap-2">
                <FieldsetLegend className="text-sm font-medium">{t.Locations} that offer this</FieldsetLegend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {catalog.locations.map((place) => (
                    <Label key={place.id} className="min-h-9 font-normal">
                      <Checkbox
                        checked={selected.locationIds.includes(place.id)}
                        disabled={selected.locationIds.length === 1 && selected.locationIds.includes(place.id)}
                        onCheckedChange={(checked) => patchSelected({ locationIds: checked ? [...selected.locationIds, place.id] : selected.locationIds.filter((id) => id !== place.id) })}
                      />
                      {place.name}
                    </Label>
                  ))}
                </div>
              </Fieldset>
            ) : null}
          </FramePanel>
          <FrameFooter className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner aria-hidden="true" /> : null}
              {pending ? "Saving…" : `Save ${many}`}
            </Button>
          </FrameFooter>
        </form>
      ) : (
        <FrameFooter className="flex justify-end">
          <Button disabled={pending} onClick={() => void saveTypes()}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            {pending ? "Saving…" : `Save ${many}`}
          </Button>
        </FrameFooter>
      )}
    </Frame>
  );
}
