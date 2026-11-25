"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, CircleAlert, ImagePlus, Lock, SlidersHorizontal, Trash2 } from "lucide-react";

import { TextareaField, TextField } from "@/components/form-fields";
import { usePictureUpload } from "@/components/image-upload";
import { PersonPhotoField } from "@/components/person-photo-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "@/components/ui/number-field";
import { toastManager } from "@/components/ui/toast";
import type { Practitioner } from "@/lib/domain";
import { practitionerInitials } from "@/lib/clinic-slug";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import { permissionGroupsFor, roleDescriptionsFor, roleLabelsFor, type Permission } from "@/lib/permissions";
import { timingSummary, type TimingResult } from "@/lib/timing-automation";
import { draftFromRules, draftToHoursBody, draftToRules, formatHoursSummary, type AvailabilityRuleSlice, type HoursDraft } from "@/lib/working-hours";

import { useCatalogLookups } from "./clinic-catalog";
import { HoursEditor } from "./hours-editor";
import { OwnEmailDialog } from "./member-email-dialog";
import { MyCalendars } from "./my-calendars";
import { ProfileHero } from "./profile-hero";
import { ChangePasswordForm } from "./password-forms";
import { usePreviewAppointments } from "./preview-appointments";
import { visitFitsRules } from "./schedule-availability";
import { SecurityPanel } from "./security-panel";
import { WorkspacePage } from "@/components/workspace-page";
import { useStaffAccess } from "./staff-access";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { useDoctorRules } from "./use-visits-needing-person";

type SaveResult = { practitionerId: string | null; timing: TimingResult };

function LockedNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Lock aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="error">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** Runs one PATCH to /api/staff/me with its own pending and error state, so each card saves on its own. */
function useSaveOwn() {
  const router = useRouter();
  const staff = useOptionalStaffSnapshot();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save(body: Record<string, unknown>, success: (result: SaveResult) => { title: string; description?: string }) {
    setPending(true);
    setError("");
    try {
      const result = await staffMutation<SaveResult>("/api/staff/me", "PATCH", body);
      await staff?.refresh();
      router.refresh();
      toastManager.add({ ...success(result), type: "success" });
      return true;
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "This could not be saved.");
      return false;
    } finally {
      setPending(false);
    }
  }
  return { save, pending, error };
}

/**
 * A personal photo for people with no booking profile (a receptionist, an owner who is not bookable). It leads the
 * account section of the sidebar. People with a booking profile use its photo instead.
 */
