"use client";

import { calm } from "./booking-motion";
import { fullNameProblem } from "./full-name";
import Image from "next/image";
import { MotionConfig, motion } from "motion/react";
import { ArrowRight, CalendarDays, ClipboardList, Clock3, MapPin, TriangleAlert, UserRound, Users, Video } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { TurnstileField, useBotCheck } from "@/components/turnstile-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MAX_PROPOSED_TIMES, mayNeedApproval } from "@/lib/approval";
import { bookingBotFieldNames } from "@/lib/bot-check";
import { formForService, type FormAnswer, type FormAnswers } from "@/lib/booking-forms";
import { contactProblem, defaultIntakeSettings, needsEmailCheck } from "@/lib/booking-intake";
import { isClinicalBusinessType } from "@/lib/business-types";
import { cn } from "@/lib/utils";
import type { PatientType, Service, TimeSlot } from "@/lib/domain";
import type { LocationOptionKind } from "@/lib/service-setup";

import { useBusinessProfile, useFeatures, useTerms } from "../terms/business-profile-context";
import {
  answersToSend,
  checkQuestions,
  guestsProblem,
  isEmailAddress,
  isPhoneNumber,
  prefillForForm,
  pruneAnswers,
  readLinkDetails,
  shownQuestions,
  usableChannel,
  type LinkParams,
} from "./booking-answers";
import { BookingBottomBar } from "./booking-bottom-bar";
import { BookingConfirmation } from "./booking-confirmation";
import { formatLongDate, formatShortDate, formatTime, getDurationLabel, withServiceDuration } from "./booking-format";
import { bookingSteps, nextStep, previousStep, stepForField, type BookingStepId } from "./booking-steps";
import { BookingPanel, BookingPanelBar, type PanelLine, type PanelUpcoming } from "./booking-panel";
import { BusinessLine, BusinessLogo } from "./booking-summary";
import type { BookingFlowProps, BookingSuccess, PublicApiError } from "./booking-types";
import { lengthPrice, locationOptionsFor, meetLabel, needsMeetStep, serviceChoices, serviceLengths } from "./booking-options";
import { HoldStatus } from "./hold-status";
import { ConfirmingPayment, paymentStatusCheck } from "./confirming-payment";
import { startPayment, type PendingPaymentBooking } from "./online-payment";
import { PayStep } from "./pay-step";
import { PaymentPolicyCard } from "./payment-policy-card";
import { PublicCodeField, type AppliedCode } from "./public-code-field";
import { serviceMeta } from "./service-card";
import { DetailsStep, todayIsoDate, type DetailsValues } from "./steps/details-step";
import { LengthStep } from "./steps/length-step";
import { LocationStep } from "./steps/location-step";
import { MeetStep } from "./steps/meet-step";
import { ProviderStep } from "./steps/provider-step";
import { QuestionsStep } from "./steps/questions-step";
import { EmailCheckBlock } from "./steps/email-check-block";
import { ServiceStep } from "./steps/service-step";
import { StepBackButton, StepBackContext } from "./steps/step-header";
import { TimeStep, type AwayNotice } from "./steps/time-step";
import { JoinWaitlist } from "./join-waitlist";
import { ProposedTimes, proposableSlots } from "./proposed-times";
import { useBookingDisplay, useMediaQuery } from "./use-booking-display";
import { useEmbedEvents } from "./use-embed-events";
import { emitEmbedEvent } from "@/lib/embed/events";
import { useEmailCheck } from "./use-email-check";
import { useSlotHold } from "./use-slot-hold";
import { useNextFree } from "./use-next-free";
import { formatClock, mergeIntervals, missingRange, splitRange, type Interval } from "./zone-time";

interface BookingFormState extends DetailsValues {
  locationId: string;
  serviceId: string;
  practitionerId?: string | "first_available";
  slot?: TimeSlot;
  /** The length the customer chose, when the service offers several. Empty means the usual length. */
  durationMinutes?: number;
  /** How the customer chose to meet, when the service offers a choice. */
  locationKind?: LocationOptionKind;
  /** The customer's address, for "at your address". */
  locationDetail: string;
}

const initialState: BookingFormState = {
  locationId: "",
  serviceId: "",
  locationDetail: "",
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  dateOfBirth: "",
  reasonForVisit: "",
  preferredChannel: "sms",
  messagingConsent: false,
  accessibilityNeed: "",
  acceptedPrivacyNotice: false,
};

const errorTargetIds: Record<string, string> = {
  bookingFor: "booking-for",
  locationId: "location-options",
  serviceId: "service-options",
  practitionerId: "practitioner-options",
  slotId: "booking-slots",
  startsAt: "booking-slots",
  durationMinutes: "length-options",
  locationChoice: "meet-options",
  "locationChoice.detail": "meet-address",
  firstName: "first-name",
  lastName: "first-name",
  phone: "phone",
  email: "email",
  dateOfBirth: "date-of-birth",
  reasonForVisit: "reason-for-visit",
  preferredChannel: "preferred-channel",
  accessibilityNeed: "accessibility-need",
  acceptedPrivacyNotice: "privacy-notice",
  messagingConsent: "messaging-consent",
  guests: "guest-0",
  emailCheck: "email-check",
};

const noLinkParams: LinkParams = {};

/** How long a tapped choice stays visible before the next screen slides in. */
const tapAdvanceDelayMs = 180;

/** The history entry's own key, so Back in the browser returns to the previous screen. */
const historyKey = "kalendrBookingStep";

/** The site that sent the customer here, host only. Our own pages don't count. */
function referringHost(): string | undefined {
  try {
    const host = document.referrer ? new URL(document.referrer).host : "";
    return host && host !== window.location.host ? host : undefined;
  } catch {
    return undefined;
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function apiErrorFromPayload(payload: unknown): PublicApiError | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as Partial<PublicApiError>;
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") {
    return undefined;
  }

  return candidate as PublicApiError;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `booking-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Answers to the business's own questions are keyed `formAnswers.<question id>` and rendered as `form-<question id>`. */
function errorTarget(field: string): string {
  if (field.startsWith("formAnswers.")) return `form-${field.slice("formAnswers.".length)}`;
  if (field.startsWith("guests.")) return "guest-0";
  return errorTargetIds[field] ?? field;
}

function setAnswer(answers: FormAnswers, id: string, value: FormAnswer | undefined): FormAnswers {
  const next = { ...answers };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

function historyStep(state: unknown): BookingStepId | undefined {
  if (!state || typeof state !== "object") return undefined;
  const step = (state as Record<string, unknown>)[historyKey];
  return typeof step === "string" ? (step as BookingStepId) : undefined;
}

function ErrorSummary({
  errors,
  summaryRef,
  labels = {},
}: {
  errors: Record<string, string>;
  /** Names shown before a short message, so "Answer this question." says which question. */
  labels?: Record<string, string>;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  if (Object.keys(errors).length === 0) {
    return null;
  }

  return (
    <Alert
      ref={summaryRef}
      tabIndex={-1}
      variant="error"
      aria-labelledby="error-summary-title"
      className="outline-none"
    >
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>
        <h2 id="error-summary-title">Please check the following</h2>
      </AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 ps-5">
          {Object.entries(errors).map(([field, message]) => (
            <li key={field}>
              <a
                href={`#${errorTarget(field)}`}
                className="text-foreground underline underline-offset-4"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(errorTarget(field))?.focus();
                }}
              >
                {labels[field] ? `${labels[field]} — ${message}` : message}
              </a>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The customer booking flow. One question per screen, and only the screens this
 * business and this customer need (see `booking-steps.ts`). Each screen lives in
 * `./steps`; this component holds the answers, moves between screens and sends
 * the booking.
 */
