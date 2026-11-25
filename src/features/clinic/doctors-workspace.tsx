"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useState, type ReactNode } from "react";
import { ChevronRight, Stethoscope, UserPlus, UsersRound } from "lucide-react";

import { TextareaField, TextField } from "@/components/form-fields";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { PersonAvatar } from "@/components/person-avatar";
import { PersonPhotoField } from "@/components/person-photo-field";
import { RowButton } from "@/components/row-button";
import { ExpandingSearch } from "@/components/expanding-search";
import { StatusBadge } from "@/components/status-badge";
import { useNavLabels } from "@/features/clinic/sidebar-nav";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "@/components/ui/number-field";
import { Separator } from "@/components/ui/separator";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import { practitionerInitials } from "@/lib/clinic-slug";
import type { Practitioner } from "@/lib/domain";
import { savePreviewDoctor } from "@/lib/preview-doctors";
import { timingSummary, type TimingResult } from "@/lib/timing-automation";
import { draftFromRules, draftToHoursBody, draftToRules, formatHoursSummary, type AvailabilityRuleSlice, type HoursDraft } from "@/lib/working-hours";
import type { AccountLink } from "@/server/staff-invites";

import { AccessLinkNotice } from "./access-link-notice";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { HoursEditor } from "./hours-editor";
import { TeamWorkspace } from "./team-workspace";
import { WhyNoSlotButton } from "./why-no-slot-sheet";
import { clinicDateKey, usePreviewAppointments } from "./preview-appointments";
import { draftToWorkingHours, visitFitsRules } from "./schedule-availability";
import { useStepUp } from "./step-up-dialog";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { useDoctorRules } from "./use-visits-needing-person";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";

const searchThreshold = 6;
const noTiming: TimingResult = { moved: [], unresolved: [] };

type Editing = { mode: "new" } | { mode: "edit"; id: string } | null;

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function CheckList({ legend, options, selected, onChange }: {
  legend: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {options.map((option) => (
        <Label key={option.id} className="font-normal">
          <Checkbox
            checked={selected.includes(option.id)}
            onCheckedChange={(checked) => onChange(checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))}
          />
          {option.label}
        </Label>
      ))}
    </fieldset>
  );
}