function OwnPhoto({ name, url, saves }: { name: string; url: string | null; saves: boolean }) {
  const router = useRouter();
  const staff = useOptionalStaffSnapshot();
  const upload = usePictureUpload({
    kind: "staff_photo",
    url,
    saves,
    onChanged: async () => {
      await staff?.refresh();
      router.refresh();
    },
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="relative">
          <Avatar className="size-16" aria-hidden="true">
            {upload.shown ? <AvatarImage src={upload.shown} alt="" className="object-cover" /> : null}
            <AvatarFallback className="text-lg">{practitionerInitials(name).slice(0, 2)}</AvatarFallback>
          </Avatar>
          {upload.busy || upload.checking ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/60"><Spinner aria-hidden="true" /></span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="text-sm font-medium">Your photo</span>
          <Menu>
            <MenuTrigger render={<Button type="button" variant="outline" size="sm" disabled={upload.locked} />}>
              <Camera aria-hidden="true" />
              {upload.shown ? "Change photo" : "Add photo"}
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem onClick={upload.pick}><ImagePlus aria-hidden="true" /> {upload.shown ? "Upload a new photo" : "Upload a photo"}</MenuItem>
              {upload.shown ? <MenuItem onClick={() => void upload.adjust()}><SlidersHorizontal aria-hidden="true" /> Adjust photo</MenuItem> : null}
              {upload.shown ? <MenuItem variant="destructive" onClick={() => void upload.remove()}><Trash2 aria-hidden="true" /> Remove photo</MenuItem> : null}
            </MenuPopup>
          </Menu>
        </div>
        {upload.input}
        {upload.editor}
      </div>
      <p className="text-xs text-muted-foreground">Shows beside your name in the menu at the bottom of the sidebar.</p>
      {upload.problem ? <p role="alert" className="text-sm text-destructive-foreground">{upload.problem}</p> : null}
      <span className="sr-only" aria-live="polite">{upload.busy === "upload" ? "Uploading photo" : upload.busy === "remove" ? "Removing photo" : upload.checking ? "Checking photo" : ""}</span>
    </div>
  );
}

function AccountCard({ name: savedName, jobTitle: savedTitle, email, canEdit, ownPhoto }: { name: string; jobTitle: string | null; email: string; canEdit: boolean; ownPhoto?: { url: string | null; saves: boolean } | null }) {
  const [name, setName] = useState(savedName);
  const [jobTitle, setJobTitle] = useState(savedTitle ?? "");
  const { save, pending, error } = useSaveOwn();
  const nameChanged = name.trim() !== savedName && name.trim().length >= 2;
  const titleChanged = jobTitle.trim() !== (savedTitle ?? "");
  const changed = nameChanged || titleChanged;
  const t = useTerms();
  const placeholder = useBusinessProfile().providerFields.titlePlaceholder;
  const [emailOpen, setEmailOpen] = useState(false);

  return (
    <>
    <Card render={<form onSubmit={(event: FormEvent) => {
      event.preventDefault();
      if (!changed) return;
      void save({ ...(nameChanged ? { name: name.trim() } : {}), ...(titleChanged ? { jobTitle: jobTitle.trim() || null } : {}) }, () => ({ title: nameChanged && titleChanged ? "Details saved" : titleChanged ? "Job title saved" : "Name saved" }));
    }} />}>
      <CardHeader>
        <CardTitle render={<h2 />}>Name and email</CardTitle>
        <CardDescription>Your name as the team sees it, and the email you sign in with.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        {error ? <ErrorAlert message={error} /> : null}
        {ownPhoto ? <OwnPhoto name={savedName} url={ownPhoto.url} saves={ownPhoto.saves} /> : null}
        <TextField label="Full name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={160} disabled={!canEdit} autoComplete="name" />
        <TextField label="Job title" optional value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} maxLength={80} disabled={!canEdit} placeholder={placeholder} hint="Shown under your name in the sidebar and on the Team page." />
        <TextField label="Sign-in email" value={email} readOnly disabled hint="To use a different email, we send a link to the new address." />
        <Button type="button" variant="outline" className="self-start" onClick={() => setEmailOpen(true)}>Change email</Button>
        {!canEdit ? <LockedNote>Your {t.business} hasn&apos;t let you edit your own profile.</LockedNote> : null}
      </CardPanel>
      {canEdit ? (
        <CardFooter className="justify-end">
          <Button type="submit" loading={pending} disabled={!changed}>Save</Button>
        </CardFooter>
      ) : null}
    </Card>
    <OwnEmailDialog open={emailOpen} onOpenChange={setEmailOpen} />
    </>
  );
}

function PublicProfileCard({ doctor, canEdit }: { doctor: Practitioner; canEdit: boolean }) {
  const t = useTerms();
  const profile = useBusinessProfile();
  const fields = profile.providerFields;
  const clinical = isClinicalBusinessType(profile.businessType);
  const showCredentials = profile.features.providerCredentials;
  const [photo, setPhoto] = useState(doctor.photoUrl ?? null);
  const [title, setTitle] = useState(doctor.title);
  const [specialty, setSpecialty] = useState(doctor.specialty);
  const [qualifications, setQualifications] = useState(doctor.qualifications ?? "");
  const [experienceYears, setExperienceYears] = useState<number | null>(doctor.experienceYears ?? null);
  const [languages, setLanguages] = useState(doctor.languages ?? "");
  const [bio, setBio] = useState(doctor.bio ?? "");
  const [phone, setPhone] = useState(doctor.phone ?? "");
  const [registrationNumber, setRegistrationNumber] = useState(doctor.registrationNumber ?? "");
  const [photoError, setPhotoError] = useState("");
  const { save, pending, error } = useSaveOwn();

  function submit(event: FormEvent) {
    event.preventDefault();
    void save({
      profile: {
        title: title.trim(),
        specialty: specialty.trim(),
        qualifications,
        experienceYears,
        languages,
        bio,
        phone,
        registrationNumber,
        ...(photo !== (doctor.photoUrl ?? null) ? { photoDataUrl: photo } : {}),
      },
    }, () => ({ title: "Profile saved", description: `${t.Customers} see the new details on the booking page.` }));
  }

  return (
    <Card render={<form onSubmit={submit} />}>
      <CardHeader>
        <CardTitle render={<h2 />}>Booking profile</CardTitle>
        <CardDescription>What {t.customers} see about you when they book: your photo, title and a short bio.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        {error || photoError ? <ErrorAlert message={error || photoError} /> : null}
        <fieldset disabled={!canEdit} className="flex flex-col gap-4">
          <PersonPhotoField name={doctor.name} photo={photo} onChange={setPhoto} onProblem={setPhotoError} disabled={!canEdit} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label={fields.title} placeholder={clinical ? undefined : fields.titlePlaceholder} value={title} onChange={(event) => setTitle(event.target.value)} required minLength={2} maxLength={120} />
            <TextField label={fields.specialty} placeholder={clinical ? undefined : fields.specialtyPlaceholder} value={specialty} onChange={(event) => setSpecialty(event.target.value)} required minLength={2} maxLength={160} />
          </div>
          {showCredentials ? <TextField label={fields.qualifications} optional placeholder={clinical ? "BDS, MDS" : undefined} value={qualifications} onChange={(event) => setQualifications(event.target.value)} maxLength={200} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="w-full">
              <FieldLabel>Years of experience</FieldLabel>
              <NumberField min={0} max={70} value={experienceYears} onValueChange={(value) => setExperienceYears(value)} className="w-full" disabled={!canEdit}>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Phone" optional hint="Staff only" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={30} />
            {showCredentials ? <TextField label={clinical ? "Registration no." : fields.registrationNumber} optional hint="Staff only" value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} maxLength={60} /> : null}
          </div>
        </fieldset>
        {!canEdit ? <LockedNote>Ask your {t.business} owner to update your profile, or to let you edit it yourself.</LockedNote> : null}
      </CardPanel>
      {canEdit ? (
        <CardFooter className="justify-end">
          <Button type="submit" loading={pending}>Save profile</Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function HoursCard({ doctor, rules, canEdit }: { doctor: Practitioner; rules: AvailabilityRuleSlice[]; canEdit: boolean }) {
  const { appointments, operations } = usePreviewAppointments();
  const saved = draftFromRules(rules);
  const [hours, setHours] = useState<HoursDraft>(saved.draft);
  const { save, pending, error } = useSaveOwn();
  const changed = JSON.stringify(hours) !== JSON.stringify(saved.draft);
  const clock = Date.parse(operations.clockIso);
  const draftRules = draftToRules(doctor.id, hours);
  const affectedCount = changed && hours.days.length
    ? appointments.filter((item) => item.practitionerId === doctor.id && (item.status === "requested" || item.status === "booked") && Date.parse(item.startsAt) > clock && !visitFitsRules(item, draftRules)).length
    : 0;
  const summary = formatHoursSummary(rules);
  const t = useTerms();

  return (
    <Card render={<form onSubmit={(event: FormEvent) => { event.preventDefault(); void save({ hours: draftToHoursBody(hours) }, (result) => ({ title: "Working hours saved", description: timingSummary(result.timing) })); }} />}>
      <CardHeader>
        <CardTitle render={<h2 />}>Working hours</CardTitle>
        <CardDescription>When {t.customers} can book you. {summary ? `Now: ${summary}.` : "No hours set yet."}</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        {error ? <ErrorAlert message={error} /> : null}
        {canEdit ? (
          <HoursEditor value={hours} onChange={setHours} affectedCount={affectedCount} uniform={saved.uniform} />
        ) : (
          <LockedNote>Your {t.business} sets your hours. Ask the owner to change them, or to let you set them yourself.</LockedNote>
        )}
      </CardPanel>
      {canEdit ? (
        <CardFooter className="justify-end">
          <Button type="submit" loading={pending} disabled={!changed || hours.days.length === 0}>Save hours</Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function AccessCard() {
  const access = useStaffAccess();
  const allowed = new Set<Permission>(access.permissions);
  const t = useTerms();
  const profile = useBusinessProfile();
  const roleLabels = roleLabelsFor(profile);
  const roleDescriptions = roleDescriptionsFor(profile);
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />} className="flex flex-wrap items-center gap-2">
          Your access <Badge variant="outline">{roleLabels[access.role]}</Badge>
        </CardTitle>
        <CardDescription>{roleDescriptions[access.role]} Only your {t.business} owner or an admin can change this.</CardDescription>
      </CardHeader>
      <CardPanel className="grid gap-4 sm:grid-cols-2">
        {permissionGroupsFor(profile).map((group) => (
          <section key={group.title} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {group.items.map((item) => (
                <li key={item.key} className={allowed.has(item.key) ? "flex items-center gap-2" : "flex items-center gap-2 text-muted-foreground line-through decoration-muted-foreground/60"}>
                  {allowed.has(item.key)
                    ? <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
                    : <span aria-hidden="true" className="size-4 shrink-0" />}
                  <span>{item.label}<span className="sr-only">{allowed.has(item.key) ? " (allowed)" : " (not allowed)"}</span></span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CardPanel>
    </Card>
  );
}

export function ProfileWorkspace({ name, jobTitle = null, email, practitionerId, ownPhotoUrl = null, preview }: {
  name: string;
  /** What the person is called in the business, if they set it. */
  jobTitle?: string | null;
  email: string;
  practitionerId: string | null;
  /** The photo of someone with no booking profile. */
  ownPhotoUrl?: string | null;
  preview: boolean;
}) {
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const allRules = useDoctorRules();
  const doctor = practitionerId ? catalog.getPractitioner(practitionerId) : undefined;
  const rules = doctor ? allRules.filter((rule) => rule.practitionerId === doctor.id) : [];
  const t = useTerms();

  const showPassword = !preview;
  const sections = [
    { id: "account", label: "Name and email" },
    ...(doctor ? [{ id: "booking-profile", label: "Booking profile" }, { id: "hours", label: "Working hours" }] : []),
    ...(showPassword ? [{ id: "password", label: "Password" }, { id: "notifications", label: "Notifications" }] : []),
    { id: "calendars", label: "Calendars" },
    ...(showPassword ? [{ id: "security", label: "Security" }] : []),
    { id: "access", label: "Your access" },
  ];

  return (
    <WorkspacePage nav="profile" className="gap-6">
      <ProfileHero name={name} photoUrl={doctor ? doctor.photoUrl : ownPhotoUrl} />
      {preview ? (
        <Alert variant="info">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>This preview has no accounts. Profiles are saved once {t.aBusiness} database is connected.</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
        {/* On wide screens, a short list of what is on the page, so nothing has to be found by scrolling. */}
        <nav aria-label="On this page" className="max-lg:hidden">
          <ul className="sticky top-20 flex flex-col gap-0.5 text-sm">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="block rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-4 *:scroll-mt-20">
          <div id="account"><AccountCard key={`${name}|${jobTitle ?? ""}`} name={name} jobTitle={jobTitle} email={email} canEdit={!preview && access.can("profile.own")} ownPhoto={practitionerId || preview ? null : { url: ownPhotoUrl, saves: true }} /></div>
          {doctor ? (
            <>
              <div id="booking-profile"><PublicProfileCard key={`${doctor.id}-${doctor.photoUrl ?? ""}`} doctor={doctor} canEdit={access.can("profile.own")} /></div>
              {/* Keyed by the saved hours so the editor starts from them once the schedule has loaded. */}
              <div id="hours"><HoursCard key={formatHoursSummary(rules)} doctor={doctor} rules={rules} canEdit={access.can("hours.own")} /></div>
            </>
          ) : null}
          {showPassword ? (
            <Card id="password">
              <CardHeader>
                <CardTitle render={<h2 />}>Password</CardTitle>
                <CardDescription>Changing it signs you out on your other devices.</CardDescription>
              </CardHeader>
              <CardPanel>
                <ChangePasswordForm />
              </CardPanel>
            </Card>
          ) : null}
          {showPassword ? (
            <Card id="notifications">
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <CardTitle render={<h2 />}>Notifications</CardTitle>
                  <CardDescription>What you hear about, by app, phone or email, plus quiet hours and a morning summary.</CardDescription>
                </div>
                <Button variant="outline" render={<Link href="/profile/notifications" />}>Open notifications</Button>
              </CardHeader>
            </Card>
          ) : null}
          <div id="calendars"><MyCalendars preview={preview} /></div>
          {showPassword ? <div id="security"><SecurityPanel /></div> : null}
          <div id="access"><AccessCard /></div>
        </div>
      </div>
    </WorkspacePage>
  );
}
