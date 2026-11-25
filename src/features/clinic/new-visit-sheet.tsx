"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Search, TriangleAlert, UserPlus, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { InlineDatePicker } from "@/components/date-picker";
import { inlineInputClass } from "@/components/inline-field";
import { PersonAvatar } from "@/components/person-avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { demoAppointments } from "@/lib/demo-data";
import type { Appointment, Patient, TimeSlot } from "@/lib/domain";
import type { TermWords } from "@/lib/terminology";
import type { CustomFieldValue, CustomFieldValues } from "@/lib/visit-fields";

import { clinicDayBounds, useCatalogLookups } from "./clinic-catalog";
import { appointmentDay, appointmentTime } from "./clinic-format";
import { patientName, phoneDigits, searchPatients } from "./patient-directory";
import { appointmentEndForSlot, clinicDateKey, compatibleSlots, usePreviewAppointments } from "./preview-appointments";
import { useStaffAccess } from "./staff-access";
import { OutstandingNotice } from "./outstanding-balance";
import { BookingDiscountControl, useBookingDiscount } from "./booking-discount";
import { LimitOverridePrompt, useLimitOverride } from "./limit-override";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";
import { fetchAvailabilitySlots, staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { mergeCustomFields } from "./use-visit-edits";
import { ChoiceField, type Choice } from "./choice-field";
import { CustomValue, PropertyRows, useVisitProperties, type BuiltInProperty, type VisitProperty } from "./visit-properties";

/** What a page already knows when it opens the booking sheet: the customer, a day, a time it clicked. */
export interface NewVisitPrefill {
  patientId?: string;
  date?: string;
  serviceId?: string;
  practitionerId?: string;
  startsAt?: string;
  locationId?: string;
  resourceId?: string;
  source?: DeskSource;
}

type DeskSource = "phone" | "desk" | "walk_in";
const walkInLookbackMs = 15 * 60_000;

const NewVisitContext = createContext<{ openNewVisit: (prefill?: NewVisitPrefill) => void } | null>(null);

/** The full booking page, for anywhere the sheet isn't mounted. */
function newVisitHref(prefill: NewVisitPrefill): string {
  const params = new URLSearchParams();
  if (prefill.patientId) params.set("patient", prefill.patientId);
  if (prefill.date) params.set("date", prefill.date);
  if (prefill.locationId) params.set("location", prefill.locationId);
  if (prefill.serviceId) params.set("service", prefill.serviceId);
  if (prefill.startsAt) params.set("start", prefill.startsAt);
  if (prefill.practitionerId) params.set("practitioner", prefill.practitionerId);
  if (prefill.resourceId) params.set("resource", prefill.resourceId);
  const query = params.toString();
  return `/appointments/new${query ? `?${query}` : ""}`;
}

/** Opens the booking sheet from anywhere in the workspace; outside it, goes to the booking page. */
export function useNewVisit() {
  const context = useContext(NewVisitContext);
  const router = useRouter();
  return context ?? { openNewVisit: (prefill: NewVisitPrefill = {}) => router.push(newVisitHref(prefill)) };
}

/** Holds the booking sheet, so any page or the header can open it with what it already knows. */
export function NewVisitProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; prefill: NewVisitPrefill; key: number }>({ open: false, prefill: {}, key: 0 });
  // The provider outlives each page, so the sheet closes when the address changes (Back, a link elsewhere).
  const pathname = usePathname();
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    if (state.open) setState({ ...state, open: false });
  }
  const openNewVisit = useCallback((prefill: NewVisitPrefill = {}) => setState((current) => ({ open: true, prefill, key: current.key + 1 })), []);
  const value = useMemo(() => ({ openNewVisit }), [openNewVisit]);
  return (
    <NewVisitContext.Provider value={value}>
      {children}
      <Drawer position="right" open={state.open} onOpenChange={(open) => setState((current) => ({ ...current, open }))}>
        <DrawerPopup showCloseButton variant="inset" className="sm:max-w-[30rem]">
          {state.key ? <NewVisitForm key={state.key} prefill={state.prefill} onDone={() => setState((current) => ({ ...current, open: false }))} /> : null}
        </DrawerPopup>
      </Drawer>
    </NewVisitContext.Provider>
  );
}