export function BookingFlow({
  clinic,
  locations,
  services,
  practitioners,
  resources,
  initialSlots,
  allowDemoFallback = false,
  origin,
  initialServiceId,
  initialPersonId,
  initialDate,
  initialTime,
  forms = [],
  turnstileSiteKey = null,
  prefill = noLinkParams,
  linkContext,
}: BookingFlowProps) {
  const t = useTerms();
  const bot = useBotCheck();
  const botCheckWaiting = bot.shown && Boolean(turnstileSiteKey) && !bot.token;
  // How long the page was open before sending; scripts post at once. Set after mount.
  const openedAtRef = useRef<number | null>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    openedAtRef.current = Date.now();
  }, []);
  const features = useFeatures();
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  const askBookingFor = features.dependents;
  const activeLocations = useMemo(() => locations.filter((location) => location.isActive !== false), [locations]);
  // A shared link such as /book/slug?service=id opens with that service already chosen.
  const validInitialServiceId = services.some((service) => service.id === initialServiceId && service.isActive !== false)
    ? (initialServiceId as string)
    : "";
  // A link from a team member's profile (?person=id) books with them. It only counts when they
  // offer an active service at one of the active locations they work at (and the linked service, if any).
  const linkedPerson = useMemo(() => {
    const person = practitioners.find((practitioner) => practitioner.id === initialPersonId);
    if (!person) return undefined;
    const theirServices = services.filter(
      (service) =>
        service.isActive !== false &&
        service.practitionerIds.includes(person.id) &&
        activeLocations.some((location) => person.locationIds.includes(location.id) && service.locationIds.includes(location.id)),
    );
    if (theirServices.length === 0) return undefined;
    if (validInitialServiceId && !theirServices.some((service) => service.id === validInitialServiceId)) return undefined;
    return person;
  }, [activeLocations, initialPersonId, practitioners, services, validInitialServiceId]);
  /** Cleared when the customer asks to choose someone else, so the people screen appears. */
  const [keepLinkedPerson, setKeepLinkedPerson] = useState(true);
  const pinnedPerson = keepLinkedPerson ? linkedPerson : undefined;
  const locationChoices = useMemo(
    () => (pinnedPerson ? activeLocations.filter((location) => pinnedPerson.locationIds.includes(location.id)) : activeLocations),
    [activeLocations, pinnedPerson],
  );
  // A day from the link (?date=YYYY-MM-DD) opens the calendar there when it has free times.
  const validInitialDate = initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : undefined;
  // Details from the link (?name=, ?email=, ?phone=, ?notes=, ?guests=, ?location=). Anything invalid was left out.
  const linkDetails = useMemo(() => readLinkDetails(prefill), [prefill]);
  const linkedLocationId =
    linkDetails.locationId &&
    locationChoices.some((location) => location.id === linkDetails.locationId) &&
    (!validInitialServiceId || services.find((service) => service.id === validInitialServiceId)?.locationIds.includes(linkDetails.locationId))
      ? linkDetails.locationId
      : "";
  const [guests, setGuests] = useState<string[]>(() => linkDetails.guests);
  const [formState, setFormState] = useState<BookingFormState>(() => ({
    ...initialState,
    firstName: linkDetails.firstName ?? "",
    lastName: linkDetails.lastName ?? "",
    email: linkDetails.email ?? "",
    phone: linkDetails.phone ?? "",
    reasonForVisit: linkDetails.reasonForVisit ?? "",
    bookingFor: askBookingFor ? "self" : undefined,
    // With one place to go, it is chosen for the customer.
    locationId: locationChoices.length === 1 ? locationChoices[0].id : linkedLocationId,
    serviceId: validInitialServiceId,
    practitionerId: linkedPerson?.id,
  }));
  /** Set when the customer asks to change a service that came with the link, so its screen appears. */
  const [wantsServiceChange, setWantsServiceChange] = useState(false);
  const [formAnswers, setFormAnswers] = useState<FormAnswers>({});
  // Optional text questions answered No. Client-only: never part of the answers that are sent.
  const [declinedQuestions, setDeclinedQuestions] = useState<readonly string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [awayNotices, setAwayNotices] = useState<AwayNotice[]>([]);
  const [fullDays, setFullDays] = useState<string[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [slotLoadError, setSlotLoadError] = useState("");
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const [isFetchingRange, setIsFetchingRange] = useState(false);
  const [rangeError, setRangeError] = useState("");
  /** Bumped to make the time screen ask again for what it is showing (after a time was taken). */
  const [coverageVersion, setCoverageVersion] = useState(0);
  /** Stretches of time (ms) whose openings are already loaded. */
  const coverage = useRef<Interval[]>([]);
  const rangeAbort = useRef<AbortController | null>(null);
  const lastWantedRange = useRef<Interval | null>(null);
  const [holdNotice, setHoldNotice] = useState<{ kind: "taken" | "expired"; message: string }>();
  const [submissionError, setSubmissionError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState<BookingSuccess>();
  // Online payment (feature 23): a booking saved and waiting for money, then the wait for the server to confirm it.
  const [pendingPayment, setPendingPayment] = useState<{ booking: PendingPaymentBooking; stage: "pay" | "confirming" }>();
  // The service the customer agreed the payment policy for. Choosing another service asks again.
  const [agreedPolicyFor, setAgreedPolicyFor] = useState<string>();
  const [appliedCode, setAppliedCode] = useState<AppliedCode | null>(null);
  const [isPreviewAvailability, setIsPreviewAvailability] = useState(false);
  /** Other times the customer ticked (feature 41). Only valid for the service, person and time they were ticked for. */
  const [proposed, setProposed] = useState<{ scope: string; ids: string[] }>({ scope: "", ids: [] });
  /** The time from the link (?time=), until the free times that could hold it have arrived once. */
  const linkedTime = useRef<number | undefined>(initialTime && !Number.isNaN(Date.parse(initialTime)) ? Date.parse(initialTime) : undefined);
  /** Set when the linked time was chosen for the customer, so the time screen can move on once. */
  const [linkedSlotId, setLinkedSlotId] = useState<string>();
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const focusSummaryOnErrors = useRef(false);
  const stepContainerRef = useRef<HTMLDivElement>(null);
  const idempotencyKeyRef = useRef<string | undefined>(undefined);

  /** Keeps the chosen service when it is still offered for the new location. */
  function keepService(serviceId: string, change: { locationId?: string }): string {
    const service = services.find((item) => item.id === serviceId);
    if (!service) return "";
    if (change.locationId && !service.locationIds.includes(change.locationId)) return "";
    return serviceId;
  }

  const selectedLocation = locations.find((location) => location.id === formState.locationId);
  const selectedService = services.find((service) => service.id === formState.serviceId);
  useEmbedEvents({ service: selectedService, slot: formState.slot, success });
  const timeZone = selectedLocation?.timezone ?? clinic.timezone;

  // How long, and how to meet, for the chosen service. Old services have one length and meet in person.
  const { lengths, length: chosen, meetOptions, meetAsked, meetKind, sendsLocationChoice } = useMemo(
    () => serviceChoices(selectedService, formState.locationId, { minutes: formState.durationMinutes, kind: formState.locationKind }),
    [formState.durationMinutes, formState.locationId, formState.locationKind, selectedService],
  );
  const hasLengths = lengths.length > 1;
  const durationMinutes = chosen?.minutes ?? selectedService?.durationMinutes;
  // Layout, time zone and clock for the time screen. A visit at the branch (or at the customer's door) keeps the branch's time when the service locks it.
  const display = useBookingDisplay({
    clinic,
    service: selectedService,
    businessZone: timeZone,
    locale: clinic.locale,
    inPerson: !meetKind || meetKind === "in_person" || meetKind === "their_address",
  });

  const availableServices = useMemo(
    () =>
      services.filter(
        (service) =>
          (!formState.locationId || service.locationIds.includes(formState.locationId)) &&
          (!pinnedPerson || service.practitionerIds.includes(pinnedPerson.id)),
      ),
    [formState.locationId, pinnedPerson, services],
  );
  // The customer is never asked whether they are new; send a type the chosen service accepts.
  const effectivePatientType: PatientType | undefined = selectedService
    ? selectedService.patientTypes.includes("new")
      ? "new"
      : selectedService.patientTypes[0]
    : undefined;
  const effectiveBookingFor = askBookingFor ? formState.bookingFor : "self";

  const availablePractitioners = useMemo(() => {
    if (!selectedService || !selectedLocation) {
      return [];
    }

    return practitioners.filter(
      (practitioner) =>
        selectedService.practitionerIds.includes(practitioner.id) &&
        practitioner.locationIds.includes(selectedLocation.id),
    );
  }, [practitioners, selectedLocation, selectedService]);

  // The business's own questions for the chosen service, if it set any up.
  const bookingForm = formState.serviceId ? formForService(forms, formState.serviceId) : undefined;

  // How this service takes contact details, guests and the email check.
  const intake = selectedService?.intake ?? defaultIntakeSettings;
  const allowGuests = intake.allowGuests;
  const phoneOnly = intake.contactMode === "phone_only";
  const effectiveGuests = useMemo(() => (allowGuests ? guests.slice(0, intake.maxGuests) : []), [allowGuests, guests, intake.maxGuests]);
  // The preview has no database to send codes from, so nothing is asked of the customer there.
  const emailCheckRequired = !allowDemoFallback && needsEmailCheck(intake, formState.email);
  const emailCheck = useEmailCheck({ clinicSlug: clinic.slug, serviceId: formState.serviceId, email: formState.email });
  const emailCheckBlocked = emailCheckRequired && !emailCheck.verified && !emailCheck.notRequired;
  // Once the email is confirmed, the "confirm your email" message no longer applies.
  if (emailCheck.verified && errors.emailCheck) {
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => field !== "emailCheck")));
  }
  const emailLocked = !phoneOnly && Boolean(linkDetails.email) && formState.email === linkDetails.email;

  // Values the link fills into this form: read-only ones and link-only ones always come from the link.
  const formPrefill = useMemo(() => prefillForForm(bookingForm, prefill, allowGuests), [allowGuests, bookingForm, prefill]);
  const effectiveAnswers = useMemo(() => ({ ...formAnswers, ...formPrefill.forced }), [formAnswers, formPrefill.forced]);
  // Other link values start the answer once per form; the customer can change them.
  const [seededForms, setSeededForms] = useState<string[]>([]);
  if (bookingForm && !seededForms.includes(bookingForm.id)) {
    setSeededForms([...seededForms, bookingForm.id]);
    const starting = Object.entries(formPrefill.answers).filter(([id]) => !(id in formPrefill.forced));
    if (starting.length > 0) setFormAnswers((current) => ({ ...Object.fromEntries(starting), ...current }));
  }

  // Before the customer answers, plan for the busiest case among the services still open to
  // them, so the step count only ever shrinks as they go.
  const candidateServices = useMemo(
    () =>
      services.filter(
        (service) =>
          service.isActive !== false &&
          (!formState.locationId || service.locationIds.includes(formState.locationId)) &&
          (!pinnedPerson || service.practitionerIds.includes(pinnedPerson.id)),
      ),
    [formState.locationId, pinnedPerson, services],
  );
  const eligiblePeopleCount = useMemo(() => {
    // A service that gives bookings out itself (feature 20) never asks who the customer wants.
    const peopleFor = (service: Service) => service.assignment && service.assignment !== "customer_chooses" ? 1 :
      practitioners.filter(
        (practitioner) =>
          service.practitionerIds.includes(practitioner.id) &&
          (formState.locationId
            ? practitioner.locationIds.includes(formState.locationId)
            : practitioner.locationIds.some((id) => service.locationIds.includes(id))),
      ).length;
    if (selectedService) return peopleFor(selectedService);
    return candidateServices.reduce((most, service) => Math.max(most, peopleFor(service)), 0);
  }, [candidateServices, formState.locationId, practitioners, selectedService]);

  const steps = bookingSteps({
    locationCount: locationChoices.length,
    servicePreselected:
      Boolean(validInitialServiceId) && formState.serviceId === validInitialServiceId && !wantsServiceChange,
    personPreselected: Boolean(pinnedPerson),
    eligiblePeopleCount,
    hasLengths: selectedService
      ? hasLengths
      : candidateServices.some((service) => serviceLengths(service).length > 1),
    hasMeet: selectedService
      ? meetAsked
      : candidateServices.some((service) => needsMeetStep(locationOptionsFor(service, formState.locationId))),
    hasForm: selectedService
      ? Boolean(bookingForm) && shownQuestions(bookingForm as NonNullable<typeof bookingForm>, allowGuests).length > 0
      : candidateServices.some((service) => {
          const form = formForService(forms, service.id);
          return Boolean(form) && shownQuestions(form as NonNullable<typeof form>, service.intake?.allowGuests ?? false).length > 0;
        }),
  });
  const providerShown = steps.includes("provider");

  // With one person (or none) for this service, the time screen asks for any of them.
  const practitionerChoice: string | undefined = pinnedPerson
    ? selectedService && selectedLocation
      ? pinnedPerson.id
      : undefined
    : providerShown
    ? formState.practitionerId
    : selectedService && selectedLocation
      ? availablePractitioners.length === 1
        ? availablePractitioners[0].id
        : "first_available"
      : undefined;

  const [stepState, setStepState] = useState<BookingStepId>(() => steps[0]);
  const [direction, setDirection] = useState<"forward" | "back" | "none">("none");
  const step: BookingStepId = steps.includes(stepState)
    ? stepState
    : (nextStep(steps, stepState) ?? steps[steps.length - 1]);
  const stepIndex = steps.indexOf(step);
  /** The screens in this tab's history up to the current one, to tell Back apart from a jump. */
  const historyStack = useRef<BookingStepId[]>([]);
  const advanceTimer = useRef<number | undefined>(undefined);
  const successRef = useRef(false);
  useEffect(() => {
    successRef.current = Boolean(success);
  }, [success]);

  const getDemoSlots = useMemo(() => {
    if (!selectedService || !selectedLocation || !practitionerChoice) {
      return [];
    }

    const allowedPractitionerIds = new Set(
      availablePractitioners.map((practitioner) => practitioner.id),
    );

    return initialSlots
      .filter((slot) => {
        const resource = resources.find((item) => item.id === slot.resourceId);
        const resourceMatches = !resource || resource.locationId === selectedLocation.id;
        const practitionerMatches =
          practitionerChoice === "first_available"
            ? allowedPractitionerIds.has(slot.practitionerId)
            : slot.practitionerId === practitionerChoice;
        return resourceMatches && practitionerMatches;
      })
      .map((slot) => ({
        ...slot,
        endsAt: withServiceDuration(
          slot.startsAt,
          durationMinutes ?? selectedService.durationMinutes,
        ),
      }));
  }, [
    availablePractitioners,
    durationMinutes,
    practitionerChoice,
    initialSlots,
    resources,
    selectedLocation,
    selectedService,
  ]);

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimer.current !== undefined) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = undefined;
    }
  }, []);

  // The first screen becomes this page's history entry; later screens are pushed on top.
  useEffect(() => {
    const first = stepState;
    window.history.replaceState({ ...window.history.state, [historyKey]: first }, "");
    historyStack.current = [first];

    function onPopState(event: PopStateEvent) {
      if (successRef.current) return;
      const target = historyStep(event.state);
      if (!target) return;
      clearAdvanceTimer();
      const index = historyStack.current.lastIndexOf(target);
      if (index >= 0) {
        historyStack.current = historyStack.current.slice(0, index + 1);
        setDirection("back");
      } else {
        historyStack.current = [...historyStack.current, target];
        setDirection("forward");
      }
      setErrors({});
      setSubmissionError("");
      setStepState(target);
    }

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      clearAdvanceTimer();
    };
    // Runs once: the history entry belongs to the screen the page opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each new screen announces itself: focus moves to its title.
  const hasChangedStep = useRef(false);
  useEffect(() => {
    if (!hasChangedStep.current) {
      hasChangedStep.current = true;
      return;
    }
    stepContainerRef.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [step]);

  // Only a failed Continue or submit moves focus here. Fixing a field also changes
  // `errors`, and taking focus then would pull the customer out of the field mid-word.
  useEffect(() => {
    if (focusSummaryOnErrors.current && Object.keys(errors).length > 0) {
      focusSummaryOnErrors.current = false;
      errorSummaryRef.current?.focus();
    }
  }, [errors]);

  useEffect(() => {
    idempotencyKeyRef.current = undefined;
  }, [formState.slot?.id]);

  /** Sent only when the service offers several lengths. */
  const lengthQuery = hasLengths ? durationMinutes : undefined;
  const linkHoldToken = prefill?.hold;
  const availabilityQuery = useMemo(() => {
    if (!formState.locationId || !formState.serviceId || !practitionerChoice) return null;
    const query = new URLSearchParams({
      clinicSlug: clinic.slug,
      locationId: formState.locationId,
      serviceId: formState.serviceId,
    });
    // "Anyone" is asked for as one pooled list: each time once, with the person chosen when the booking is made (feature 20).
    query.set("practitionerId", practitionerChoice === "first_available" ? "anyone" : practitionerChoice);
    // Times are worked out for the chosen length, so each length gets its own openings.
    if (lengthQuery !== undefined) query.set("durationMinutes", String(lengthQuery));
    // A link that already holds a time for this customer (one an assistant made) lists that time as open for them.
    if (linkHoldToken) query.set("holdToken", linkHoldToken);
    // A combined link only offers times when everyone on it is free.
    if (linkContext?.kind === "combined") query.set("combo", linkContext.slug);
    // A routing form picked the people: the server only lists times for them (feature 46).
    if (linkContext?.kind === "routing") query.set("routingToken", linkContext.token);
    return query.toString();
  }, [clinic.slug, formState.locationId, formState.serviceId, lengthQuery, linkContext, practitionerChoice, linkHoldToken]);

  const nextFreeData = useNextFree({
    enabled: providerShown && step === "provider",
    clinicSlug: clinic.slug,
    locationId: formState.locationId,
    serviceId: formState.serviceId,
    durationMinutes: lengthQuery,
  });
  const nextFreeProp = nextFreeData.error
    ? null
    : {
        loading: nextFreeData.loading,
        earliest: nextFreeData.earliest ? `${formatShortDate(nextFreeData.earliest, clinic.locale, timeZone)}, ${formatTime(nextFreeData.earliest, clinic.locale, timeZone)}` : null,
        byPerson: Object.fromEntries(Object.entries(nextFreeData.nextByPerson).map(([id, at]) => [id, `${formatShortDate(at, clinic.locale, timeZone)}, ${formatTime(at, clinic.locale, timeZone)}`])),
      };

  useEffect(() => {
    if (!availabilityQuery) {
      return;
    }

    const abortController = new AbortController();
    const query = new URLSearchParams(availabilityQuery);
    coverage.current = [];
    rangeAbort.current?.abort();

    // A time picked on a profile page is chosen here when it is still free. Only tried once.
    function chooseLinkedTime(found: TimeSlot[]) {
      const wanted = linkedTime.current;
      if (wanted === undefined) return;
      linkedTime.current = undefined;
      const slot = found.find((entry) => Date.parse(entry.startsAt) === wanted);
      if (!slot) return;
      setFormState((current) => (current.slot ? current : { ...current, slot }));
      setLinkedSlotId(slot.id);
    }

    async function loadAvailability() {
      setIsFetchingRange(false);
      setRangeError("");
      setIsLoadingSlots(true);
      setSlotLoadError("");
      setIsPreviewAvailability(false);

      try {
        const requestedAt = Date.now();
        const response = await fetch(`/api/public/availability?${query}`, {
          signal: abortController.signal,
          headers: { Accept: "application/json" },
        });
        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const apiError = apiErrorFromPayload(payload);
          throw new Error(apiError?.message ?? "Available times could not be loaded.");
        }

        const data = (payload as { data?: { slots?: TimeSlot[]; outOfOffice?: AwayNotice[]; fullDays?: string[] } } | undefined)?.data;
        if (abortController.signal.aborted) return;
        if (!Array.isArray(data?.slots)) {
          throw new Error("The availability response was incomplete.");
        }

        setSlots(data.slots);
        setAwayNotices(Array.isArray(data.outOfOffice) ? data.outOfOffice : []);
        setFullDays(Array.isArray(data.fullDays) ? data.fullDays : []);
        // With no range asked for, the server answers for the next two weeks.
        coverage.current = [{ from: requestedAt, to: requestedAt + 14 * 86_400_000 }];
        chooseLinkedTime(data.slots);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        if (allowDemoFallback && isNetworkError(error)) {
          setSlots(getDemoSlots);
          coverage.current = [{ from: 0, to: Number.MAX_SAFE_INTEGER }];
          chooseLinkedTime(getDemoSlots);
          setIsPreviewAvailability(true);
          return;
        }

        setSlots([]);
        setSlotLoadError(
          error instanceof Error
            ? error.message
            : "Available times could not be loaded.",
        );
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoadingSlots(false);
        }
      }
    }

    void loadAvailability();
    return () => {
      abortController.abort();
      rangeAbort.current?.abort();
    };
  }, [allowDemoFallback, availabilityAttempt, availabilityQuery, getDemoSlots]);

  /**
   * Loads openings for days the customer paged to. Only the part not loaded yet is asked for, in windows of
   * about two weeks so no answer comes near the server's limit. A newer request cancels the one before it.
   */
  const loadRange = useCallback((wanted: Interval) => {
    lastWantedRange.current = wanted;
    if (!availabilityQuery) return;
    const gap = missingRange({ from: Math.max(wanted.from, Date.now()), to: wanted.to }, coverage.current);
    if (!gap || gap.from >= gap.to) return;
    rangeAbort.current?.abort();
    const controller = new AbortController();
    rangeAbort.current = controller;
    setIsFetchingRange(true);
    setRangeError("");

    async function fetchWindow(window: Interval) {
      const query = new URLSearchParams(availabilityQuery as string);
      query.set("from", new Date(window.from).toISOString());
      query.set("to", new Date(window.to).toISOString());
      const response = await fetch(`/api/public/availability?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } });
      const payload: unknown = await response.json().catch(() => undefined);
      const data = (payload as { data?: { slots?: TimeSlot[]; outOfOffice?: AwayNotice[]; fullDays?: string[] } } | undefined)?.data;
      if (!response.ok || !Array.isArray(data?.slots)) throw new Error("More times could not be loaded.");
      return { window, slots: data.slots, away: Array.isArray(data.outOfOffice) ? data.outOfOffice : [], full: Array.isArray(data.fullDays) ? data.fullDays : [] };
    }

    Promise.all(splitRange(gap).map(fetchWindow))
      .then((results) => {
        if (controller.signal.aborted) return;
        setSlots((current) => {
          const kept = current.filter((slot) => {
            const at = Date.parse(slot.startsAt);
            return !results.some(({ window }) => at >= window.from && at < window.to);
          });
          return [...kept, ...results.flatMap((result) => result.slots)];
        });
        setFullDays((current) => [...new Set([...current, ...results.flatMap((result) => result.full)])].sort());
        setAwayNotices((current) => {
          const known = new Set(current.map((notice) => `${notice.practitionerId}:${notice.startsAt}`));
          return [...current, ...results.flatMap((result) => result.away).filter((notice) => !known.has(`${notice.practitionerId}:${notice.startsAt}`))];
        });
        coverage.current = mergeIntervals([...coverage.current, ...results.map((result) => result.window)]);
        setIsFetchingRange(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setIsFetchingRange(false);
        setRangeError("More times could not be loaded.");
      });
    // coverageVersion changes the identity so the time screen asks again after a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availabilityQuery, coverageVersion]);

  // A picked time is held for the customer while they fill in the form. Nothing is held in preview mode.
  const isPhone = useMediaQuery("(max-width: 767px)");
  const isWide = useMediaQuery("(min-width: 1024px)");
  const slotHold = useSlotHold({ clinicSlug: clinic.slug, enabled: !allowDemoFallback, onExpired: handleHoldExpired, ...(linkContext?.kind === "routing" ? { routingToken: linkContext.token } : {}) });
  const slotHoldLatest = useRef(slotHold);
  useEffect(() => {
    slotHoldLatest.current = slotHold;
  });

  /** Sends the customer back to pick again, with the reason. */
  function backToTime(notice: { kind: "taken" | "expired"; message: string }) {
    clearAdvanceTimer();
    setHoldNotice(notice);
    setFormState((current) => ({ ...current, slot: undefined }));
    goTo("time", "replace", "back");
  }

  function handleHoldExpired() {
    backToTime({ kind: "expired", message: "The time we were holding for you has been released. Please pick a time again." });
  }

  function handleSlotTaken(slot: TimeSlot) {
    setSlots((current) => current.filter((entry) => entry.id !== slot.id));
    // Ask again for what the screen shows, so other times taken meanwhile disappear too.
    coverage.current = [];
    setCoverageVersion((current) => current + 1);
    backToTime({ kind: "taken", message: "Someone just took that time. Please pick another." });
  }

  // The hold follows the chosen time: asked for once the customer has picked (and again if they come back to the
  // time screen), let go when the time is cleared or they go back before the time screen.
  const timeStepIndex = steps.indexOf("time");
  const holdingSlot = formState.slot;
  const reachedTime = timeStepIndex >= 0 && stepIndex >= timeStepIndex;
  useEffect(() => {
    const current = slotHoldLatest.current;
    // The booking waiting for payment owns the time now (its hold is the payment hold).
    if (success || pendingPayment) return;
    if (!holdingSlot || !reachedTime) {
      current.release();
      return;
    }
    if (current.hold?.slotId === holdingSlot.id) return;
    const slot = holdingSlot;
    void current.request(slot, { locationId: formState.locationId, serviceId: formState.serviceId }).then((outcome) => {
      if (outcome === "taken") handleSlotTaken(slot);
    });
    // handleSlotTaken only uses state setters and latest refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingSlot?.id, reachedTime, formState.locationId, formState.serviceId, success, pendingPayment]);

  function clearError(field: string) {
    setErrors((current) => {
      if (!current[field]) {
        return current;
      }
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function validateStep(id: BookingStepId): Record<string, string> {
    const nextErrors: Record<string, string> = {};

    if (id === "location" && !formState.locationId) {
      nextErrors.locationId = clinical ? `Choose ${t.aBusiness} ${t.location}.` : `Choose ${t.aLocation}.`;
    }
    if (id === "service" && !formState.serviceId) {
      nextErrors.serviceId = "Choose a service.";
    }
    if (id === "meet" && selectedService) {
      if (meetOptions.length > 1 && !meetKind) nextErrors.locationChoice = "Choose how you would like to meet.";
      if (meetKind === "their_address" && formState.locationDetail.trim().length < 5) {
        nextErrors["locationChoice.detail"] = "Enter the address where we should come.";
      }
    }
    if (id === "provider" && !formState.practitionerId) {
      nextErrors.practitionerId = `Choose ${t.aPractitioner} or anyone available.`;
    }
    if (id === "time" && !formState.slot) {
      nextErrors.slotId = `Choose ${t.anAppointment} time.`;
    }
    if (id === "questions" && bookingForm) {
      const checked = checkQuestions(bookingForm, formState.serviceId, effectiveAnswers, allowGuests);
      if (!checked.ok) {
        for (const [questionId, message] of Object.entries(checked.errors)) nextErrors[`formAnswers.${questionId}`] = message;
      }
    }
    if (id === "details") {
      if (askBookingFor && !formState.bookingFor) {
        nextErrors.bookingFor = `Choose who the ${t.appointment} is for.`;
      }
      const nameProblem = fullNameProblem(formState.firstName, formState.lastName, effectiveBookingFor === "dependent" ? `the ${t.customer}’s` : "your");
      if (nameProblem) nextErrors.firstName = `${nameProblem}.`;
      const email = phoneOnly ? "" : formState.email.trim();
      const phone = formState.phone.trim();
      if (phone && !isPhoneNumber(phone)) {
        nextErrors.phone = "Enter a valid phone number, for example +91 98765 43210.";
      }
      if (email && !isEmailAddress(email)) {
        nextErrors.email = "Enter a valid email address.";
      }
      const contact = contactProblem(intake.contactMode, { email, phone });
      if (contact && !nextErrors[contact.field]) nextErrors[contact.field] = contact.message;
      const guestError = guestsProblem(effectiveGuests, intake, email);
      if (guestError) nextErrors.guests = guestError;
      if (phoneOnly && !formState.messagingConsent) {
        nextErrors.messagingConsent = "Tick this so we can reach you without an email.";
      }
      if (emailCheckBlocked && !nextErrors.email) {
        nextErrors.emailCheck = "Confirm your email with the code we send you.";
      }
      if (features.dateOfBirth && formState.dateOfBirth && (formState.dateOfBirth < "1900-01-01" || formState.dateOfBirth > todayIsoDate())) {
        nextErrors.dateOfBirth = "Enter a real date of birth, or leave it empty.";
      }
      if (!formState.acceptedPrivacyNotice) {
        nextErrors.acceptedPrivacyNotice = "Accept the privacy notice to continue.";
      }
    }

    return nextErrors;
  }

  /** Moves to another screen. `push` adds a history entry; `replace` swaps the current one (Change links, error jumps). */
  function goTo(target: BookingStepId, mode: "push" | "replace", towards: "forward" | "back") {
    clearAdvanceTimer();
    const state = { ...window.history.state, [historyKey]: target };
    if (mode === "push") {
      window.history.pushState(state, "");
      historyStack.current = [...historyStack.current, target];
    } else {
      window.history.replaceState(state, "");
      historyStack.current = [...historyStack.current.slice(0, -1), target];
    }
    setDirection(towards);
    setStepState(target);
  }

  function continueFrom(from: BookingStepId) {
    clearAdvanceTimer();
    const nextErrors = validateStep(from);
    focusSummaryOnErrors.current = true;
    setErrors(nextErrors);
    setSubmissionError("");
    if (Object.keys(nextErrors).length > 0) return;
    const next = nextStep(steps, from);
    if (next) goTo(next, "push", "forward");
  }

  function goBack() {
    const previous = previousStep(steps, step);
    if (!previous) return;
    clearAdvanceTimer();
    setErrors({});
    setSubmissionError("");
    const stack = historyStack.current;
    if (stack.length >= 2 && stack[stack.length - 2] === previous) {
      // The browser's own Back, so the history stays in step; popstate shows the screen.
      window.history.back();
      return;
    }
    goTo(previous, "replace", "back");
  }

  // One change per choice, used by its screen and by the side panel alike.
  function chooseLocation(value: string) {
    setFormState((current) => ({
      ...current,
      locationId: value,
      serviceId: keepService(current.serviceId, { locationId: value }),
      practitionerId: undefined,
      slot: undefined,
    }));
    clearError("locationId");
  }
  function chooseService(value: string) {
    setFormState((current) => ({
      ...current,
      serviceId: value,
      durationMinutes: undefined,
      locationKind: undefined,
      practitionerId: undefined,
      slot: undefined,
    }));
    clearError("serviceId");
  }
  function chooseLength(minutes: number) {
    setFormState((current) => ({ ...current, durationMinutes: minutes, slot: undefined }));
    clearError("durationMinutes");
  }
  function choosePerson(value: string) {
    setFormState((current) => ({ ...current, practitionerId: value, slot: undefined }));
    clearError("practitionerId");
  }

  /**
   * A change made in the side panel can undo a later choice (a new service clears the time). Once it has
   * rendered, the customer is taken back to the first earlier screen that now needs an answer.
   */
  const recheckAfterPanel = useRef(false);
  function fromPanel(change: () => void) {
    recheckAfterPanel.current = true;
    change();
  }

  function changeTo(target: BookingStepId) {
    setErrors({});
    setSubmissionError("");
    if (target === "service") setWantsServiceChange(true);
    if (target === "provider") setKeepLinkedPerson(false);
    goTo(target, "replace", "back");
  }

  // A tap on a choice moves on after a moment; the latest render decides whether it can.
  const continueFromLatest = useRef(continueFrom);
  const stepLatest = useRef(step);
  useEffect(() => {
    continueFromLatest.current = continueFrom;
    stepLatest.current = step;
  });

  useEffect(() => {
    if (!recheckAfterPanel.current) return;
    recheckAfterPanel.current = false;
    const choiceScreens: BookingStepId[] = ["location", "service", "length", "provider", "meet", "time"];
    const firstOpen = steps
      .slice(0, stepIndex)
      .find((id) => choiceScreens.includes(id) && Object.keys(validateStep(id)).length > 0);
    if (firstOpen) goTo(firstOpen, "replace", "back");
  });

  // The customer already confirmed the linked time on the profile page, so the time screen moves on by itself, once.
  const linkedAdvanceDone = useRef(false);
  useEffect(() => {
    if (linkedAdvanceDone.current || !linkedSlotId || formState.slot?.id !== linkedSlotId) return;
    linkedAdvanceDone.current = true;
    if (stepLatest.current === "time") continueFromLatest.current("time");
  }, [formState.slot?.id, linkedSlotId]);

  function scheduleAdvance(from: BookingStepId) {
    clearAdvanceTimer();
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = undefined;
      if (stepLatest.current === from) continueFromLatest.current(from);
    }, tapAdvanceDelayMs);
  }

  // Enter does not choose a radio by itself; a click does, and also re-chooses the one already chosen.
  function onChoiceKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    const onRadio = target.getAttribute("role") === "radio" || (target instanceof HTMLInputElement && target.type === "radio");
    if (onRadio && event.key === "Enter") {
      event.preventDefault();
      target.click();
    }
  }

  /**
   * Any click on an option card moves on: a tap, Enter, Space, or a screen reader's virtual click (detail 0). An
   * arrow key only moves the choice: Base UI clicks the radio's hidden input and stops that click before it reaches
   * the card, so this never runs for it.
   */
  function onPick() {
    scheduleAdvance(step);
  }

  async function submitBooking() {
    clearAdvanceTimer();
    // Hidden screens still need their answer; the location and service are always checked.
    const toCheck = new Set<BookingStepId>([...steps, "location", "service", "meet"]);
    const allErrors = [...toCheck].reduce<Record<string, string>>(
      (combined, id) => ({ ...combined, ...validateStep(id) }),
      {},
    );
    if (
      Object.keys(allErrors).length > 0 ||
      !effectivePatientType ||
      !effectiveBookingFor ||
      !formState.slot ||
      !selectedService
    ) {
      focusSummaryOnErrors.current = true;
      setErrors(allErrors);
      const firstField = Object.keys(allErrors)[0];
      if (firstField) {
        const target = stepForField(firstField, steps);
        if (target !== step) goTo(target, "replace", "back");
      }
      return;
    }

    setIsSubmitting(true);
    setSubmissionError("");
    setErrors({});
    idempotencyKeyRef.current ??= createIdempotencyKey();

    const payload = {
      clinicSlug: clinic.slug,
      patientType: effectivePatientType,
      bookingFor: effectiveBookingFor,
      locationId: formState.locationId,
      serviceId: formState.serviceId,
      practitionerId: formState.slot.practitionerId,
      slotId: formState.slot.id,
      startsAt: formState.slot.startsAt,
      endsAt: formState.slot.endsAt,
      holdToken: slotHold.hold?.slotId === formState.slot.id ? slotHold.hold.token : undefined,
      proposedStarts: proposedSlots.length > 0 ? proposedSlots.map((slot) => slot.startsAt) : undefined,
      firstName: formState.firstName.trim(),
      lastName: formState.lastName.trim(),
      phone: formState.phone.trim(),
      email: phoneOnly ? "" : formState.email.trim(),
      guests: effectiveGuests.length > 0 ? effectiveGuests.map((guest) => guest.trim()) : undefined,
      emailProof: emailCheckRequired ? emailCheck.proof : undefined,
      dateOfBirth: (features.dateOfBirth && formState.dateOfBirth) || undefined,
      reasonForVisit: formState.reasonForVisit.trim() || undefined,
      preferredChannel: usableChannel(formState.preferredChannel, { phone: formState.phone, email: formState.email }, phoneOnly),
      messagingConsent: Boolean(formState.phone.trim()) && formState.messagingConsent,
      accessibilityNeed: formState.accessibilityNeed.trim() || undefined,
      acceptedPrivacyNotice: true as const,
      // Sent only for a service that takes payment online (the words the customer saw are stored by the server).
      ...(selectedService.payment ? { acceptedPaymentPolicy: true as const } : {}),
      // Only the code goes; the server prices the booking again and answers with what is due.
      ...(appliedCode && appliedCode.serviceId === selectedService.id ? { couponCode: appliedCode.code } : {}),
      formAnswers: bookingForm ? answersToSend(bookingForm, effectiveAnswers, allowGuests) : undefined,
      locationChoice:
        sendsLocationChoice && meetKind
          ? { kind: meetKind, ...(meetKind === "their_address" ? { detail: formState.locationDetail.trim() } : {}) }
          : undefined,
      origin: { ...origin, channel: origin?.channel ?? "hosted", referrerHost: origin?.referrerHost ?? referringHost() },
      ...(linkContext?.kind === "special" ? { specialLinkToken: linkContext.token } : {}),
      ...(linkContext?.kind === "combined" ? { combinedLink: linkContext.slug } : {}),
      ...(linkContext?.kind === "routing" ? { routingToken: linkContext.token } : {}),
      [bookingBotFieldNames.honeypot]: honeypotRef.current?.value || undefined,
      [bookingBotFieldNames.fillMs]: openedAtRef.current === null ? undefined : Math.max(0, Date.now() - openedAtRef.current),
    };

    try {
      const response = await fetch("/api/public/appointments", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
          ...bot.headers(),
        },
        body: JSON.stringify(payload),
      });
      const responsePayload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const apiError = apiErrorFromPayload(responsePayload);
        // The server asks for the person check (a repeat booking from this network): show it above the button.
        if (bot.afterResponse(apiError?.code, apiError?.fieldErrors?.turnstileToken?.[0])) return;
        // The proof is used up or too old: the customer confirms the email again. Nothing else clears it.
        if (apiError?.code === "email_not_verified") {
          emitEmbedEvent("failed", { serviceId: formState.serviceId, reason: "verification" });
          emailCheck.reset("Your email check no longer counts. Ask for a new code.");
          focusSummaryOnErrors.current = true;
          setErrors({ emailCheck: "Confirm your email again with a new code." });
          return;
        }
        if (response.status === 409 && apiError?.code === "slot_unavailable") {
          emitEmbedEvent("failed", { serviceId: formState.serviceId, reason: "slot_taken" });
          setSlots((current) =>
            current.filter((slot) => slot.id !== formState.slot?.id),
          );
          setFormState((current) => ({ ...current, slot: undefined }));
          goTo("time", "replace", "back");
          setSubmissionError(
            apiError.message || "That time was just booked. Please choose another.",
          );
          return;
        }

        if (apiError?.fieldErrors) {
          emitEmbedEvent("failed", { serviceId: formState.serviceId, reason: "validation" });
          const fieldErrors = Object.fromEntries(
            Object.entries(apiError.fieldErrors).map(([field, messages]) => [
              field,
              messages[0] ?? "Check this field.",
            ]),
          );
          focusSummaryOnErrors.current = true;
          setErrors(fieldErrors);
          const target = stepForField(Object.keys(fieldErrors)[0] ?? "firstName", steps);
          if (target !== step) goTo(target, "replace", "back");
          return;
        }

        emitEmbedEvent("failed", { serviceId: formState.serviceId, reason: response.status === 429 ? "rate_limited" : "unknown" });
        throw new Error(apiError?.message ?? `The ${t.appointment} could not be submitted.`);
      }

      const created = (responsePayload as { data?: { status?: unknown; payment?: PendingPaymentBooking["payment"]; appointmentId?: unknown; manageToken?: unknown; startsAt?: unknown; endsAt?: unknown; practitionerId?: unknown } } | undefined)?.data;
      if (created?.status === "pending_payment") {
        if (
          !created.payment ||
          typeof created.appointmentId !== "string" ||
          typeof created.manageToken !== "string" ||
          typeof created.startsAt !== "string" ||
          typeof created.endsAt !== "string"
        ) {
          throw new Error("The booking response was incomplete.");
        }
        bot.afterResponse(undefined);
        // The booking took the held time over; the payment hold now keeps it for ten minutes.
        slotHold.forget();
        setPendingPayment({
          booking: {
            appointmentId: created.appointmentId,
            manageToken: created.manageToken,
            startsAt: created.startsAt,
            endsAt: created.endsAt,
            ...(typeof created.practitionerId === "string" ? { practitionerId: created.practitionerId } : {}),
            payment: created.payment,
          },
          stage: "pay",
        });
        return;
      }

      const data = (
        responsePayload as
          | {
              data?: Omit<BookingSuccess, "previewMode">;
            }
          | undefined
      )?.data;
      if (
        !data ||
        typeof data.appointmentId !== "string" ||
        typeof data.manageToken !== "string" ||
        (data.status !== "requested" && data.status !== "booked") ||
        typeof data.startsAt !== "string" ||
        typeof data.endsAt !== "string"
      ) {
        throw new Error("The booking response was incomplete.");
      }

      bot.afterResponse(undefined);
      // The booking took the held time over, so there is nothing left to release.
      slotHold.forget();
      setSuccess({ ...data, previewMode: allowDemoFallback });
      window.dispatchEvent(
        new CustomEvent("kalendr:booking-completed", {
          detail: { appointmentReference: data.appointmentId },
        }),
      );
    } catch (error) {
      if (allowDemoFallback && isNetworkError(error)) {
        setSuccess({
          appointmentId: "preview-appointment",
          manageToken: "demo-booking",
          status: selectedService.bookingMode === "instant" ? "booked" : "requested",
          startsAt: formState.slot.startsAt,
          endsAt: formState.slot.endsAt,
          previewMode: true,
        });
        return;
      }

      if (isNetworkError(error)) emitEmbedEvent("failed", { serviceId: formState.serviceId, reason: "network" });
      setSubmissionError(
        error instanceof Error
          ? error.message
          : `The ${t.appointment} could not be submitted.`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // The time being held stays in the list even when a fresh answer leaves it out (the server hides held times from everyone).
  const pickerSlots = useMemo(
    () => (formState.slot && !slots.some((slot) => slot.id === formState.slot?.id) ? [...slots, formState.slot] : slots),
    [formState.slot, slots],
  );
  const slotsAreDemo = isPreviewAvailability;
  const mayAskForOtherTimes = mayNeedApproval(selectedService?.approval?.rule ?? "never");
  const proposalOptions = useMemo(
    () => (mayAskForOtherTimes ? proposableSlots(pickerSlots, formState.slot) : []),
    [mayAskForOtherTimes, pickerSlots, formState.slot],
  );
  const proposalScope = `${formState.serviceId}|${formState.durationMinutes ?? ""}|${formState.slot?.practitionerId ?? ""}|${formState.slot?.id ?? ""}`;
  const proposedSlots = proposed.scope === proposalScope
    ? proposalOptions.filter((slot) => proposed.ids.includes(slot.id)).slice(0, MAX_PROPOSED_TIMES)
    : [];
  const slotPerson = practitioners.find((practitioner) => practitioner.id === (success?.practitionerId ?? formState.slot?.practitionerId));
  const chosenPerson = practitioners.find((practitioner) => practitioner.id === formState.practitionerId);

  if (pendingPayment && !success) {
    const { booking, stage } = pendingPayment;
    const payInput = { clinicSlug: clinic.slug, manageToken: booking.manageToken };
    if (stage === "confirming") {
      return (
        <ConfirmingPayment
          check={paymentStatusCheck(payInput)}
          manageHref={`/manage/${encodeURIComponent(booking.manageToken)}`}
          onConfirmed={(outcome) => {
            const status = outcome.appointmentStatus === "requested" ? "requested" : "booked";
            setSuccess({ appointmentId: booking.appointmentId, manageToken: booking.manageToken, status, startsAt: booking.startsAt, endsAt: booking.endsAt, practitionerId: booking.practitionerId, previewMode: false });
            window.dispatchEvent(new CustomEvent("kalendr:booking-completed", { detail: { appointmentReference: booking.appointmentId } }));
          }}
        />
      );
    }
    return (
      <PayStep
        dueNowMinor={booking.payment.dueNowMinor}
        dueLaterMinor={selectedService?.payment?.dueLaterMinor ?? null}
        currency={booking.payment.currency}
        expiresAt={booking.payment.expiresAt}
        start={() => startPayment(payInput)}
        onConfirming={() => setPendingPayment({ booking, stage: "confirming" })}
        onExpired={() => undefined}
        expiredAction={{
          label: "Pick another time",
          onClick: () => {
            // A new booking is a new try: it must not replay the answer that was saved for the old key.
            idempotencyKeyRef.current = undefined;
            setPendingPayment(undefined);
            backToTime({ kind: "expired", message: "Your held time was let go. Pick another time." });
          },
        }}
        details={
          selectedService && formState.slot ? (
            <p className="text-sm">
              <span className="font-medium">{selectedService.name}</span>
              {" · "}
              {formatLongDate(formState.slot.startsAt, clinic.locale, display.zone)} at {formatClock(formState.slot.startsAt, clinic.locale, display.zone, display.hour12)}
            </p>
          ) : null
        }
      />
    );
  }

  if (success && selectedLocation && selectedService) {
    return (
      <BookingConfirmation
        success={success}
        clinic={clinic}
        location={selectedLocation}
        service={selectedService}
        personName={slotPerson?.name}
        durationMinutes={durationMinutes}
        meeting={sendsLocationChoice && meetKind ? { kind: meetKind, detail: formState.locationDetail.trim() } : undefined}
        preferredChannel={formState.preferredChannel}
        embedded={Boolean(origin && origin.channel !== "hosted")}
      />
    );
  }

  const personLabel =
    slotPerson?.name ??
    pinnedPerson?.name ??
    (providerShown ? chosenPerson?.name ?? (formState.practitionerId === "first_available" ? "Anyone available" : undefined) : undefined);
  const personShown = slotPerson ?? pinnedPerson ?? (providerShown ? chosenPerson : undefined);
  const summaryLines: PanelLine[] = [];
  if (selectedService) {
    summaryLines.push({
      id: "service",
      icon: ClipboardList,
      label: t.Service,
      value: selectedService.name,
      meta: hasLengths && chosen ? [getDurationLabel(chosen.minutes), lengthPrice(chosen, selectedService, false)].filter(Boolean).join(" · ") : serviceMeta(selectedService),
      changeable: steps.includes("service") || Boolean(validInitialServiceId),
      ...(steps.includes("service")
        ? {
            choices: availableServices.map((service) => ({ value: service.id, label: service.name })),
            choice: selectedService.id,
            onChoose: (value: string) => fromPanel(() => chooseService(value)),
          }
        : {}),
    });
    if (hasLengths && chosen) {
      summaryLines.push({
        id: "length",
        icon: Clock3,
        label: "Length",
        value: getDurationLabel(chosen.minutes),
        changeable: true,
        choices: lengths.map((length) => ({ value: String(length.minutes), label: getDurationLabel(length.minutes) })),
        choice: String(chosen.minutes),
        onChoose: (value: string) => fromPanel(() => chooseLength(Number(value))),
      });
    }
  }
  if (personLabel) {
    summaryLines.push({
      id: "person",
      icon: UserRound,
      label: t.Practitioner,
      value: personLabel,
      ...(personShown ? { person: { name: personShown.name, photoUrl: personShown.photoUrl } } : {}),
      // Someone chosen on their profile can still be swapped when others offer this too.
      changeable: providerShown || (Boolean(pinnedPerson) && eligiblePeopleCount > 1),
      ...(providerShown && formState.practitionerId
        ? {
            choices: [
              { value: "first_available", label: "Anyone available" },
              ...availablePractitioners.map((person) => ({ value: person.id, label: person.name })),
            ],
            choice: formState.practitionerId,
            onChoose: (value: string) => fromPanel(() => choosePerson(value)),
          }
        : {}),
    });
  }
  if (formState.slot) {
    summaryLines.push({
      id: "time",
      icon: CalendarDays,
      label: "Time",
      value: `${formatLongDate(formState.slot.startsAt, clinic.locale, display.zone)} at ${formatClock(formState.slot.startsAt, clinic.locale, display.zone, display.hour12)}`,
      numeric: true,
      changeable: true,
    });
  }
  if (selectedLocation) {
    summaryLines.push({
      id: "location",
      icon: MapPin,
      label: t.Location,
      value: selectedLocation.name,
      meta: selectedLocation.city,
      changeable: steps.includes("location"),
      ...(steps.includes("location")
        ? {
            choices: locationChoices.map((location) => ({ value: location.id, label: location.name })),
            choice: selectedLocation.id,
            onChoose: (value: string) => fromPanel(() => chooseLocation(value)),
          }
        : {}),
    });
  }
  if (sendsLocationChoice && meetKind && meetKind !== "in_person") {
    summaryLines.push({
      id: "meet",
      icon: Video,
      label: "How",
      value: meetLabel(meetKind),
      changeable: meetAsked,
    });
  }
  if (allowGuests && effectiveGuests.length > 0) {
    summaryLines.push({
      id: "guests",
      icon: Users,
      label: "Guests",
      value: `${effectiveGuests.length} ${effectiveGuests.length === 1 ? "guest" : "guests"}`,
      meta: effectiveGuests.join(", "),
    });
  }
  // What is still to choose, greyed in the panel.
  const summaryUpcoming: PanelUpcoming[] = [];
  if (steps.includes("location") && !selectedLocation) summaryUpcoming.push({ id: "location", icon: MapPin, label: t.Location });
  if (!selectedService) summaryUpcoming.push({ id: "service", icon: ClipboardList, label: t.Service });
  if (providerShown && !personLabel) summaryUpcoming.push({ id: "person", icon: UserRound, label: t.Practitioner });
  if (!formState.slot) summaryUpcoming.push({ id: "time", icon: CalendarDays, label: "Time" });
  const summaryTitle = `Your ${t.appointment}`;
  const summaryStepFor: Record<string, BookingStepId> = { service: "service", length: "length", person: "provider", time: "time", location: "location", meet: "meet" };
  const changeSummaryLine = (id: string) => changeTo(summaryStepFor[id]);
  const isRequestMode = selectedService?.bookingMode === "request";
  // A service that takes payment needs the policy agreed before the Confirm button works.
  const policyBlocked = Boolean(selectedService?.payment) && agreedPolicyFor !== selectedService?.id;

  function updateDetails<Field extends keyof DetailsValues>(field: Field, value: DetailsValues[Field]) {
    setFormState((current) => ({ ...current, [field]: value }));
    clearError(field);
  }

  // Only the questions and details screens keep a button at the bottom; every other screen moves on when a choice is made.
  // The one exception is a visit at the customer's address, which waits for the address to be typed.
  const hasBottomAction = step === "questions" || step === "details" || (step === "meet" && meetKind === "their_address");

  let screen;
  switch (step) {
    case "location":
      screen = (
        <LocationStep
          locations={locationChoices}
          value={formState.locationId}
          error={errors.locationId}
          onPick={onPick}
          onChange={chooseLocation}
        />
      );
      break;
    case "service":
      screen = (
        <ServiceStep
          services={availableServices}
          value={formState.serviceId}
          error={errors.serviceId}
          emptyMessage={`No online services match this ${t.location}. Call the ${t.business} for help.`}
          onPick={onPick}
          onChange={chooseService}
        />
      );
      break;
    case "length":
      screen = selectedService && chosen ? (
        <LengthStep
          service={selectedService}
          value={chosen.minutes}
          error={errors.durationMinutes}
          onPick={onPick}
          onChange={chooseLength}
        />
      ) : null;
      break;
    case "meet":
      screen = (
        <MeetStep
          options={meetOptions}
          location={selectedLocation}
          kind={meetKind}
          detail={formState.locationDetail}
          errors={{ kind: errors.locationChoice, detail: errors["locationChoice.detail"] }}
          onPick={onPick}
          onSubmit={() => continueFrom("meet")}
          onKindChange={(kind) => {
            setFormState((current) => ({ ...current, locationKind: kind }));
            clearError("locationChoice");
          }}
          onDetailChange={(detail) => {
            setFormState((current) => ({ ...current, locationDetail: detail }));
            clearError("locationChoice.detail");
          }}
        />
      );
      break;
    case "provider":
      screen = (
        <ProviderStep
          people={availablePractitioners}
          value={formState.practitionerId}
          error={errors.practitionerId}
          onPick={onPick}
          nextFree={nextFreeProp}
          onChange={choosePerson}
        />
      );
      break;
    case "time":
      screen = (
        <TimeStep
          slots={pickerSlots}
          awayNotices={awayNotices}
          fullDays={fullDays}
          isLoading={isLoadingSlots}
          loadError={slotLoadError}
          onRetry={() => setAvailabilityAttempt((current) => current + 1)}
          isPreview={isPreviewAvailability}
          practitioners={practitioners}
          selectedSlotId={formState.slot?.id}
          showPractitioner={false}
          error={errors.slotId}
          emptyMessage={
            providerShown
              ? `Choose another ${t.practitioner} or call ${clinic.name} at ${clinic.phone}.`
              : `Call ${clinic.name} at ${clinic.phone} to find a time.`
          }
          locale={clinic.locale}
          timeZone={timeZone}
          display={display}
          onViewRange={slotsAreDemo ? undefined : loadRange}
          isFetchingRange={isFetchingRange}
          rangeError={rangeError}
          onRetryRange={() => lastWantedRange.current && loadRange(lastWantedRange.current)}
          holdNotice={holdNotice}
          waitlist={!isPreviewAvailability && selectedService && selectedLocation && availablePractitioners.length > 0 ? <JoinWaitlist clinic={clinic} service={selectedService} location={selectedLocation} people={availablePractitioners} turnstileSiteKey={turnstileSiteKey} /> : undefined}
          onSelect={(slot) => {
            setFormState((current) => ({ ...current, slot }));
            clearError("slotId");
            setSubmissionError("");
            setHoldNotice(undefined);
          }}
          onTimePicked={() => scheduleAdvance("time")}
          initialDate={validInitialDate}
          settingsInPanel
        />
      );
      break;
    case "questions":
      screen = bookingForm ? (
        <QuestionsStep
          form={bookingForm}
          serviceId={formState.serviceId}
          answers={effectiveAnswers}
          locked={formPrefill.locked}
          allowGuests={allowGuests}
          errors={errors}
          declined={declinedQuestions}
          onDeclinedChange={(questionId, isDeclined) =>
            setDeclinedQuestions((current) => (isDeclined ? (current.includes(questionId) ? current : [...current, questionId]) : current.filter((id) => id !== questionId)))
          }
          onAnswer={(questionId, value) => {
            setFormAnswers((current) => {
              // Questions that hide because of this answer lose theirs, so a hidden answer is never sent.
              const pruned = pruneAnswers(bookingForm.fields, setAnswer({ ...current, ...formPrefill.forced }, questionId, value));
              for (const id of Object.keys(formPrefill.forced)) delete pruned[id];
              return pruned;
            });
            clearError(`formAnswers.${questionId}`);
          }}
        />
      ) : null;
      break;
    case "details":
      screen = (
        <DetailsStep
          values={formState}
          errors={errors}
          onChange={updateDetails}
          askBookingFor={askBookingFor}
          askDateOfBirth={features.dateOfBirth}
          businessName={clinic.name}
          clinical={clinical}
          description={isRequestMode ? `${clinic.name} confirms the time after you send this request.` : undefined}
          phoneHint={meetKind === "we_call" ? "We call you on this number at your time." : undefined}
          intake={intake}
          guests={effectiveGuests}
          onGuestsChange={(next) => {
            setGuests(next);
            clearError("guests");
          }}
          emailLocked={emailLocked}
          emailCheck={
            emailCheckRequired && !emailCheck.notRequired && isEmailAddress(formState.email) ? (
              <EmailCheckBlock email={formState.email} check={emailCheck} />
            ) : undefined
          }
        />
      );
      break;
  }

  const panelProps = {
    business: { name: clinic.name, phone: clinic.phone, logoUrl: clinic.logoUrl },
    title: summaryTitle,
    lines: summaryLines,
    upcoming: summaryUpcoming,
    imageUrl: selectedService?.imageUrl ?? undefined,
    onChange: changeSummaryLine,
    display: step === "time" || formState.slot ? display : undefined,
    details: {
      firstName: formState.firstName,
      lastName: formState.lastName,
      phone: formState.phone,
      email: formState.email,
      phoneOnly,
      emailLocked,
      editable: step !== "details",
      onNamesChange: ({ firstName, lastName }: { firstName: string; lastName: string }) => {
        if (firstName !== formState.firstName) updateDetails("firstName", firstName);
        if (lastName !== formState.lastName) updateDetails("lastName", lastName);
      },
      onPhoneChange: (phone: string) => updateDetails("phone", phone),
      onEmailChange: (email: string) => updateDetails("email", email),
    },
  };

  // The chosen service's own banner takes the place of the business cover once a service is chosen.
  const bannerUrl = selectedService?.bannerUrl ?? undefined;
  const coverUrl = bannerUrl ?? (stepIndex === 0 ? clinic.coverUrl : undefined);

  const stepBack = stepIndex > 0 ? { onBack: goBack, disabled: isSubmitting, inTopRow: !isWide } : undefined;
  const bottomAction = !hasBottomAction ? null : step === "details" ? (
    <Button size="lg" loading={isSubmitting} disabled={botCheckWaiting || emailCheckBlocked || policyBlocked} aria-describedby={emailCheckBlocked ? "booking-blocked" : policyBlocked ? "payment-policy-text" : undefined} onClick={() => void submitBooking()}>
      {isRequestMode ? "Send request" : "Confirm booking"}
    </Button>
  ) : (
    <Button size="lg" onClick={() => continueFrom(step)}>
      Continue
      <ArrowRight aria-hidden="true" />
    </Button>
  );
  // On a phone the main button joins the "Your appointment" bar at the bottom: tap the bar to see the booking, the
  // button to move on.
  const actionInPanelBar = isPhone && bottomAction !== null;

  return (
    <MotionConfig reducedMotion="user">
    <div className="mx-auto grid w-full max-w-3xl gap-6 max-lg:my-auto lg:max-w-none lg:flex-1 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
      {/* Below 1024px the floating panel bar (and, on a phone, the screen's own bottom bar) must not cover the last content. */}
      <div className={cn("flex min-w-0 flex-col gap-5 max-lg:pb-20", hasBottomAction && "max-md:pb-40")}>
        {coverUrl ? (
          <div className="relative aspect-[5/2] max-h-32 w-full overflow-hidden rounded-xl bg-muted md:aspect-[4/1] md:max-h-none">
            <Image src={coverUrl} alt="" fill unoptimized priority sizes="(min-width: 1024px) 720px, 100vw" className="object-cover" />
          </div>
        ) : null}

        {/* The page has no top bar, so below 1024px one row shows Back, who this booking is with and Call; from 1024px the
            side panel carries the business and Back sits beside the screen's title. */}
        <div className="flex min-h-9 min-w-0 items-center gap-2 lg:hidden">
          {isWide ? null : (
            <StepBackContext.Provider value={stepBack}>
              <StepBackButton />
            </StepBackContext.Provider>
          )}
          <BusinessLogo name={clinic.name} logoUrl={clinic.logoUrl} className="size-8" />
          <BusinessLine name={clinic.name} phone={clinic.phone} className="flex-1" />
        </div>

        {submissionError ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>
              {step === "time" ? "Please choose another time" : "We could not finish the booking"}
            </AlertTitle>
            <AlertDescription>{submissionError}</AlertDescription>
          </Alert>
        ) : null}
        <ErrorSummary
          errors={errors}
          summaryRef={errorSummaryRef}
          labels={Object.fromEntries((bookingForm?.fields ?? []).map((field) => [`formAnswers.${field.id}`, field.label]))}
        />

        {formState.slot && reachedTime ? (
          <HoldStatus remainingSeconds={slotHold.remainingSeconds} pending={slotHold.pending} held={Boolean(slotHold.hold)} />
        ) : null}

        <motion.div
          key={step}
          ref={stepContainerRef}
          onKeyDown={onChoiceKeyDown}
          className="min-w-0"
          // The first screen paints at once; each next screen glides in from the side the customer is heading.
          initial={direction === "none" ? false : { opacity: 0, x: direction === "forward" ? 28 : -28 }}
          animate={{ opacity: 1, x: 0 }}
          transition={calm}
        >
          <StepBackContext.Provider value={stepBack}>{screen}</StepBackContext.Provider>
        </motion.div>

        {step === "details" && proposalOptions.length > 0 ? (
          <ProposedTimes
            options={proposalOptions}
            selectedIds={proposedSlots.map((slot) => slot.id)}
            onChange={(ids) => setProposed({ scope: proposalScope, ids })}
            locale={clinic.locale}
            zone={display.zone}
            hour12={display.hour12}
          />
        ) : null}

        {/* Left empty by people (it is hidden from sight and from screen readers); bots that fill every field fill it. */}
        <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden opacity-0">
          <label htmlFor="booking-company-website">Company website</label>
          <input
            ref={honeypotRef}
            id="booking-company-website"
            name={bookingBotFieldNames.honeypot}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>

        {step === "details" && bot.shown && turnstileSiteKey ? (
          <TurnstileField key={bot.round} siteKey={turnstileSiteKey} action="booking" onToken={bot.onToken} error={bot.error} />
        ) : null}

        {step === "details" && selectedService && !allowDemoFallback && (selectedService.priceMinor ?? 0) > 0 ? (
          <PublicCodeField clinicSlug={clinic.slug} serviceId={selectedService.id} applied={appliedCode} onApplied={setAppliedCode} serverError={errors.couponCode} />
        ) : null}

        {step === "details" && selectedService?.payment ? (
          <PaymentPolicyCard
            payment={selectedService.payment}
            agreed={agreedPolicyFor === selectedService.id}
            onAgreedChange={(agreed) => setAgreedPolicyFor(agreed ? selectedService.id : undefined)}
          />
        ) : null}

        {step === "details" && emailCheckBlocked ? (
          <p id="booking-blocked" className="text-muted-foreground text-sm max-md:text-center md:text-end">
            {isEmailAddress(formState.email)
              ? "Confirm your email with the code we send you, then you can book."
              : "Enter a valid email address, then confirm it with a code, to book."}
          </p>
        ) : null}

        {bottomAction && !actionInPanelBar ? <BookingBottomBar>{bottomAction}</BookingBottomBar> : null}
      </div>

      <BookingPanel {...panelProps} />
      <BookingPanelBar {...panelProps} action={actionInPanelBar ? bottomAction : undefined} />
    </div>
    </MotionConfig>
  );
}