export function DoctorsWorkspace() {
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const rules = useDoctorRules();
  const { appointments, operations } = usePreviewAppointments();
  const [picked, setEditing] = useState<Editing>(null);
  // `?member=<id>` opens that person, so a name elsewhere in the app can link straight to them.
  const [member, setMember] = useQueryState("member");
  const [query, setQuery] = useState("");
  const [invite, setInvite] = useState<{ name: string; link: AccountLink } | null>(null);
  const canManage = !catalog.database || access.can("team.manage");
  // Who can sign in, and as what, sits beside the people who take bookings (it used to be Settings → Team and access).
  const canManageAccess = catalog.database && access.can("team.manage");
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(["people", "access"] as const).withDefault("people"));
  const showAccess = canManageAccess && tab === "access";
  const navLabels = useNavLabels();
  const today = clinicDateKey(operations.clockIso);
  const editing: Editing = picked ?? (member && canManage && catalog.getPractitioner(member) ? { mode: "edit", id: member } : null);
  const closeEditor = () => { setEditing(null); void setMember(null); };
  const editingDoctor = editing?.mode === "edit" ? catalog.getPractitioner(editing.id) : undefined;
  const search = query.trim().toLowerCase();
  const doctors = catalog.practitioners.filter((doctor) => !search || `${doctor.name} ${doctor.specialty}`.toLowerCase().includes(search));
  const t = useTerms();
  const profile = useBusinessProfile();
  const EmptyIcon = isClinicalBusinessType(profile.businessType) ? Stethoscope : UsersRound;

  return (
    <WorkspacePage
      nav="doctors"
      bar={canManage && !showAccess ? [{ id: "add", label: `Add ${t.practitioner}`, icon: <UserPlus aria-hidden="true" />, variant: "default", pinned: true, onSelect: () => { setInvite(null); setEditing({ mode: "new" }); } }] : []}
    >
      {invite ? (
        <div className="flex flex-col gap-2">
          <AccessLinkNotice link={invite.link} name={invite.name} />
          <Button variant="ghost" size="sm" className="self-end" onClick={() => setInvite(null)}>Done</Button>
        </div>
      ) : null}

      {canManageAccess ? (
        <Tabs value={tab} onValueChange={(next) => void setTab(next === "access" ? "access" : null)}>
          <TabsList variant="underline" aria-label={navLabels.doctors}>
            <TabsTab value="people">{t.Practitioners}</TabsTab>
            <TabsTab value="access">Sign-in and access</TabsTab>
          </TabsList>
        </Tabs>
      ) : null}

      {showAccess ? <TeamWorkspace /> : (
      <WorkspaceFrame
        flush
        end={catalog.practitioners.length > searchThreshold ? (
          <ExpandingSearch placeholder={`Search ${t.practitioners}`} label={`Search ${t.practitioners}`} value={query} onValueChange={setQuery} />
        ) : null}
      >
      {doctors.length ? (
        <div className="flex flex-col">
            {doctors.map((doctor) => {
              const summary = formatHoursSummary(rules.filter((rule) => rule.practitionerId === doctor.id));
              const visits = appointments.filter((item) => item.practitionerId === doctor.id && clinicDateKey(item.startsAt) === today && ["requested", "booked", "checked_in"].includes(item.status)).length;
              return (
                <RowButton key={doctor.id} disabled={!canManage} className="items-center gap-3 px-4 py-3" onClick={() => { setInvite(null); setEditing({ mode: "edit", id: doctor.id }); }}>
                  <PersonAvatar name={doctor.name} image={doctor.photoUrl} className="size-10" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{doctor.name}</span>
                      {doctor.isActive === false ? <StatusBadge tone="neutral">Inactive</StatusBadge> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">{doctor.title} · {doctor.specialty}</span>
                    <span className="block text-xs text-muted-foreground md:hidden">{summary || "No hours set"}</span>
                  </span>
                  <span className="w-64 shrink-0 text-xs text-muted-foreground max-md:hidden">{summary || "No hours set"}</span>
                  <span className="w-20 shrink-0 text-end text-xs tabular-nums text-muted-foreground max-sm:hidden">{visits} today</span>
                  {canManage ? <ChevronRight aria-hidden="true" className="text-muted-foreground" /> : null}
                </RowButton>
              );
            })}
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><EmptyIcon aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{catalog.practitioners.length ? `No matching ${t.practitioners}` : `No ${t.practitioners} yet`}</EmptyTitle>
            <EmptyDescription>{catalog.practitioners.length ? `Try another name or ${profile.providerFields.specialty.toLowerCase()}.` : `Add ${t.aPractitioner} so ${t.customers} can book them.`}</EmptyDescription>
          </EmptyHeader>
          {!catalog.practitioners.length && canManage ? <EmptyContent><Button onClick={() => { setInvite(null); setEditing({ mode: "new" }); }}><UserPlus aria-hidden="true" /> Add {t.practitioner}</Button></EmptyContent> : null}
        </Empty>
      )}
      </WorkspaceFrame>
      )}

      <Drawer position="right" open={editing !== null} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DrawerPopup showCloseButton variant="inset">
          {editing ? (
            <DoctorForm
              key={editingDoctor?.id ?? "new"}
              doctor={editingDoctor}
              savedRules={rules.filter((rule) => rule.practitionerId === editingDoctor?.id)}
              onClose={closeEditor}
              onInvite={(name, link) => setInvite({ name, link })}
            />
          ) : null}
        </DrawerPopup>
      </Drawer>
    </WorkspacePage>
  );
}

