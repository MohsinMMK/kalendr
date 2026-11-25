"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarCheck2,
  Check,
  ChevronDown,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  Link2,
  MessageSquareText,
  Share2,
  UserRound,
  Users,
} from "lucide-react";

import { SelectField } from "@/components/form-fields";
import { ImageUpload } from "@/components/image-upload";
import { PersonPhotoField } from "@/components/person-photo-field";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Stepper, StepperIndicator, StepperItem, StepperNav, StepperSeparator, StepperTitle, StepperTrigger } from "@/components/reui/stepper";
import { ServiceCard, serviceMeta } from "@/features/booking/service-card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  getBusinessType,
  isClinicalBusinessType,
  resourceKindLabels,
  type ResourceKind,
} from "@/lib/business-types";
import type { BookingMode, Service } from "@/lib/domain";
import type { ClinicSetupState, SetupGap } from "@/lib/clinic-setup";
import { draftToHoursBody, type HoursDraft } from "@/lib/working-hours";
import type { AccountLink } from "@/server/staff-invites";

import { useBusinessProfile, useTerms } from "../terms/business-profile-context";
import { AccessLinkNotice } from "./access-link-notice";
import { useCatalogLookups } from "./clinic-catalog";
import { HoursEditor } from "./hours-editor";
import { OnboardingDemo } from "./onboarding-demo";
import {
  ChoiceCard,
  MinutesField,
  OnboardingFrame,
  OnboardingStep,
  tapAdvanceDelayMs,
  TypeInField,
} from "./onboarding-choice";
import {
  staffMutation,
  useOptionalStaffSnapshot,
} from "./staff-snapshot-provider";

type ServicePick = string;
type ResourcePick = ResourceKind | "none";
type Screen =
  | "intro"
  | "service"
  | "serviceDetails"
  | "resource"
  | "photo"
  | "person"
  | "brand"
  | "assignment"
  | "hours"
  | "ready";