function bookingProperties(t: TermWords, manyLocations: boolean): BuiltInProperty[] {
  return [
    { id: "service", label: "Service", icon: "layers", required: true },
    ...(manyLocations ? [{ id: "location", label: "Location", icon: "map-pin", required: true } as BuiltInProperty] : []),
    { id: "practitioner", label: t.Practitioner, icon: "stethoscope" },
    { id: "date", label: "Date", icon: "calendar", required: true },
    { id: "time", label: "Time", icon: "clock", required: true },
    { id: "source", label: "Booked via", icon: "inbox" },
    { id: "reason", label: "Reason", icon: "message-square" },
    { id: "notes", label: "Notes", icon: "sticky-note" },
  ];
}

/** The booking form inside the sheet: who, then the visit's properties, laid out like the visit itself. */
function NewVisitForm({ prefill, onDone }: { prefill: NewVisitPrefill; onDone: () => void }) {
  const { appointments, patients, operations, addAppointment, recordAudit, database } = usePreviewAppointments();
  const t = useTerms();
  const profile = useBusinessProfile();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const access = useStaffAccess();
  const router = useRouter();
  const canBook = database ? access.can("appointments.book") : true;

  const todayKey = clinicDateKey(operations.clockIso);
  const firstDate = /^\d{4}-\d{2}-\d{2}$/.test(prefill.date ?? "") ? prefill.date! : prefill.startsAt ? clinicDateKey(prefill.startsAt) : database ? todayKey : clinicDateKey(demoAppointments[0].startsAt);
  const [patientId, setPatientId] = useState(prefill.patientId ?? "");
  const [newCustomer, setNewCustomer] = useState(false);
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState({ firstName: "", lastName: "", phone: "", email: "" });
  const [source, setSource] = useState<DeskSource>(prefill.source ?? "desk");
  const [locationId, setLocationId] = useState(catalog.locations.some((item) => item.id === prefill.locationId) ? prefill.locationId! : catalog.locations[0]?.id ?? "");
  const [serviceId, setServiceId] = useState(prefill.serviceId ?? "");
  const [practitionerId, setPractitionerId] = useState(prefill.practitionerId ?? "");
  const [date, setDate] = useState(firstDate);
  const [slotKey, setSlotKey] = useState(prefill.startsAt ? `${prefill.startsAt}|${prefill.practitionerId ?? ""}|${prefill.resourceId ?? ""}` : "");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [values, setValues] = useState<CustomFieldValues>({});
  const [remoteSlots, setRemoteSlots] = useState<{ key: string; slots: TimeSlot[] } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const limitOverride = useLimitOverride(`${serviceId}|${slotKey}`);
  const upgrade = useUpgradePrompt();
  const discount = useBookingDiscount();

  const properties = useVisitProperties(bookingProperties(t, catalog.locations.length > 1));
  const patient = patients.find((item) => item.id === patientId);
  const patientType = newCustomer || !patient || !appointments.some((item) => item.patientId === patient.id) ? "new" : "returning";
  const services = catalog.services.filter((item) => item.patientTypes.includes(patientType) && (!item.locationIds.length || item.locationIds.includes(locationId)));
  const service = services.find((item) => item.id === serviceId);
  const people = catalog.practitioners.filter((item) => (!service || service.practitionerIds.includes(item.id)) && (!item.locationIds.length || item.locationIds.includes(locationId)) && item.isActive !== false);
  const walkIn = source === "walk_in";
  const openingsDate = walkIn ? todayKey : date;
  const notBefore = walkIn ? new Date(Date.parse(operations.clockIso) - walkInLookbackMs).toISOString() : operations.clockIso;
  const slotQuery = `${serviceId}|${locationId}|${openingsDate}|${practitionerId}|${walkIn ? "walk_in" : "booked"}`;
  const loading = database && Boolean(service) && remoteSlots?.key !== slotQuery;
  const openings = !service
    ? []
    : database
      ? (remoteSlots?.key === slotQuery ? remoteSlots.slots : [])
      : compatibleSlots({ service, locationId, appointments, patientId: patient?.id, notBefore, dateKey: openingsDate, availability: operations.schedule });
  const keyOf = (slot: TimeSlot) => `${slot.startsAt}|${slot.practitionerId}|${slot.resourceId ?? ""}`;
  // The server can offer the same time and person more than once; for booking they are the same choice.
  const shownOpenings = [...new Map(openings.filter((item) => !practitionerId || item.practitionerId === practitionerId).map((item) => [keyOf(item), item])).values()];
  const slot = shownOpenings.find((item) => keyOf(item) === slotKey)
    ?? shownOpenings.find((item) => slotKey.startsWith(`${item.startsAt}|`) && (!prefill.practitionerId || item.practitionerId === prefill.practitionerId))
    // A walk-in takes the next free opening unless staff pick another.
    ?? (walkIn && !slotKey ? shownOpenings[0] : undefined);

  useEffect(() => {
    if (!database || !serviceId || !locationId) return;
    const controller = new AbortController();
    const key = slotQuery;
    const bounds = clinicDayBounds(openingsDate);
    void fetchAvailabilitySlots({ clinicSlug: catalog.clinic.slug, locationId, serviceId, practitionerId: practitionerId || "first_available", from: bounds.from, to: bounds.to, walkIn }, controller.signal)
      .then((slots) => { if (!controller.signal.aborted) setRemoteSlots({ key, slots }); })
      .catch(() => { if (!controller.signal.aborted) setRemoteSlots({ key, slots: [] }); });
    return () => controller.abort();
  }, [catalog.clinic.slug, database, locationId, openingsDate, practitionerId, serviceId, slotQuery, walkIn]);

  const matches = query.trim() ? searchPatients(patients, query).slice(0, 6) : [];
  const name = newCustomer ? `${person.firstName.trim()} ${person.lastName.trim()}`.trim() : patient ? patientName(patient) : "";

  function validate(): string {
    if (!newCustomer && !patient) return `Choose ${t.aCustomer}, or add a new one.`;
    if (newCustomer) {
      const digits = phoneDigits(person.phone);
      if (person.firstName.trim().length < 2) return "Enter a first name.";
      if (!walkIn && !person.lastName.trim()) return "Enter a last name.";
      if (digits.length < 8 || digits.length > 15 || !/^\+?[\d\s()-]+$/.test(person.phone.trim())) return "Enter a valid phone number.";
      if (database && !walkIn && !person.email.includes("@")) return "Enter an email address.";
    }
    if (!service) return "Choose a service.";
    if (!slot) return "Choose a time.";
    return "";
  }

  function booked(id: string, token?: number) {
    const title = walkIn ? token ? `Token ${token} · ${name}` : `Walk-in checked in · ${name}` : `${t.Appointment} booked · ${name}`;
    const toast = toastManager.add({
      title,
      description: slot ? `${appointmentDay(slot.startsAt)} at ${appointmentTime(slot.startsAt)} with ${catalog.practitionerName(slot.practitionerId)}` : undefined,
      type: "success",
      actionProps: { children: "Open", onClick: () => { toastManager.close(toast); router.push(`/appointments/${id}?from=dashboard`); } },
    });
    onDone();
  }

  async function book() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (!service || !slot) return;
    setError("");
    const customFields = mergeCustomFields(undefined, values);
    if (database) {
      setPending(true);
      try {
        const result = await staffMutation<{ appointmentId: string; queueNumber?: number }>(
          "/api/staff/appointments",
          "POST",
          {
            clinicSlug: catalog.clinic.slug,
            locationId,
            serviceId: service.id,
            practitionerId: slot.practitionerId,
            startsAt: slot.startsAt,
            source,
            ...limitOverride.takeBody(),
            ...discount.body(),
            ...(reason.trim() ? { reasonForVisit: reason.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            ...(customFields ? { customFields } : {}),
            ...(newCustomer
              ? { newPatient: { firstName: person.firstName.trim(), lastName: person.lastName.trim(), phone: person.phone.trim(), email: person.email.trim(), preferredChannel: "sms", isDependent: false, messagingConsent: false } }
              : { patientId: patient!.id }),
          },
          { idempotencyKey: crypto.randomUUID() },
        );
        await staff?.refresh();
        limitOverride.clear();
        booked(result.appointmentId, result.queueNumber);
      } catch (cause: unknown) {
        if (limitOverride.capture(cause) || upgrade.fromError(cause) || discount.capture(cause)) return;
        setError(cause instanceof Error ? cause.message : `Could not book this ${t.appointment}. Choose another time.`);
      } finally {
        setPending(false);
      }
      return;
    }
    const sequence = appointments.length + 1;
    const id = `apt_preview_${sequence}`;
    const created: Patient | undefined = newCustomer ? {
      id: `patient_preview_${sequence}`,
      clinicId: catalog.clinic.id,
      firstName: person.firstName.trim(),
      lastName: person.lastName.trim(),
      phone: person.phone.trim(),
      email: person.email.trim(),
      preferredChannel: "sms",
      isDependent: false,
    } : undefined;
    const appointment: Appointment = {
      id,
      clinicId: catalog.clinic.id,
      locationId,
      patientId: created?.id ?? patient!.id,
      practitionerId: slot.practitionerId,
      serviceId: service.id,
      resourceIds: slot.resourceId ? [slot.resourceId] : [],
      startsAt: slot.startsAt,
      endsAt: appointmentEndForSlot(slot, service),
      status: walkIn ? "checked_in" : "booked",
      confirmationStatus: "confirmed",
      bookingSource: source === "desk" ? "staff" : source,
      ...(reason.trim() ? { reasonForVisit: reason.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(customFields ? { customFields } : {}),
      formStatus: "not_assigned",
      reminderStatus: "not_scheduled",
      manageToken: `preview-${id}`,
    };
    const token = walkIn ? (operations.queueCounters[clinicDateKey(operations.clockIso)] ?? 0) + 1 : undefined;
    if (!addAppointment(appointment, created)) {
      setError(`That time was just taken. Choose another.`);
      return;
    }
    recordAudit({ id: `audit_${id}`, clinicId: catalog.clinic.id, appointmentId: id, actorLabel: "Preview staff", action: walkIn ? "Checked in walk-in" : `Created ${t.appointment}`, outcome: "success", occurredAt: operations.clockIso });
    booked(id, token);
  }

  const practitionerChoice = (id: string): Choice => {
    const item = catalog.getPractitioner(id);
    return { id, label: item?.name ?? catalog.practitionerName(id), leading: <PersonAvatar name={item?.name ?? ""} image={item?.photoUrl ?? undefined} className="size-5 [&_[data-slot=avatar-fallback]]:text-[0.5625rem]" /> };
  };

  const renderValue = (property: VisitProperty): ReactNode => {
    if (property.custom) {
      const field = property.custom;
      return (
        <CustomValue
          field={field}
          value={values[field.id]}
          editor={properties.editor}
          canEditProperties={properties.canEdit}
          onChange={(next: CustomFieldValue) => setValues((current) => ({ ...current, [field.id]: next }))}
        />
      );
    }
    switch (property.id) {
      case "service":
        return (
          <ChoiceField
            label={property.label}
            placeholder="Choose a service"
            empty={`No services for ${patientType === "new" ? `a new ${t.customer}` : `a returning ${t.customer}`}`}
            value={service ? { id: service.id, label: service.name, detail: `${service.durationMinutes} min` } : undefined}
            choices={services.map((item) => ({ id: item.id, label: item.name, detail: [`${item.durationMinutes} min`, item.priceLabel].filter(Boolean).join(" · ") }))}
            onPick={(id) => { setServiceId(id); setSlotKey(""); }}
          />
        );
      case "location": {
        const location = catalog.locations.find((item) => item.id === locationId);
        return (
          <ChoiceField
            label={property.label}
            placeholder="Choose a location"
            empty="No locations"
            value={location ? { id: location.id, label: location.name } : undefined}
            choices={catalog.locations.map((item) => ({ id: item.id, label: item.name, detail: item.city }))}
            onPick={(id) => { setLocationId(id); setSlotKey(""); }}
          />
        );
      }
      case "practitioner":
        return (
          <ChoiceField
            label={property.label}
            placeholder="Anyone available"
            empty={`No ${t.practitioners} for this service`}
            value={practitionerId ? practitionerChoice(practitionerId) : undefined}
            choices={[{ id: "", label: "Anyone available" }, ...people.map((item) => practitionerChoice(item.id))]}
            onPick={(id) => { setPractitionerId(id); setSlotKey(""); }}
          />
        );
      case "date":
        return walkIn ? (
          <span className="flex h-7 items-center text-sm">Today, now</span>
        ) : (
          <InlineDatePicker label={property.label} value={date} min={database ? todayKey : undefined} onValueChange={(next) => { setDate(next); setSlotKey(""); }} />
        );
      case "time":
        return (
          <ChoiceField
            label={property.label}
            placeholder={service ? walkIn ? "Next free" : "Choose a time" : "Choose a service first"}
            disabled={!service}
            loading={loading}
            empty={walkIn ? `No one is free now` : "No openings on this day"}
            value={slot ? { id: keyOf(slot), label: appointmentTime(slot.startsAt), detail: practitionerId ? undefined : catalog.practitionerName(slot.practitionerId) } : undefined}
            choices={shownOpenings.map((item) => ({ id: keyOf(item), label: appointmentTime(item.startsAt), detail: practitionerId ? item.resourceId ? catalog.resourceName(item.resourceId) : undefined : catalog.practitionerName(item.practitionerId) }))}
            onPick={setSlotKey}
          />
        );
      case "source":
        return (
          <SegmentedControl size="sm" aria-label={property.label}>
            {(["desk", "phone", "walk_in"] as const).map((item) => (
              <SegmentedControlItem
                key={item}
                aria-pressed={source === item}
                data-pressed={source === item ? "" : undefined}
                onClick={() => { setSource(item); setSlotKey(""); }}
              >
                {{ desk: "Front desk", phone: "Phone", walk_in: "Walk-in" }[item]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        );
      case "reason":
        return <Input size="sm" aria-label={property.label} className={inlineInputClass} placeholder="Empty" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />;
      case "notes":
        return <Textarea size="sm" rows={1} aria-label={property.label} className={inlineInputClass} placeholder="Add a note for the team" maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />;
      default:
        return null;
    }
  };

  return (
    <form className="contents" onSubmit={(event) => { event.preventDefault(); void book(); }}>
      <DrawerHeader>
        <DrawerTitle>{walkIn ? "Add walk-in" : `New ${t.appointment}`}</DrawerTitle>
        <DrawerDescription>{database ? `Saved for your team. No message is sent from here.` : "Saved in this browser preview."}</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-5">
        <section aria-label={t.Customer} className="flex flex-col gap-2">
          {patient && !newCustomer ? (
            <div className="flex items-center gap-3 rounded-lg border p-2.5">
              <PersonAvatar name={patientName(patient)} className="size-9" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{patientName(patient)}</p>
                <p className="truncate text-xs text-muted-foreground tabular-nums">{patient.phone}{patientType === "returning" ? ` · Returning` : ` · First ${t.visit}`}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setPatientId(""); setServiceId(""); setSlotKey(""); }}>Change</Button>
            </div>
          ) : newCustomer ? (
            <div className="flex flex-col gap-2 rounded-lg border p-2.5">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-medium"><UserPlus aria-hidden="true" className="size-4 text-muted-foreground" />New {t.customer}</p>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Find an existing ${t.customer} instead`} onClick={() => setNewCustomer(false)}><X aria-hidden="true" /></Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input size="sm" aria-label="First name" placeholder="First name" autoFocus autoComplete="off" value={person.firstName} maxLength={80} onChange={(event) => setPerson((current) => ({ ...current, firstName: event.target.value }))} />
                <Input size="sm" aria-label="Last name" placeholder={walkIn ? "Last name (optional)" : "Last name"} autoComplete="off" value={person.lastName} maxLength={80} onChange={(event) => setPerson((current) => ({ ...current, lastName: event.target.value }))} />
                <Input size="sm" aria-label="Phone" placeholder="Phone" type="tel" inputMode="tel" autoComplete="off" value={person.phone} maxLength={32} onChange={(event) => setPerson((current) => ({ ...current, phone: event.target.value }))} />
                <Input size="sm" aria-label="Email" placeholder={database && !walkIn ? "Email" : "Email (optional)"} type="email" autoComplete="off" value={person.email} maxLength={254} onChange={(event) => setPerson((current) => ({ ...current, email: event.target.value }))} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <InputGroup>
                <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput type="search" aria-label={`Find ${t.aCustomer}`} placeholder={`Find ${t.aCustomer} by name or phone`} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
              </InputGroup>
              {matches.length ? (
                <ul aria-label="Matches" className="flex flex-col rounded-lg border p-1">
                  {matches.map((item) => (
                    <li key={item.id}>
                      <Button type="button" variant="ghost" className="w-full justify-start gap-2.5 px-2 font-normal" onClick={() => { setPatientId(item.id); setQuery(""); setServiceId(""); setSlotKey(""); }}>
                        <PersonAvatar name={patientName(item)} className="size-6 [&_[data-slot=avatar-fallback]]:text-[0.625rem]" />
                        <span className="min-w-0 flex-1 truncate text-start">{patientName(item)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.phone}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : query.trim() ? <p className="px-1 text-sm text-muted-foreground">No {t.customer} matches “{query.trim()}”.</p> : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ms-2 self-start text-muted-foreground"
                onClick={() => {
                  const typed = query.trim();
                  const digits = phoneDigits(typed);
                  const [first = "", ...rest] = digits.length >= 6 ? [] : typed.split(/\s+/);
                  setPerson({ firstName: first, lastName: rest.join(" "), phone: digits.length >= 6 ? typed : "", email: "" });
                  setNewCustomer(true);
                  setServiceId("");
                  setSlotKey("");
                }}
              >
                <Plus aria-hidden="true" />New {t.customer}{query.trim() && phoneDigits(query).length < 6 ? ` “${query.trim()}”` : ""}
              </Button>
            </div>
          )}
        </section>
        <OutstandingNotice patientId={newCustomer ? undefined : patientId || undefined} />

        <PropertyRows properties={properties} renderValue={renderValue} />
        <BookingDiscountControl discount={discount} live={database} patientId={newCustomer ? undefined : patientId || undefined} serviceId={serviceId || undefined} />

        {profile.features.dateOfBirth && newCustomer ? (
          <p className="text-xs text-muted-foreground">Date of birth and contact preferences can be added on the {t.customer}’s record later.</p>
        ) : null}
        {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        <LimitOverridePrompt override={limitOverride} actionLabel="Book anyway" pending={pending} onConfirm={() => void book()} />
      </DrawerPanel>
      <DrawerFooter>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={pending || !canBook}>
          {pending ? <Spinner className="size-4" /> : null}
          {walkIn ? "Check in" : `Book ${t.appointment}`}
        </Button>
      </DrawerFooter>
    </form>
  );
}