function DoctorForm({ doctor, savedRules, onClose, onInvite }: {
  doctor?: Practitioner;
  savedRules: AvailabilityRuleSlice[];
  onClose: () => void;
  onInvite: (name: string, link: AccountLink) => void;
}) {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const { runWithStepUp } = useStepUp();
  const { appointments, operations, saveDoctorHours } = usePreviewAppointments();
  const t = useTerms();
  const upgrade = useUpgradePrompt();
  const profile = useBusinessProfile();
  const fields = profile.providerFields;
  const clinical = isClinicalBusinessType(profile.businessType);
  const showCredentials = profile.features.providerCredentials;
  const isNew = !doctor;
  const saved = draftFromRules(savedRules);
  const services = catalog.services.filter((service) => service.isActive !== false);
  const initialServiceIds = doctor ? services.filter((service) => service.practitionerIds.includes(doctor.id)).map((service) => service.id) : services.map((service) => service.id);
  const [photo, setPhoto] = useState(doctor?.photoUrl ?? null);
  const [name, setName] = useState(doctor?.name ?? "");
  const [title, setTitle] = useState(doctor?.title ?? (clinical ? "Physician" : ""));
  const [specialty, setSpecialty] = useState(doctor?.specialty ?? "");
  const [qualifications, setQualifications] = useState(doctor?.qualifications ?? "");
  const [registrationNumber, setRegistrationNumber] = useState(doctor?.registrationNumber ?? "");
  const [experienceYears, setExperienceYears] = useState<number | null>(doctor?.experienceYears ?? null);
  const [languages, setLanguages] = useState(doctor?.languages ?? "");
  const [bio, setBio] = useState(doctor?.bio ?? "");
  const [phone, setPhone] = useState(doctor?.phone ?? "");
  const [email, setEmail] = useState("");
  const [attach, setAttach] = useState(false);
  const [locationIds, setLocationIds] = useState(doctor?.locationIds ?? catalog.locations.map((location) => location.id));
  const [serviceIds, setServiceIds] = useState(initialServiceIds);
  const [hours, setHours] = useState<HoursDraft>(saved.draft);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const hoursChanged = isNew || JSON.stringify(hours) !== JSON.stringify(saved.draft);
  const locationsChanged = !isNew && [...locationIds].sort().join() !== [...doctor.locationIds].sort().join();
  const clock = Date.parse(operations.clockIso);
  const upcoming = doctor ? appointments.filter((item) => item.practitionerId === doctor.id && (item.status === "requested" || item.status === "booked") && Date.parse(item.startsAt) > clock) : [];
  const draftRules = doctor ? draftToRules(doctor.id, hours) : [];
  const affectedCount = doctor && hoursChanged && hours.days.length ? upcoming.filter((item) => !visitFitsRules(item, draftRules)).length : 0;
  const canAttach = catalog.database && isNew && !catalog.snapshot?.team.some((member) => member.role === "owner" && member.practitionerId);
  const loginEmail = doctor ? catalog.snapshot?.team.find((member) => member.practitionerId === doctor.id)?.email : undefined;
  const canInvite = catalog.database && !isNew && !loginEmail && doctor?.isActive !== false;

  function savePreview() {
    const id = doctor?.id ?? `practitioner_${crypto.randomUUID().slice(0, 8)}`;
    const stored = savePreviewDoctor({
      id,
      clinicId: catalog.clinic.id,
      name: name.trim(),
      title: title.trim(),
      specialty: specialty.trim(),
      initials: practitionerInitials(name).slice(0, 2),
      isActive: doctor?.isActive ?? true,
      photoUrl: photo,
      bio: bio.trim() || null,
      qualifications: qualifications.trim() || null,
      registrationNumber: registrationNumber.trim() || null,
      experienceYears,
      languages: languages.trim() || null,
      phone: phone.trim() || null,
      locationIds,
      serviceIds,
    });
    if (!stored) throw new Error(`Could not save this ${t.practitioner} in the browser.`);
    if (!hoursChanged) return noTiming;
    const timing = saveDoctorHours(id, draftToWorkingHours(hours));
    if (!timing) throw new Error("The profile was saved, but the hours could not be.");
    return timing;
  }

  async function saveToDatabase() {
    const profile = {
      name: name.trim(),
      title: title.trim(),
      specialty: specialty.trim(),
      bio,
      qualifications,
      registrationNumber,
      experienceYears,
      languages,
      phone,
      locationIds,
      serviceIds,
      ...(photo !== (doctor?.photoUrl ?? null) ? { photoDataUrl: photo } : {}),
    };
    const hoursBody = draftToHoursBody(hours);
    if (isNew) {
      const created = await staffMutation<{ invite?: AccountLink }>("/api/staff/team/practitioners", "POST", {
        ...profile,
        attachToCurrentUser: attach,
        email: attach ? undefined : email.trim(),
        hours: hoursBody,
      });
      if (created.invite) onInvite(profile.name, created.invite);
      return noTiming;
    }
    // A doctor at a new location needs hours written there too, even when the times didn't change.
    const sendHours = hoursChanged || locationsChanged;
    const updated = await staffMutation<{ timing?: TimingResult }>(`/api/staff/team/practitioners/${doctor.id}`, "PATCH", { ...profile, ...(sendHours ? { hours: hoursBody } : {}) });
    // Someone added without a login (an import or a seed) gets one when the owner fills in their work email.
    if (canInvite && email.trim()) {
      // Giving someone a login asks for a fresh authenticator code, the same as editing their access does.
      const login = await runWithStepUp(() => staffMutation<{ invite?: AccountLink }>(`/api/staff/team/practitioners/${doctor.id}/login`, "POST", { email: email.trim() }));
      if (login.invite) onInvite(profile.name, login.invite);
    }
    return updated.timing ?? noTiming;
  }

  async function submit() {
    if (locationIds.length === 0) { setError(`Choose at least one ${t.location}.`); return; }
    if (serviceIds.length === 0) { setError("Choose at least one service."); return; }
    if (hours.days.length === 0) { setError("Choose at least one working day."); return; }
    setPending(true);
    setError("");
    try {
      const timing = catalog.database ? await saveToDatabase() : savePreview();
      if (catalog.database) await staff?.refresh();
      toastManager.add({ title: `${name.trim()} saved`, description: hoursChanged && !isNew ? timingSummary(timing) : undefined, type: "success" });
      onClose();
    } catch (cause: unknown) {
      if (upgrade.fromError(cause)) return;
      setError(cause instanceof Error ? cause.message : `This ${t.practitioner} could not be saved.`);
    } finally {
      setPending(false);
    }
  }

  async function toggleActive() {
    if (!doctor) return;
    const next = doctor.isActive === false;
    setPending(true);
    setError("");
    try {
      if (catalog.database) {
        await staffMutation(`/api/staff/team/practitioners/${doctor.id}`, "PATCH", { isActive: next });
        await staff?.refresh();
      } else if (!savePreviewDoctor({ ...doctor, isActive: next, serviceIds: initialServiceIds })) {
        throw new Error("Could not save this change in the browser.");
      }
      toastManager.add({ title: `${doctor.name} ${next ? "reactivated" : "deactivated"}`, type: "success" });
      onClose();
    } catch (cause: unknown) {
      if (upgrade.fromError(cause)) return;
      setError(cause instanceof Error ? cause.message : "This change could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <DrawerHeader>
        <DrawerTitle>{doctor ? doctor.name : `Add ${t.aPractitioner}`}</DrawerTitle>
        <DrawerDescription>{isNew ? `${t.Customers} can book them as soon as this is saved.` : `${t.Customers} see the name, ${fields.title.toLowerCase()}, photo and bio.`}</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-6">
        {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}

        <PersonPhotoField name={name || `New ${t.practitioner}`} photo={photo} onChange={setPhoto} onProblem={setError} avatarClassName="size-20" />

        <FormSection title="About">
          <TextField label="Full name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={160} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label={fields.title} placeholder={clinical ? undefined : fields.titlePlaceholder} value={title} onChange={(event) => setTitle(event.target.value)} required minLength={2} maxLength={120} />
            <TextField label={fields.specialty} placeholder={clinical ? undefined : fields.specialtyPlaceholder} value={specialty} onChange={(event) => setSpecialty(event.target.value)} required minLength={2} maxLength={160} />
          </div>
          {showCredentials ? <TextField label={fields.qualifications} optional placeholder={clinical ? "BDS, MDS" : undefined} value={qualifications} onChange={(event) => setQualifications(event.target.value)} maxLength={200} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="w-full">
              <FieldLabel>Years of experience</FieldLabel>
              <NumberField min={0} max={70} value={experienceYears} onValueChange={(value) => setExperienceYears(value)} className="w-full">
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
            <TextField label="Languages" optional placeholder="English, Hindi" value={languages} onChange={(event) => setLanguages(event.target.value)} maxLength={200} />
          </div>
          <TextareaField label="Short bio" optional value={bio} onChange={(event) => setBio(event.target.value)} maxLength={600} />
        </FormSection>

        <Separator />

        <FormSection title="Contact and login">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Phone" optional hint="Staff only" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={30} />
            {showCredentials ? <TextField label={clinical ? "Registration no." : fields.registrationNumber} optional hint="Staff only" value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} maxLength={60} /> : null}
          </div>
          {canAttach ? (
            <Label className="font-normal">
              <Checkbox checked={attach} onCheckedChange={setAttach} />
              This {t.practitioner} is me (keep my owner login)
            </Label>
          ) : null}
          {catalog.database && isNew && !attach ? <TextField label="Work email" type="email" hint="We send them an invite link to choose their own password." value={email} onChange={(event) => setEmail(event.target.value)} required /> : null}
          {canInvite ? <TextField label="Work email" type="email" optional hint={`No login yet. Add their email and save to send an invite link; they choose their own password and see only their own ${t.visits} and ${t.customers}.`} value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} /> : null}
          {loginEmail ? <p className="text-xs text-muted-foreground">Signs in with {loginEmail}</p> : null}
          {!catalog.database ? <p className="text-xs text-muted-foreground">Logins are created once {t.aBusiness} database is connected.</p> : null}
        </FormSection>

        <Separator />

        <FormSection title="Where and what">
          {catalog.locations.length > 1 ? <CheckList legend={t.Locations} options={catalog.locations.map((location) => ({ id: location.id, label: location.name }))} selected={locationIds} onChange={setLocationIds} /> : null}
          <CheckList legend="Services" options={services.map((service) => ({ id: service.id, label: service.name }))} selected={serviceIds} onChange={setServiceIds} />
        </FormSection>

        <Separator />

        <FormSection title="Timings">
          <HoursEditor value={hours} onChange={setHours} affectedCount={affectedCount} uniform={saved.uniform} />
          {doctor ? <WhyNoSlotButton practitionerId={doctor.id} /> : null}
        </FormSection>
      </DrawerPanel>
      <DrawerFooter className="items-center justify-between sm:justify-between">
        {doctor ? (
          <AlertDialog>
            <AlertDialogTrigger render={<Button type="button" variant="ghost" disabled={pending} />}>{doctor.isActive === false ? "Reactivate" : "Deactivate"}</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>{doctor.isActive === false ? `Reactivate ${doctor.name}?` : `Deactivate ${doctor.name}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {doctor.isActive === false
                    ? `${t.Customers} can book them again and their login works again.`
                    : `${t.Customers} can no longer book them.${upcoming.length ? ` Their ${upcoming.length} upcoming booking${upcoming.length === 1 ? " moves" : "s move"} to Messages for someone to reassign.` : ""}`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button type="button" variant="ghost" />}>Keep as is</AlertDialogClose>
                <AlertDialogClose render={<Button type="button" variant={doctor.isActive === false ? "default" : "destructive"} onClick={() => void toggleActive()} />}>
                  {doctor.isActive === false ? "Reactivate" : "Deactivate"}
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        ) : <span />}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            {pending ? "Saving…" : isNew ? `Add ${t.practitioner}` : "Save"}
          </Button>
        </div>
      </DrawerFooter>
    </form>
  );
}