const hourPresets = {
  weekdays: { label: "Weekdays, 9:00–17:00", draft: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", breakStart: null, breakEnd: null } },
  week: { label: "Monday to Saturday, 9:00–17:00", draft: { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00", breakStart: null, breakEnd: null } },
  evenings: { label: "Weekday evenings, 14:00–20:00", draft: { days: [1, 2, 3, 4, 5], start: "14:00", end: "20:00", breakStart: null, breakEnd: null } },
} satisfies Record<string, { label: string; draft: HoursDraft }>;
type HoursPick = keyof typeof hourPresets;

function presetFor(draft: HoursDraft): HoursPick | "" {
  const match = (Object.keys(hourPresets) as HoursPick[]).find((id) => {
    const preset = hourPresets[id].draft;
    return preset.days.join() === draft.days.join() && preset.start === draft.start && preset.end === draft.end && !draft.breakStart;
  });
  return match ?? "";
}

// Kinds the staff API accepts for a service's required space.
const bookableResourceKinds: readonly ResourceKind[] = ["operatory", "room", "chair", "equipment", "space", "station", "vehicle", "other"];

/** Which of the three setup stages a screen belongs to; 0 is the introduction before the first. */
function setupStage(screen: Screen): number {
  if (screen === "intro") return 0;
  if (screen === "hours") return 3;
  if (screen === "person" || screen === "brand") return 2;
  return 1;
}

/** The three stages of setup, read only: the screens inside a stage still move with Back and Continue. */
function SetupStepper({ current, labels, position }: { current: number; labels: string[]; position: string }) {
  return (
    <Stepper value={current} onValueChange={() => {}} aria-label="Setup progress">
      <span className="sr-only">{position}</span>
      <StepperNav>
        {labels.map((label, index) => (
          <StepperItem key={label} step={index + 1} className="gap-2 max-sm:not-last:flex-none">
            <StepperTrigger tabIndex={-1} disabled className="min-w-0 disabled:opacity-100">
              <StepperIndicator>{index + 1}</StepperIndicator>
              <StepperTitle className={index + 1 === current ? "" : "text-muted-foreground max-sm:hidden"}>{label}</StepperTitle>
            </StepperTrigger>
            {index < labels.length - 1 ? <StepperSeparator className="mx-1" /> : null}
          </StepperItem>
        ))}
      </StepperNav>
    </Stepper>
  );
}

const chapterOffer = "What you offer";
const chapterHours = "When you’re open";

export function SetupWorkspace({ preview = false }: { preview?: boolean }) {
  const router = useRouter();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const profile = useBusinessProfile();
  const t = useTerms();
  const preset = getBusinessType(profile.businessType);
  const clinical = isClinicalBusinessType(profile.businessType);
  const resourceKindOptions = [
    ...profile.resourceKinds
      .filter((kind) => bookableResourceKinds.includes(kind))
      .map((kind) => ({ value: kind, label: resourceKindLabels[kind] })),
    { value: "none", label: clinical ? "No dedicated room or chair" : `No ${t.resource} needed` },
  ];
  const [previewMissing, setPreviewMissing] = useState<SetupGap[]>([
    "service",
    "resource",
    "practitioner",
    "hours",
  ]);
  const previewSetup: ClinicSetupState = {
    complete: previewMissing.length === 0,
    missing: previewMissing,
    bookingPath: `/book/${catalog.clinic.slug}`,
  };
  const setup = preview ? previewSetup : staff?.snapshot?.setup;
  // Screens that save nothing until the next saved step live only in this tab.
  const [introSeen, setIntroSeen] = useState(false);
  const [serviceStage, setServiceStage] = useState<"pick" | "details">("pick");
  const [savedServiceId, setSavedServiceId] = useState<string | null>(null);
  const [photoPending, setPhotoPending] = useState(false);
  const [personDone, setPersonDone] = useState(false);
  const [brandDone, setBrandDone] = useState(false);
  const [servicePick, setServicePick] = useState<ServicePick>("");
  const [serviceOther, setServiceOther] = useState("");
  const [duration, setDuration] = useState("30");
  const [price, setPrice] = useState("");
  const [bookingMode, setBookingMode] = useState<BookingMode>("request");
  const [resourceKind, setResourceKind] = useState<ResourcePick>("none");
  const [resourceName, setResourceName] = useState("");
  const [resourceLocationId, setResourceLocationId] = useState("");
  const [doctorPick, setDoctorPick] = useState<"me" | "someone" | "">("");
  const [doctorName, setDoctorName] = useState("");
  const [doctorEmail, setDoctorEmail] = useState("");
  const [doctorTitle, setDoctorTitle] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [doctorPhoto, setDoctorPhoto] = useState<string | null>(null);
  const [hours, setHours] = useState<HoursDraft>(hourPresets.week.draft);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [invite, setInvite] = useState<{ name: string; link: AccountLink } | null>(null);
  const advanceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);
  const titlePlaceholder =
    profile.businessType === "dental" ? "Dentist" : clinical ? "Practitioner" : preset.providerFields.titlePlaceholder;
  const starterServices = preset.starterServices;
  const chosenStarter = servicePick && servicePick !== "other" ? starterServices[Number(servicePick)] : undefined;
  const chosenServiceName =
    servicePick === "other" ? serviceOther.trim() : (chosenStarter?.name ?? "");
  const hoursPick = presetFor(hours);
  const validHours = hours.days.length > 0 && hours.start < hours.end;
  const validDuration =
    Number.isInteger(Number(duration)) && Number(duration) >= 5 && Number(duration) <= 480;
  const priceLabel = price && Number(price) > 0 ? `₹${Number(price).toLocaleString("en-IN")}` : undefined;
  const ownerName =
    staff?.snapshot?.team.find((member) => member.role === "owner")?.name ?? "";
  const error = message || staff?.error;

  async function save(
    action: () => Promise<unknown>,
    completedGaps?: SetupGap[],
  ): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setMessage("");
    try {
      if (preview) {
        setPreviewMissing((remaining) =>
          remaining.filter(
            (gap) =>
              !(completedGaps ?? [remaining[0]]).includes(gap) &&
              !(gap === "resource" && resourceKind === "none"),
          ),
        );
      } else {
        await action();
        await staff?.refresh();
      }
      return true;
    } catch (cause: unknown) {
      console.error(
        "Setup could not be saved",
        cause instanceof Error ? cause.name : "Unknown error",
      );
      setMessage(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  function pickStarter(index: number) {
    const item = starterServices[index];
    if (!item) return;
    setServicePick(String(index));
    setDuration(String(item.durationMinutes));
    setBookingMode(item.bookingMode);
    setResourceKind(
      item.requiredResourceKind && bookableResourceKinds.includes(item.requiredResourceKind)
        ? item.requiredResourceKind
        : "none",
    );
  }

  /** A pointer tap on a suggested service moves on; keyboard choices report `detail` 0 and stay. */
  function onPickStarter(event: MouseEvent<HTMLElement>) {
    if (event.detail === 0) return;
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => setServiceStage("details"), tapAdvanceDelayMs);
  }

  if (!setup) {
    return (
      <OnboardingFrame chapter={chapterOffer} preview={preview} signedIn={!preview}>
        <OnboardingStep
          title={
            staff?.error
              ? `Let’s reconnect to your ${t.business}.`
              : `Loading your ${t.business}.`
          }
          detail={
            staff?.error ||
            "Finding what is already set up so you can continue where you left off."
          }
          hideContinue
        >
          {staff?.error ? (
            <Button onClick={() => void staff.refresh()}>Try again</Button>
          ) : (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner aria-hidden="true" />
              Loading setup progress…
            </p>
          )}
          <Button
            variant="link"
            className="justify-self-start px-0"
            render={<Link href="/dashboard" />}
          >
            Return to workspace
          </Button>
        </OnboardingStep>
      </OnboardingFrame>
    );
  }
  const missing = setup.missing[0];
  const canAttach =
    preview ||
    !staff?.snapshot?.team.some(
      (member) => member.role === "owner" && member.practitionerId,
    );
  const activePractitioners = catalog.practitioners.filter(
    (person) => person.isActive !== false,
  );
  const activeServices = catalog.services.filter(
    (service) => service.isActive !== false,
  );
  const requiredService = activeServices.find(
    (service) =>
      service.resourceKind &&
      !catalog.resources.some(
        (resource) =>
          resource.isActive !== false &&
          resource.kind === service.resourceKind &&
          service.locationIds.includes(resource.locationId),
      ),
  );
  const neededResourceKind = preview
    ? resourceKind
    : (requiredService?.resourceKind ?? resourceKind);
  const suggestedResourceName =
    neededResourceKind === "chair"
      ? "Chair 1"
      : neededResourceKind === "room" && clinical
        ? "Consultation room 1"
        : `${neededResourceKind === "none" ? t.Resource : resourceKindLabels[neededResourceKind]} 1`;
  const eligibleResourceLocations = catalog.locations.filter(
    (location) =>
      location.isActive !== false &&
      (!requiredService || requiredService.locationIds.includes(location.id)),
  );
  const savedService = savedServiceId
    ? activeServices.find((service) => service.id === savedServiceId)
    : undefined;
  const needsPerson = setup.missing.includes("practitioner");
  const personName =
    doctorPick === "me" ? ownerName || `${t.Business} ${t.practitioner}` : doctorName.trim();

  // Saved gaps decide where setup stands; the optional photo and brand screens sit between them.
  const screen: Screen = photoPending
    ? "photo"
    : setup.complete
      ? "ready"
      : missing === "service"
        ? !introSeen
          ? "intro"
          : serviceStage === "details" && chosenServiceName
            ? "serviceDetails"
            : "service"
        : missing === "resource"
          ? "resource"
          : missing === "assignment"
            ? "assignment"
            : missing === "practitioner" && !personDone
              ? "person"
              : !brandDone
                ? "brand"
                : "hours";

  const flow: Screen[] = [
    "intro",
    "service",
    "serviceDetails",
    // The photo follows the saved service; a room or chair, when needed, comes after it.
    "photo",
    // Only a service that needs its own room or chair adds that step, so the count holds steady.
    ...(resourceKind !== "none" ||
    screen === "resource" ||
    activeServices.some((service) => service.resourceKind)
      ? (["resource"] as const)
      : []),
    ...(needsPerson || personDone ? (["person"] as const) : []),
    "brand",
    "hours",
  ];
  const stepNumber = flow.indexOf(screen) + 1;
  const chapter =
    screen === "ready" ? undefined : screen === "hours" ? chapterHours : chapterOffer;

  const previewService: Service = {
    id: savedServiceId ?? "setup-preview",
    clinicId: catalog.clinic.id,
    name: chosenServiceName || t.Service,
    description: chosenStarter?.description ?? "",
    durationMinutes: validDuration ? Number(duration) : 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    bookingMode,
    patientTypes: [],
    practitionerIds: [],
    locationIds: [],
    priceLabel,
    imageUrl: savedService?.imageUrl ?? null,
  };

  return (
    <OnboardingFrame
      chapter={chapter}
      stepNumber={stepNumber > 0 ? stepNumber : undefined}
      stepCount={flow.length}
      progress={
        screen === "ready" ? undefined : (
          <SetupStepper
            current={setupStage(screen)}
            labels={["Your offer", "Your page", "Opening hours"]}
            position={`Step ${stepNumber} of ${flow.length}`}
          />
        )
      }
      preview={preview}
      signedIn={!preview}
      wide={screen === "serviceDetails" || screen === "ready"}
    >
      {screen === "intro" ? (
        <OnboardingStep
          stepKey="intro"
          title="Three quick things and your booking page is live"
          detail="Each one takes about a minute. You can change all of it later in Settings."
          continueLabel="Let’s start"
          onContinue={() => setIntroSeen(true)}
          error={error}
        >
          <OnboardingDemo businessName={catalog.clinic.name} serviceName={starterServices[0]?.name ?? `Your first ${t.service}`} />
          <Card>
            <CardPanel>
              <ol className="grid gap-4 sm:grid-cols-3">
                {[
                  { icon: CalendarCheck2, title: `Your first ${t.service}`, detail: "Its name, length and price, with a photo if you have one." },
                  { icon: Users, title: "Who provides it", detail: `You, or someone on your team.` },
                  { icon: Clock, title: "When you’re open", detail: `The days and hours ${t.customers} can book.` },
                ].map(({ icon: Icon, title, detail }) => (
                  <li key={title} className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent" aria-hidden="true">
                      <Icon className="size-4.5" />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">{title}</span>
                      <span className="text-xs text-muted-foreground">{detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </CardPanel>
          </Card>
        </OnboardingStep>
      ) : screen === "service" ? (
        <OnboardingStep
          stepKey="service"
          title="What do people book first?"
          detail={`Start with one ${t.service}. You can add more later.`}
          error={error}
          onBack={() => setIntroSeen(false)}
          continueDisabled={!chosenServiceName}
          onContinue={() => {
            window.clearTimeout(advanceTimer.current);
            setServiceStage("details");
          }}
        >
          <RadioGroup
            aria-label={`First ${t.service}`}
            value={servicePick}
            onValueChange={(value) => {
              if (value === "other") setServicePick("other");
              else pickStarter(Number(value));
            }}
            className="grid gap-2 md:grid-cols-2"
          >
            {starterServices.map((item, index) => (
              <ChoiceCard
                key={item.name}
                value={String(index)}
                title={item.name}
                detail={`${item.durationMinutes} min · ${item.description}`}
                onPick={onPickStarter}
              />
            ))}
            <ChoiceCard
              value="other"
              title="Something else"
              detail={`Use the name your ${t.customers} already ask for.`}
            />
          </RadioGroup>
          {servicePick === "other" ? (
            <TypeInField
              id="setup-service-other"
              label={`${t.Service} name`}
              value={serviceOther}
              onChange={setServiceOther}
              required
              maxLength={160}
            />
          ) : null}
        </OnboardingStep>
      ) : screen === "serviceDetails" ? (
        <OnboardingStep
          stepKey="serviceDetails"
          title={`How long is ${chosenServiceName}?`}
          detail={`Set its length and price, and how your ${t.business} confirms ${t.appointments}.`}
          error={error}
          pending={pending}
          onBack={() => setServiceStage("pick")}
          continueDisabled={!chosenServiceName || !validDuration}
          continueLabel={`Save ${t.service}`}
          onContinue={() =>
            void (async () => {
              let createdId: string | null = null;
              const saved = await save(async () => {
                const created = await staffMutation<{ serviceId: string }>("/api/staff/services", "POST", {
                  name: chosenServiceName,
                  description: chosenStarter?.description ?? `A scheduled ${t.appointment}.`,
                  durationMinutes: Number(duration),
                  bookingMode,
                  ...(priceLabel ? { priceLabel } : {}),
                  ...(resourceKind !== "none"
                    ? { requiredResourceKind: resourceKind }
                    : {}),
                });
                createdId = created.serviceId;
              });
              if (saved) {
                setSavedServiceId(createdId);
                setPhotoPending(true);
              }
            })()
          }
        >
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem] md:items-start">
            <div className="grid min-w-0 gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <MinutesField
                  id="setup-duration"
                  label="Length in minutes"
                  min={5}
                  max={480}
                  value={duration}
                  onChange={setDuration}
                  hint="5 to 480 minutes."
                />
                <MinutesField
                  id="setup-price"
                  label="Price in ₹ (optional)"
                  min={0}
                  max={1000000}
                  step={50}
                  value={price}
                  onChange={setPrice}
                  hint="Leave empty to hide the price."
                />
              </div>
              <RadioGroup
                aria-label="Booking confirmation"
                value={bookingMode}
                onValueChange={(value) => setBookingMode(value === "instant" ? "instant" : "request")}
                className="grid gap-2"
              >
                <ChoiceCard
                  value="request"
                  title="You confirm each request"
                  detail={`${t.Customers} ask for a time; your team accepts it.`}
                />
                <ChoiceCard
                  value="instant"
                  title="Book straight away"
                  detail={`Open times are confirmed as soon as ${t.customers} choose them.`}
                />
              </RadioGroup>
              <SelectField
                id="setup-resource-kind"
                label={clinical ? "Space needed for this visit" : `${t.Resource} needed for this ${t.service}`}
                value={resourceKind}
                onValueChange={(value) =>
                  setResourceKind(
                    (bookableResourceKinds as readonly string[]).includes(value) ? (value as ResourceKind) : "none",
                  )
                }
                options={resourceKindOptions}
              />
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground" aria-hidden="true">How {t.customers} see it</p>
              {/* A picture of the booking card only; the fields beside it are the real controls. */}
              <div inert>
                <RadioGroup value={previewService.id} aria-label={`Preview of ${previewService.name}`}>
                  <ServiceCard service={previewService} layout="picture" />
                </RadioGroup>
              </div>
            </div>
          </div>
        </OnboardingStep>
      ) : screen === "photo" ? (
        <OnboardingStep
          stepKey="photo"
          title={`Add a photo of this ${t.service}`}
          detail={`${t.Customers} see it when they choose what to book. A clear, bright photo works best.`}
          error={error}
          continueLabel={savedService?.imageUrl ? "Next" : "Skip for now"}
          onContinue={() => setPhotoPending(false)}
        >
          <ImageUpload
            kind="service"
            ownerId={savedServiceId ?? undefined}
            label={`${chosenServiceName || t.Service} photo`}
            description="Landscape works best. JPEG, PNG or WebP."
            url={savedService?.imageUrl}
            saves={!preview && Boolean(savedServiceId)}
            onChanged={() => staff?.refresh()}
          />
          {savedService?.imageUrl ? (
            <Button type="button" variant="ghost" className="justify-self-start" onClick={() => setPhotoPending(false)}>
              Skip for now
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            You can add or change it later in Settings, under {t.Services}.
          </p>
        </OnboardingStep>
      ) : screen === "resource" ? (
        <OnboardingStep
          stepKey="resource"
          title={clinical ? "Give this visit a place." : `Name the ${t.resource}.`}
          detail={
            clinical
              ? "A named room or chair helps keep two visits from being booked into the same space."
              : `A named ${t.resource} keeps two ${t.appointments} from being booked into the same one at once.`
          }
          error={error}
          pending={pending}
          continueLabel={clinical ? "Save room or chair" : `Save ${t.resource}`}
          onContinue={() => {
            void save(() =>
              staffMutation("/api/staff/resources", "POST", {
                name: resourceName.trim() || suggestedResourceName,
                kind: neededResourceKind,
                locationId:
                  resourceLocationId || eligibleResourceLocations[0]?.id,
              }),
            );
          }}
        >
          <TypeInField
            id="setup-resource-name"
            label={clinical ? "Room or chair name" : `${t.Resource} name`}
            value={resourceName}
            onChange={setResourceName}
            placeholder={suggestedResourceName}
            hint="Leave blank to use the suggested name."
            maxLength={160}
          />
          {eligibleResourceLocations.length > 1 ? (
            <SelectField
              id="setup-resource-location"
              label={t.Location}
              value={resourceLocationId || eligibleResourceLocations[0]?.id}
              onValueChange={setResourceLocationId}
              options={eligibleResourceLocations.map((location) => ({
                value: location.id,
                label: `${location.name} · ${location.city}`,
              }))}
            />
          ) : null}
        </OnboardingStep>
      ) : screen === "person" ? (
        <OnboardingStep
          stepKey="person"
          title="Who provides it?"
          detail={`${t.Customers} see this name and photo when they book. Each team member signs in with their own account.`}
          error={error}
          continueDisabled={
            !doctorPick ||
            (doctorPick === "someone" &&
              (doctorName.trim().length < 2 || !doctorEmail.includes("@")))
          }
          onContinue={() => setPersonDone(true)}
        >
          <RadioGroup
            aria-label={`Who provides this ${t.service}`}
            value={doctorPick}
            onValueChange={(value) => setDoctorPick(value === "me" ? "me" : "someone")}
            className="grid gap-2 sm:grid-cols-2"
          >
            {canAttach ? (
              <ChoiceCard
                value="me"
                icon={<UserRound />}
                title="Just me"
                detail="Add a calendar profile to your owner account."
              />
            ) : null}
            <ChoiceCard
              value="someone"
              icon={<Users />}
              title="Someone else"
              detail="We make them an invite link so they choose their own password."
            />
          </RadioGroup>
          {doctorPick === "someone" ? (
            <>
              <TypeInField
                id="setup-doc-name"
                label="Name on the calendar"
                value={doctorName}
                onChange={setDoctorName}
                autoComplete="off"
                required
              />
              <TypeInField
                id="setup-doc-email"
                label="Work email"
                type="email"
                value={doctorEmail}
                onChange={setDoctorEmail}
                autoComplete="off"
                required
              />
            </>
          ) : null}
          {doctorPick ? (
            <>
              <PersonPhotoField name={personName || t.Practitioner} photo={doctorPhoto} onChange={setDoctorPhoto} onProblem={setMessage} hint="Optional. Cropped to a circle." />
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button type="button" variant="ghost" size="sm" className="justify-self-start px-0 data-panel-open:[&_svg]:rotate-180" />}
                >
                  {`Add a ${preset.providerFields.title.toLowerCase()} (optional)`}
                  <ChevronDown aria-hidden="true" className="motion-safe:transition-transform" />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="grid gap-4 pt-2 sm:grid-cols-2">
                    <TypeInField
                      id="setup-doc-title"
                      label={clinical ? "Professional title" : preset.providerFields.title}
                      value={doctorTitle}
                      onChange={setDoctorTitle}
                      placeholder={titlePlaceholder}
                    />
                    <TypeInField
                      id="setup-specialty"
                      label={preset.providerFields.specialty}
                      value={specialty}
                      onChange={setSpecialty}
                      placeholder={clinical ? "General practice" : preset.providerFields.specialtyPlaceholder}
                    />
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </>
          ) : null}
        </OnboardingStep>
      ) : screen === "brand" ? (
        <OnboardingStep
          stepKey="brand"
          title="Make it yours"
          detail={`Your logo and a cover photo appear at the top of your booking page. Both are optional.`}
          error={error}
          onBack={needsPerson ? () => setPersonDone(false) : undefined}
          continueLabel={catalog.clinic.logoUrl || catalog.clinic.coverUrl ? "Next" : "Skip for now"}
          onContinue={() => setBrandDone(true)}
        >
          <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
            <ImageUpload
              kind="business_logo"
              label="Logo"
              description="Square. Shown beside your name."
              url={catalog.clinic.logoUrl}
              saves={!preview}
              onChanged={() => staff?.refresh()}
            />
            <ImageUpload
              kind="business_cover"
              label="Cover photo"
              description="A wide photo of your place, your team or your work. It runs across the top of your page, with your logo on it, and on the first booking screen. 16:9 works best."
              url={catalog.clinic.coverUrl}
              saves={!preview}
              onChanged={() => staff?.refresh()}
            />
          </div>
          {catalog.clinic.logoUrl || catalog.clinic.coverUrl ? (
            <Button type="button" variant="ghost" className="justify-self-start" onClick={() => setBrandDone(true)}>
              Skip for now
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            You can add or change these later in Settings, under Business profile.
          </p>
        </OnboardingStep>
      ) : screen === "assignment" ? (
        <OnboardingStep
          stepKey="assignment"
          title={`Connect ${t.services} to your team.`}
          detail={`${t.aService.charAt(0).toUpperCase()}${t.aService.slice(1)} needs an eligible ${t.practitioner} at the same ${t.location} before ${t.customers} can book it.`}
          hideContinue
          error={error}
        >
          <p className="text-sm text-muted-foreground">
            Review each {t.service}’s {t.practitioners} and {t.locations} in
            Settings, then return here to check readiness.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" render={<Link href="/settings" />}>
              Open {t.service} settings
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => void staff?.refresh()}
            >
              Check readiness again
            </Button>
          </div>
        </OnboardingStep>
      ) : screen === "hours" ? (
        <OnboardingStep
          stepKey="hours"
          title={`When do you see ${t.customers}?`}
          detail={`These times decide which openings ${t.customers} see. Times are in ${catalog.clinic.timezone}.`}
          error={error}
          pending={pending}
          onBack={() => setBrandDone(false)}
          continueLabel={needsPerson ? "Save and go live" : "Save working hours"}
          continueDisabled={!validHours}
          onContinue={() =>
            void (needsPerson
              ? save(async () => {
                  const locationId = catalog.locations[0]?.id;
                  if (!locationId)
                    throw new Error(`Choose ${t.aLocation} first.`);
                  const created = await staffMutation<{ invite?: AccountLink }>(
                    "/api/staff/team/practitioners",
                    "POST",
                    {
                      attachToCurrentUser: doctorPick === "me",
                      name: personName,
                      title: doctorTitle.trim() || titlePlaceholder,
                      specialty: specialty.trim() || (clinical ? "General practice" : preset.label),
                      ...(doctorPick !== "me" ? { email: doctorEmail.trim() } : {}),
                      ...(doctorPhoto ? { photoDataUrl: doctorPhoto } : {}),
                      locationIds: [locationId],
                      serviceIds: activeServices.map((service) => service.id),
                      hours: draftToHoursBody(hours),
                    },
                  );
                  if (created.invite) setInvite({ name: doctorName.trim(), link: created.invite });
                }, ["practitioner", "hours"])
              : save(() => {
                  const person =
                    activePractitioners.find(
                      (item) =>
                        !staff?.snapshot?.availability.some(
                          (rule) => rule.practitionerId === item.id,
                        ),
                    ) ?? activePractitioners[0];
                  if (!person)
                    throw new Error(`Choose ${t.aPractitioner} first.`);
                  return staffMutation(
                    `/api/staff/team/practitioners/${person.id}`,
                    "PATCH",
                    { hours: draftToHoursBody(hours) },
                  );
                }))
          }
        >
          <RadioGroup
            aria-label="Usual hours"
            value={hoursPick}
            onValueChange={(value) => {
              const next = hourPresets[value as HoursPick];
              if (next) setHours(next.draft);
            }}
            className="grid gap-2 md:grid-cols-3"
          >
            {(Object.keys(hourPresets) as HoursPick[]).map((id) => (
              <ChoiceCard key={id} value={id} title={hourPresets[id].label} />
            ))}
          </RadioGroup>
          <Card>
            <CardPanel>
              <HoursEditor value={hours} onChange={setHours} affectedCount={0} uniform />
            </CardPanel>
          </Card>
        </OnboardingStep>
      ) : (
        <OnboardingStep
          stepKey="ready"
          title={
            preview
              ? "Your setup preview is complete."
              : "You’re live"
          }
          detail={
            preview
              ? "These choices were a rehearsal. The sample booking page uses its own demonstration services and hours."
              : `Share this link anywhere: messages, social profiles, email or a printed QR card. ${t.Customers} can book straight away, with or without a website.`
          }
          onContinue={() => router.push("/dashboard")}
          continueLabel={preview ? "Explore sample workspace" : "Open Today"}
          error={error}
        >
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_20rem] md:items-start">
            <div className="grid min-w-0 gap-5">
              <BookingLinkCard
                bookingPath={setup.bookingPath}
                preview={preview}
                onShareFailed={() =>
                  setMessage("Could not share. Copy the link above instead.")
                }
                customersWord={t.Customers}
              />
              {invite ? <AccessLinkNotice link={invite.link} name={invite.name} /> : null}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Have a website?</CardTitle>
                  <CardDescription>Optional next steps. The code is in Settings.</CardDescription>
                </CardHeader>
                <CardPanel>
                  <ul className="grid gap-3 text-sm">
                    {[
                      { icon: Link2, title: "Booking button", detail: "Point a button or menu item at your booking link." },
                      { icon: Code2, title: "Embedded page", detail: "Show the booking steps inside one of your pages." },
                      { icon: MessageSquareText, title: "Floating widget", detail: "A small Book button on every page of your site." },
                    ].map(({ icon: Icon, title, detail }) => (
                      <li key={title} className="flex items-start gap-3">
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block font-medium">{title}</span>
                          <span className="block text-xs text-muted-foreground">{detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="link"
                    className="mt-2 px-0"
                    render={<Link href="/settings" />}
                  >
                    Open Settings
                  </Button>
                </CardPanel>
              </Card>
            </div>
            <PagePreviewCard
              name={catalog.clinic.name}
              logoUrl={catalog.clinic.logoUrl}
              coverUrl={catalog.clinic.coverUrl}
              services={preview && chosenServiceName ? [previewService] : activeServices}
              servicesWord={t.Services}
            />
          </div>
        </OnboardingStep>
      )}
      {screen !== "ready" ? (
        <Button
          variant="link"
          className="self-start px-0"
          render={<Link href="/dashboard" />}
        >
          {preview
            ? "Skip to sample workspace"
            : "Finish later in your workspace"}
        </Button>
      ) : null}
    </OnboardingFrame>
  );
}

/** The top of the booking page as customers see it: cover, logo, name and the first services. */
function PagePreviewCard({
  name,
  logoUrl,
  coverUrl,
  services,
  servicesWord,
}: {
  name: string;
  logoUrl?: string | null;
  coverUrl?: string | null;
  services: Service[];
  servicesWord: string;
}) {
  return (
    <Card className="overflow-hidden" aria-label="Your booking page preview" role="group">
      {coverUrl ? (
        <div className="relative aspect-[5/2] w-full bg-muted">
          <Image src={coverUrl} alt="" fill unoptimized sizes="20rem" className="object-cover" />
        </div>
      ) : null}
      <CardHeader className="flex-row items-center gap-3">
        {logoUrl ? (
          <span className="relative size-10 shrink-0 overflow-hidden rounded-lg border bg-background">
            <Image src={logoUrl} alt="" fill unoptimized sizes="40px" className="object-cover" />
          </span>
        ) : null}
        <CardTitle className="min-w-0 truncate text-base">{name}</CardTitle>
      </CardHeader>
      <CardPanel className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">{servicesWord}</p>
        <ul className="flex flex-col gap-2">
          {services.slice(0, 3).map((service) => (
            <li key={service.id} className="flex items-center gap-3">
              <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent text-muted-foreground">
                {service.imageUrl ? (
                  <Image src={service.imageUrl} alt="" fill unoptimized sizes="40px" className="object-cover" />
                ) : (
                  <CalendarCheck2 className="size-4" aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{service.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{serviceMeta(service)}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardPanel>
    </Card>
  );
}

/**
 * The business's page is the product's front door: show its full link with copy, share and
 * open, and the direct booking link for anyone who wants to skip straight to booking.
 */
function BookingLinkCard({
  bookingPath,
  preview,
  customersWord,
  onShareFailed,
}: {
  bookingPath: string;
  preview: boolean;
  customersWord: string;
  onShareFailed: () => void;
}) {
  const [origin, setOrigin] = useState("");
  const [canShare, setCanShare] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => toastManager.add({ title: "Link copied", type: "success" }),
  });
  // The origin is only known in the browser; render the path first so server and client markup match.
  useEffect(() => {
    queueMicrotask(() => {
      setOrigin(window.location.origin);
      setCanShare(typeof navigator.share === "function");
    });
  }, []);
  // The business's page sits beside its booking page: /b/slug next to /book/slug.
  const pagePath = bookingPath.replace(/^\/book\//, "/b/");
  const url = origin ? new URL(pagePath, origin).href : pagePath;
  const bookingUrl = origin ? new URL(bookingPath, origin).href : bookingPath;

  return (
    <Card>
      <CardPanel className="grid gap-2">
      <Label htmlFor="setup-booking-link" className="text-sm font-medium">
        {preview ? "Sample page link" : "Your page"}
      </Label>
      <InputGroup>
        <InputGroupInput
          id="setup-booking-link"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <Button size="xs" variant="ghost" onClick={() => copyToClipboard(url)}>
            {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {isCopied ? "Copied" : "Copy"}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          render={<Link href={pagePath} target="_blank" rel="noopener noreferrer" />}
        >
          <ExternalLink aria-hidden="true" />
          Open my page
        </Button>
        <Button
          variant="ghost"
          size="sm"
          render={<Link href={bookingPath} target="_blank" rel="noopener noreferrer" />}
        >
          Open my booking page
        </Button>
        {canShare ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.share({ title: "Book online", url }).catch((cause: unknown) => {
                if (cause instanceof Error && cause.name === "AbortError") return;
                onShareFailed();
              });
            }}
          >
            <Share2 aria-hidden="true" />
            Share
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {customersWord} see your services, team, hours and reviews, then book. No account needed.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>Direct booking link:</span>
        <code className="min-w-0 break-all">{bookingUrl}</code>
        <Button size="xs" variant="ghost" onClick={() => copyToClipboard(bookingUrl)} aria-label="Copy direct booking link">
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
      </CardPanel>
    </Card>
  );
}
