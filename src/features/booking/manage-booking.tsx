"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Accessibility,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock3,
  EllipsisVertical,
  FileCheck2,
  MapPin,
  RefreshCw,
  TriangleAlert,
  UserRound,
  WifiOff,
  CalendarClock,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { TextareaField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Form } from "@/components/ui/form";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { Appointment, TimeSlot } from "@/lib/domain";
import { cn } from "@/lib/utils";
import type { TermWords } from "@/lib/terminology";

import { useBusinessProfile, useTerms } from "../terms/business-profile-context";
import { ManagePendingPayment } from "./manage-payment";

import {
  formatDateTime,
  formatTimeZoneName,
  getDurationLabel,
  phoneHref,
  withServiceDuration,
} from "./booking-format";
import type {
  ManageAction,
  ManageActionResult,
  ManageBookingSnapshot,
  PublicApiError,
} from "./booking-types";
import { BookingBottomBar } from "./booking-bottom-bar";
import { AddToCalendarMenu } from "./add-to-calendar-menu";
import { BookingDetailRow } from "./booking-confirmation";
import { ApprovalStatusCard, hiddenAddressNote } from "./manage-approval";
import { JoinVideoLink } from "../video/join-video-link";
import { CheckInCard } from "./check-in-card";
import { ReviewCard } from "./review-card";
import { BookingSummaryCard, BookingSummaryLine, type SummaryLine } from "./booking-summary";
import { CancelDialog, GuestsCard, PolicyBlockedNotice, RescheduleRequestBanner, noteHint } from "./manage-policy";
import { MAX_NOTE_LENGTH, type CustomerCancelReason } from "@/lib/cancel-policy";
import { SlotPicker } from "./slot-picker";
import { StepHeader } from "./steps/step-header";
import { ChangeContactDialog } from "./change-contact-dialog";
import { ManageLinkExpired } from "./manage-link-expired";
import type { StepUpAction } from "./manage-step-up";
import { StepUpDialog } from "./step-up-dialog";

interface ManageBookingProps {
  token: string;
  initialSnapshot?: ManageBookingSnapshot;
  fallbackSlots: TimeSlot[];
  allowDemoFallback?: boolean;
  /** Where this booking is read and changed. Defaults to the private-link route for the token. */
  apiPath?: string;
}

class PublicRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "PublicRequestError";
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function getApiError(payload: unknown): PublicApiError | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as Partial<PublicApiError>;
  return typeof candidate.code === "string" && typeof candidate.message === "string"
    ? (candidate as PublicApiError)
    : undefined;
}

function statusPresentation(status: Appointment["status"], t: TermWords): {
  label: string;
  tone: "success" | "attention" | "neutral" | "danger" | "info";
  heading: string;
} {
  switch (status) {
    case "requested":
      return {
        label: `Awaiting ${t.business} approval`,
        tone: "attention",
        heading: `Your ${t.appointment} request`,
      };
    case "booked":
      return { label: "Booked", tone: "success", heading: `Your ${t.appointment}` };
    case "checked_in":
      return { label: "Checked in", tone: "info", heading: "You are checked in" };
    case "completed":
      return { label: "Completed", tone: "neutral", heading: `${t.Appointment} completed` };
    case "cancelled":
      return { label: "Cancelled", tone: "danger", heading: `${t.Appointment} cancelled` };
    case "no_show":
      return { label: "Missed", tone: "danger", heading: `${t.Appointment} marked missed` };
    case "reschedule_requested":
      return { label: "Pick a new time", tone: "attention", heading: `Choose a new time for your ${t.appointment}` };
    case "declined":
      return { label: "Not accepted", tone: "danger", heading: `Your ${t.appointment} request was declined` };
    case "pending_payment":
      return { label: "Awaiting payment", tone: "attention", heading: `Finish paying to confirm your ${t.appointment}` };
    case "expired":
      // A request nobody answered, or a payment hold that ran out: both end without a booking.
      return { label: "Not confirmed", tone: "danger", heading: `Your ${t.appointment} was not confirmed` };
    case "entered_in_error":
      return {
        label: "Unavailable",
        tone: "neutral",
        heading: `${t.Appointment} unavailable`,
      };
  }
}

export function ManageBooking({
  token,
  initialSnapshot,
  fallbackSlots,
  allowDemoFallback = false,
  apiPath,
}: ManageBookingProps) {
  // A reschedule gives the booking a new link; later calls go to it without reloading the page.
  const [liveToken, setLiveToken] = useState(token);
  const bookingApi = apiPath ?? `/api/public/appointments/${encodeURIComponent(liveToken)}`;
  const bookingApiRef = useRef(bookingApi);
  const [stepUp, setStepUp] = useState<{ action: StepUpAction; retry: () => Promise<void> } | null>(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [linkExpired, setLinkExpired] = useState(false);
  const t = useTerms();
  const wantsReschedule = useSearchParams()?.get("reschedule") === "1";
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [isLoading, setIsLoading] = useState(!initialSnapshot);
  const [loadError, setLoadError] = useState("");
  const [linkIsDead, setLinkIsDead] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const opensOnPicker = (candidate?: ManageBookingSnapshot) =>
    Boolean(candidate?.canReschedule && (candidate.appointment.status === "reschedule_requested" || wantsReschedule));
  const [activeAction, setActiveAction] = useState<"reschedule" | "cancel" | undefined>(() =>
    opensOnPicker(initialSnapshot) ? "reschedule" : undefined,
  );
  // The picker opened by itself (staff asked for a new time, or the link says so): its times load once.
  const autoOpenRef = useRef<"pending" | "done">(opensOnPicker(initialSnapshot) ? "pending" : "done");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [rescheduleNote, setRescheduleNote] = useState("");
  const [guestError, setGuestError] = useState("");
  const [availableSlots, setAvailableSlots] = useState<TimeSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot>();
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [slotError, setSlotError] = useState("");
  const [timeError, setTimeError] = useState("");
  const [direction, setDirection] = useState<"none" | "forward" | "back">("none");
  // When the page opened, so the check-in code stops showing once the appointment is over.
  const [openedAt] = useState(() => Date.now());
  const opened = useRef(false);
  // Back from a hosted checkout the address ends in ?paid=1 (read after hydration, so the server HTML matches).
  const paidReturn = useSyncExternalStore(
    () => () => undefined,
    () => new URLSearchParams(window.location.search).get("paid") === "1",
    () => false,
  );
  const screenRef = useRef<HTMLDivElement>(null);
  const shownScreenRef = useRef<"details" | "reschedule">("details");
  const screen = activeAction === "reschedule" && snapshot?.canReschedule !== false ? "reschedule" : "details";

  // Like the booking flow: after moving between the details and the time picker,
  // focus goes to the new screen's one heading.
  useEffect(() => {
    if (shownScreenRef.current === screen) return;
    shownScreenRef.current = screen;
    screenRef.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [screen]);

  const loadBooking = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(
          bookingApiRef.current,
          {
            signal,
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );
        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const apiError = getApiError(payload);
          throw new PublicRequestError(
            apiError?.message ?? "This booking link could not be opened.",
            response.status,
            apiError?.code,
          );
        }

        const data = (payload as { data?: ManageBookingSnapshot } | undefined)?.data;
        if (
          !data?.appointment ||
          !data.clinic ||
          !data.location ||
          !data.service ||
          !data.practitioner ||
          typeof data.appointment.version !== "number"
        ) {
          throw new Error(`The ${t.appointment} response was incomplete.`);
        }

        setSnapshot(data);
        if (autoOpenRef.current === "done" && !initialSnapshot && opensOnPicker(data) && !opened.current) {
          opened.current = true;
          autoOpenRef.current = "pending";
          setActiveAction("reschedule");
        }
        setLoadError("");
        setIsPreviewMode(false);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        if (allowDemoFallback && initialSnapshot && isNetworkError(error)) {
          setSnapshot(initialSnapshot);
          setIsPreviewMode(true);
          return;
        }

        setSnapshot(undefined);
        setLinkExpired(error instanceof PublicRequestError && error.status === 410 && error.code === "manage_link_expired");
        setLinkIsDead(error instanceof PublicRequestError && (error.status === 404 || error.status === 400));
        setLoadError(
          error instanceof Error ? error.message : "This booking link could not be opened.",
        );
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allowDemoFallback, initialSnapshot, t.appointment],
  );

  useEffect(() => {
    const abortController = new AbortController();
    // Fetching the token-scoped resource is the external synchronization performed by this effect.
    void loadBooking(abortController.signal);
    return () => abortController.abort();
  }, [loadBooking]);

  const demoRescheduleSlots = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return fallbackSlots
      .filter((slot) => snapshot.manage?.sameStaffOnly === false || slot.practitionerId === snapshot.practitioner.id)
      .map((slot) => ({
        ...slot,
        endsAt: withServiceDuration(slot.startsAt, snapshot.service.durationMinutes),
      }));
  }, [fallbackSlots, snapshot]);

  const loadRescheduleSlots = useCallback(async () => {
    if (!snapshot) {
      return;
    }

    const query = new URLSearchParams({
      clinicSlug: snapshot.clinic.slug,
      locationId: snapshot.location.id,
      serviceId: snapshot.service.id,
      // Anyone who can take the visit, when the business lets customers move to another person.
      practitionerId: snapshot.manage?.sameStaffOnly === false ? "first_available" : snapshot.practitioner.id,
      // A visit moves with the length it was booked for, even if the service has other lengths now.
      durationMinutes: String(Math.max(5, Math.round((new Date(snapshot.appointment.endsAt).getTime() - new Date(snapshot.appointment.startsAt).getTime()) / 60_000))),
      keepLength: "1",
    });
    setIsLoadingSlots(true);
    setSlotError("");

    try {
      const response = await fetch(`/api/public/availability?${query}`, {
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const apiError = getApiError(payload);
        throw new PublicRequestError(
          apiError?.message ?? "Alternative times could not be loaded.",
          response.status,
          apiError?.code,
        );
      }

      const slots = (payload as { data?: { slots?: TimeSlot[] } } | undefined)?.data
        ?.slots;
      if (!Array.isArray(slots)) {
        throw new Error("The availability response was incomplete.");
      }
      setAvailableSlots(
        slots.filter((slot) => !(slot.startsAt === snapshot.appointment.startsAt && slot.practitionerId === snapshot.practitioner.id)),
      );
    } catch (error) {
      if (allowDemoFallback && isNetworkError(error)) {
        setAvailableSlots(demoRescheduleSlots);
        setIsPreviewMode(true);
        return;
      }
      setAvailableSlots([]);
      setSlotError(
        error instanceof Error ? error.message : "Alternative times could not be loaded.",
      );
    } finally {
      setIsLoadingSlots(false);
    }
  }, [allowDemoFallback, demoRescheduleSlots, snapshot]);

  useEffect(() => {
    if (autoOpenRef.current !== "pending" || activeAction !== "reschedule" || !snapshot) return;
    autoOpenRef.current = "done";
    // The picker opened on its own, so there was no click to start loading its times.
    void loadRescheduleSlots();
  }, [activeAction, loadRescheduleSlots, snapshot]);

  function closeAction() {
    if (activeAction === "reschedule") setDirection("back");
    setActiveAction(undefined);
    setActionError("");
    setTimeError("");
    setSelectedSlot(undefined);
    setRescheduleNote("");
  }

  async function performAction(
    action: ManageAction,
    options?: {
      reasonCode?: CustomerCancelReason;
      note?: string;
      startsAt?: string;
      practitionerId?: string;
      guests?: string[];
      afterCode?: boolean;
    },
  ) {
    if (!snapshot) {
      return;
    }

    setIsSubmitting(true);
    setActionError("");
    setGuestError("");
    setActionMessage("");

    try {
      const response = await fetch(
        bookingApi,
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action,
            reasonCode: options?.reasonCode,
            note: options?.note || undefined,
            startsAt: options?.startsAt,
            practitionerId: options?.practitionerId,
            guests: options?.guests,
            expectedVersion: snapshot.appointment.version,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const apiError = getApiError(payload);
        throw new PublicRequestError(
          apiError?.message ?? `The ${t.appointment} could not be updated.`,
          response.status,
          apiError?.code,
          apiError?.fieldErrors,
        );
      }

      const data = (payload as { data?: ManageActionResult } | undefined)?.data;
      if (
        !data ||
        typeof data.appointmentId !== "string" ||
        typeof data.status !== "string" ||
        typeof data.startsAt !== "string" ||
        typeof data.endsAt !== "string" ||
        typeof data.version !== "number"
      ) {
        throw new Error("The update response was incomplete.");
      }

      const newToken = (data as ManageActionResult & { manageToken?: unknown }).manageToken;
      if (action === "reschedule" && !apiPath && typeof newToken === "string" && newToken) {
        bookingApiRef.current = `/api/public/appointments/${encodeURIComponent(newToken)}`;
        setLiveToken(newToken);
        window.history.replaceState(window.history.state, "", `/manage/${encodeURIComponent(newToken)}`);
      }
      setSnapshot((current) =>
        current
          ? {
              ...current,
              appointment: {
                ...current.appointment,
                status: data.status,
                confirmationStatus:
                  action === "confirm"
                    ? "confirmed"
                    : current.appointment.confirmationStatus,
                startsAt: data.startsAt,
                endsAt: data.endsAt,
                version: data.version,
                ...(action === "reschedule" && options?.practitionerId ? { practitionerId: options.practitionerId } : {}),
              },
              ...(action === "edit_guests" ? { guests: options?.guests ?? [] } : {}),
              // Moved or cancelled: nothing is waiting on the customer any more.
              ...(current.manage && (action === "reschedule" || action === "cancel")
                ? { manage: { ...current.manage, rescheduleRequested: false, rescheduleDeadline: undefined } }
                : {}),
            }
          : current,
      );
      setActionMessage(
        action === "confirm"
          ? "Your attendance is confirmed."
          : action === "cancel"
            ? `The ${t.appointment} has been cancelled.`
            : action === "edit_guests"
              ? "Your guest list is saved."
              : `Your ${t.appointment} has been moved to the new time.`,
      );
      closeAction();
      if (action === "reschedule" && options?.practitionerId && options.practitionerId !== snapshot.practitioner.id) {
        // Another person now has the booking: read it again so their name shows.
        void loadBooking();
      }
    } catch (error) {
      if (allowDemoFallback && isNetworkError(error)) {
        setIsPreviewMode(true);
        setSnapshot((current) => {
          if (!current) {
            return current;
          }
          const nextVersion = current.appointment.version + 1;
          return {
            ...current,
            appointment: {
              ...current.appointment,
              status:
                action === "cancel"
                  ? "cancelled"
                  : action === "confirm"
                    ? "booked"
                    : current.appointment.status,
              confirmationStatus:
                action === "confirm" ? "confirmed" : current.appointment.confirmationStatus,
              startsAt:
                action === "reschedule" && selectedSlot
                  ? selectedSlot.startsAt
                  : current.appointment.startsAt,
              endsAt:
                action === "reschedule" && selectedSlot
                  ? selectedSlot.endsAt
                  : current.appointment.endsAt,
              version: nextVersion,
            },
          };
        });
        setActionMessage(
          action === "confirm"
            ? "Confirmed in preview mode."
            : action === "cancel"
              ? "Cancelled in preview mode."
              : action === "edit_guests"
                ? "Guests saved in preview mode."
                : "Rescheduled in preview mode.",
        );
        closeAction();
        return;
      }

      // Ask for a code only when the server says so, then try the same change once more.
      if (
        error instanceof PublicRequestError &&
        error.code === "step_up_required" &&
        (action === "cancel" || action === "reschedule") &&
        !options?.afterCode
      ) {
        setStepUp({ action, retry: () => performAction(action, { ...options, afterCode: true }) });
        return;
      }
      if (error instanceof PublicRequestError && error.code === "slot_unavailable") {
        setSelectedSlot(undefined);
        setActionError("That time was just taken. Choose another time.");
        await loadRescheduleSlots();
        return;
      }
      if (error instanceof PublicRequestError && error.code === "version_conflict") {
        setActionError(
          `This ${t.appointment} changed in another window. We refreshed the details; review them before trying again.`,
        );
        await loadBooking();
        return;
      }

      if (action === "edit_guests") {
        setGuestError(
          error instanceof PublicRequestError
            ? (error.fieldErrors?.guests?.[0] ?? error.message)
            : `Your guests could not be saved. Try again.`,
        );
        return;
      }
      if (error instanceof PublicRequestError && (error.code === "cancel_not_allowed" || error.code === "reschedule_not_allowed")) {
        // The window closed while the page was open: show the words, then refresh so the buttons match.
        setActionError(error.message);
        await loadBooking();
        return;
      }
      setActionError(
        error instanceof Error ? error.message : `The ${t.appointment} could not be updated.`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading && !snapshot) {
    return (
      <section
        aria-busy="true"
        aria-live="polite"
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21.25rem] lg:items-start lg:gap-8"
      >
        <span className="sr-only">Loading {t.appointment} details</span>
        <div className="flex flex-col gap-5" aria-hidden="true">
          <Skeleton className="h-8 w-56 rounded-lg" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
        <Skeleton className="h-72 rounded-2xl" aria-hidden="true" />
      </section>
    );
  }

  if (!snapshot && linkExpired) return <ManageLinkExpired />;

  if (!snapshot) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="font-semibold">
            <h1>This booking link is unavailable</h1>
          </EmptyTitle>
          <EmptyDescription>
            {loadError || `The link may have expired or the ${t.appointment} may no longer exist.`}
          </EmptyDescription>
        </EmptyHeader>
        {linkIsDead ? null : (
          <EmptyContent>
            <Button
              size="lg"
              onClick={() => {
                setLoadError("");
                setIsLoading(true);
                void loadBooking();
              }}
            >
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  }

  const { appointment, clinic, location, practitioner, service } = snapshot;
  const stepUpDialog = stepUp ? (
    <StepUpDialog
      bookingApi={bookingApi}
      action={stepUp.action}
      onCancel={() => setStepUp(null)}
      onVerified={() => {
        const retry = stepUp.retry;
        setStepUp(null);
        void retry();
      }}
    />
  ) : null;
  const status = statusPresentation(appointment.status, t);
  if (appointment.status === "pending_payment" && !isPreviewMode) {
    return (
      <ManagePendingPayment
        snapshot={snapshot}
        token={token}
        bookingApi={bookingApi}
        paidReturn={paidReturn}
        onSnapshot={setSnapshot}
        reload={() => void loadBooking()}
      />
    );
  }
  const isConfirmed = appointment.confirmationStatus === "confirmed";
  const canTakeAction =
    appointment.status === "booked" || appointment.status === "requested" || appointment.status === "reschedule_requested";
  const manage = snapshot.manage;
  const rescheduleRequested = appointment.status === "reschedule_requested";
  const blockedMessages = [
    ...(!snapshot.canCancel && manage?.cancelBlockedMessage ? [manage.cancelBlockedMessage] : []),
    ...(!snapshot.canReschedule && manage?.rescheduleBlockedMessage ? [manage.rescheduleBlockedMessage] : []),
  ];
  // Names for the picker: the current person, plus anyone else the business lets this booking move to.
  const pickerPeople = [
    practitioner,
    ...(manage?.sameStaffOnly === false
      ? (manage.eligiblePractitioners ?? [])
          .filter((person) => person.id !== practitioner.id)
          .map((person) => ({ ...practitioner, id: person.id, name: person.name, title: "", specialty: "", photoUrl: null }))
      : []),
  ];
  const guestsAllowed = Boolean(manage?.allowGuestEdit && service.intake?.allowGuests && canTakeAction);
  const formLabel =
    appointment.formStatus === "submitted"
      ? "Forms complete"
      : appointment.formStatus === "not_assigned"
        ? "No forms assigned"
        : "Forms still to complete";
  const canAddToCalendar = appointment.status === "booked" || appointment.status === "checked_in";
  const timeZoneName = formatTimeZoneName(location.timezone, clinic.locale);
  const durationLabel = getDurationLabel(service.durationMinutes);

  function openReschedule() {
    setActionError("");
    setActionMessage("");
    setDirection("forward");
    setActiveAction("reschedule");
    if (availableSlots.length === 0) {
      void loadRescheduleSlots();
    }
  }

  const rescheduleLines: SummaryLine[] = [
    {
      id: "current",
      icon: CalendarClock,
      label: "Current time",
      value: formatDateTime(appointment.startsAt, clinic.locale, location.timezone),
      numeric: true,
    },
    ...(selectedSlot
      ? [
          {
            id: "new",
            icon: CalendarDays,
            label: "New time",
            value: formatDateTime(selectedSlot.startsAt, clinic.locale, location.timezone),
            numeric: true,
          },
        ]
      : []),
    { id: "service", icon: ClipboardList, label: t.Service, value: service.name, meta: durationLabel },
    { id: "person", icon: UserRound, label: t.Practitioner, value: practitioner.name },
    { id: "location", icon: MapPin, label: t.Location, value: location.name, meta: location.city },
  ];
  const summaryTitle = `Your ${t.appointment}`;

  const animation = cn(
    "min-w-0",
    direction !== "none" && "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200",
    direction === "forward" && "motion-safe:slide-in-from-right-3",
    direction === "back" && "motion-safe:slide-in-from-left-3",
  );

  if (screen === "reschedule") {
    return (
      <div ref={screenRef} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21.25rem] lg:items-start lg:gap-8">
        <Form
          className="flex min-w-0 flex-col gap-5 max-md:pb-24"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedSlot) {
              setTimeError("Choose a new time before continuing.");
              screenRef.current?.querySelector<HTMLElement>("#reschedule-slots")?.focus();
              return;
            }
            void performAction("reschedule", {
              startsAt: selectedSlot.startsAt,
              note: rescheduleNote.trim() || undefined,
              // Only sent when moving to another person's time.
              practitionerId: selectedSlot.practitionerId !== practitioner.id ? selectedSlot.practitionerId : undefined,
            });
          }}
        >
          <BookingSummaryLine title={summaryTitle} lines={rescheduleLines} imageUrl={service.imageUrl ?? undefined} />

          <div key="reschedule" className={cn(animation, "flex flex-col gap-5")}>
            <StepHeader
              title="Choose a new time"
              description={`Times are in ${timeZoneName}. Your current time stays yours until the new one is saved.`}
              aside={
                isPreviewMode ? (
                  <Badge variant="info">
                    <WifiOff aria-hidden="true" />
                    Preview availability
                  </Badge>
                ) : null
              }
            />
            {rescheduleRequested ? <RescheduleRequestBanner snapshot={snapshot} /> : null}
            {actionError ? <ActionErrorAlert message={actionError} /> : null}
            {isLoadingSlots ? (
              <div aria-live="polite" aria-busy="true" className="flex gap-5 max-md:flex-col">
                <span className="sr-only">Loading other times</span>
                <Skeleton className="h-72 w-full rounded-xl md:w-64" aria-hidden="true" />
                <div className="grid flex-1 grid-cols-3 content-start gap-2" aria-hidden="true">
                  {[0, 1, 2, 3, 4, 5].map((item) => (
                    <Skeleton key={item} className="h-11 rounded-lg" />
                  ))}
                </div>
              </div>
            ) : null}
            {!isLoadingSlots && availableSlots.length > 0 ? (
              <SlotPicker
                id="reschedule-slots"
                name="reschedule-slot"
                slots={availableSlots}
                practitioners={pickerPeople}
                showPractitioner={pickerPeople.length > 1}
                selectedSlotId={selectedSlot?.id}
                onSelect={(slot) => {
                  setSelectedSlot(slot);
                  setActionError("");
                  setTimeError("");
                }}
                locale={clinic.locale}
                timeZone={location.timezone}
                error={timeError}
              />
            ) : null}
            {!isLoadingSlots && slotError ? (
              <Alert variant="error">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Times are unavailable</AlertTitle>
                <AlertDescription>
                  <span>{slotError}</span>
                  <Button variant="outline" className="w-fit" onClick={() => void loadRescheduleSlots()}>
                    Try loading times again
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {!isLoadingSlots && !slotError && availableSlots.length === 0 ? (
              <Empty
                id={timeError ? "reschedule-slots" : undefined}
                tabIndex={timeError ? -1 : undefined}
                className="rounded-xl bg-muted/48 px-4 py-8 outline-none md:py-8"
              >
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarDays aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle className="font-semibold text-base">No other times are open online</EmptyTitle>
                  <EmptyDescription>Call {clinic.name} on {clinic.phone} to find another time.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            <TextareaField
              id="reschedule-note"
              label="Anything we should know?"
              optional
              value={rescheduleNote}
              maxLength={MAX_NOTE_LENGTH}
              hint={noteHint(rescheduleNote)}
              onChange={(event) => setRescheduleNote(event.target.value)}
            />
          </div>

          <BookingBottomBar onBack={closeAction} backDisabled={isSubmitting}>
            <Button type="submit" size="lg" loading={isSubmitting}>
              Move {t.appointment}
            </Button>
          </BookingBottomBar>
        </Form>

        <BookingSummaryCard title={summaryTitle} lines={rescheduleLines} imageUrl={service.imageUrl ?? undefined} />
        {stepUpDialog}
      </div>
    );
  }

  return (
    <div ref={screenRef} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21.25rem] lg:items-start lg:gap-8">
      <div key="details" className={cn(animation, "flex flex-col gap-5")}>
        <StepHeader
          title={status.heading}
          aside={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
          description="Keep this private link. Anyone with it can view the booking. Changing it asks for a code sent to the contact on it."
        />

        {isPreviewMode ? (
          <Alert role={undefined} variant="info">
            <WifiOff aria-hidden="true" />
            <AlertDescription>
              Preview mode: the server is unavailable. Changes shown here are not saved.
            </AlertDescription>
          </Alert>
        ) : null}

        {appointment.clinicMovedFrom ? (
          <Alert role={undefined} variant="info">
            <CalendarClock aria-hidden="true" />
            <AlertTitle>The {t.business} moved this {t.visit}</AlertTitle>
            <AlertDescription>
              Your {t.practitioner}&apos;s hours changed, so this {t.visit} moved from {formatDateTime(appointment.clinicMovedFrom, clinic.locale, location.timezone)}. If the new time doesn&apos;t work, you can change it below.
            </AlertDescription>
          </Alert>
        ) : null}

        <p className="sr-only" aria-live="polite">
          {actionMessage}
        </p>
        {actionMessage ? (
          <Alert role="status" variant="success">
            <CheckCircle2 aria-hidden="true" />
            <AlertTitle>{actionMessage}</AlertTitle>
          </Alert>
        ) : null}
        {actionError && !activeAction ? <ActionErrorAlert message={actionError} /> : null}

        <ApprovalStatusCard snapshot={snapshot} />
        {rescheduleRequested ? <RescheduleRequestBanner snapshot={snapshot} /> : null}

        <Card className="overflow-hidden">
          {service.imageUrl ? (
            <div className="relative aspect-[5/2] w-full overflow-hidden border-b bg-muted">
              <Image
                src={service.imageUrl}
                alt=""
                fill
                unoptimized
                sizes="(min-width: 1024px) 720px, 100vw"
                className="object-cover"
              />
            </div>
          ) : null}
          <CardPanel className="p-5">
            <dl className="flex flex-col gap-3.5">
              <BookingDetailRow icon={CalendarDays} label="Date and time">
                <span className="tabular-nums">
                  {formatDateTime(appointment.startsAt, clinic.locale, location.timezone)}
                </span>
                <span className="block font-normal text-muted-foreground text-xs tabular-nums">
                  {durationLabel} · {timeZoneName}
                </span>
              </BookingDetailRow>
              <BookingDetailRow icon={ClipboardList} label={t.Service}>
                {service.name}
              </BookingDetailRow>
              <BookingDetailRow icon={UserRound} label={t.Practitioner}>
                {practitioner.name}
                {practitioner.title || practitioner.specialty ? (
                  <span className="block font-normal text-muted-foreground text-xs">
                    {[practitioner.title, practitioner.specialty].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </BookingDetailRow>
              <BookingDetailRow icon={MapPin} label={t.Location}>
                {snapshot.locationHidden ? (
                  <span className="block font-normal text-muted-foreground text-xs">{hiddenAddressNote}</span>
                ) : (
                  <>
                    {location.name}
                    {location.address || location.city ? (
                      <span className="block font-normal text-muted-foreground text-xs">
                        {[location.address, location.city].filter(Boolean).join(", ")}
                      </span>
                    ) : null}
                  </>
                )}
                {location.accessibleEntrance && !snapshot.locationHidden ? (
                  <span className="mt-1 flex items-center gap-1.5 font-normal text-success-foreground text-xs">
                    <Accessibility className="size-3.5" aria-hidden="true" />
                    Step-free entrance
                  </span>
                ) : null}
              </BookingDetailRow>
            </dl>
          </CardPanel>
          {canAddToCalendar ? (
            <CardFooter className="border-t p-4 sm:px-5">
              <AddToCalendarMenu
                fileHref={`${bookingApi}/calendar`}
                managePath={apiPath ? undefined : `/manage/${encodeURIComponent(liveToken)}`}
                serviceName={service.name}
                businessName={clinic.name}
                startsAt={appointment.startsAt}
                endsAt={appointment.endsAt}
                personName={practitioner.name}
                location={location}
              />
            </CardFooter>
          ) : null}
        </Card>

        {appointment.status === "booked" && !apiPath && !isPreviewMode && new Date(appointment.endsAt).getTime() > openedAt ? (
          <CheckInCard manageToken={liveToken} appointmentId={appointment.id} />
        ) : null}

        {(appointment.status === "booked" || appointment.status === "checked_in") && !apiPath && !isPreviewMode && new Date(appointment.endsAt).getTime() > openedAt ? (
          <JoinVideoLink manageToken={liveToken} className="w-full sm:w-auto sm:self-start" />
        ) : null}

        {appointment.status === "completed" && !apiPath ? (
          <ReviewCard manageToken={liveToken} personName={practitioner.name} />
        ) : null}

        {appointment.status === "cancelled" ? (
          <Alert role={undefined}>
            <AlertTitle>Need another {t.appointment}?</AlertTitle>
            <AlertDescription>
              <Button
                variant="link"
                className="h-auto w-fit px-0"
                render={<Link href={`/book/${encodeURIComponent(clinic.slug)}`} />}
              >
                Book a new time
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {canTakeAction ? (
          <>
          <section aria-labelledby="appointment-actions-heading" className="flex flex-col gap-3">
            <h2 id="appointment-actions-heading" className="font-heading font-semibold text-base">
              Manage this {t.appointment}
            </h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {rescheduleRequested ? null : !isConfirmed ? (
                <Button
                  size="lg"
                  onClick={() => void performAction("confirm")}
                  loading={isSubmitting && !activeAction}
                >
                  <CheckCircle2 aria-hidden="true" />
                  Confirm attendance
                </Button>
              ) : (
                <Badge variant="success" size="lg" className="self-start sm:self-center">
                  <CheckCircle2 aria-hidden="true" />
                  Attendance confirmed
                </Badge>
              )}
              {snapshot.canReschedule ? (
                <Button size="lg" variant="outline" onClick={openReschedule}>
                  <CalendarDays aria-hidden="true" />
                  {rescheduleRequested ? "Choose a new time" : "Change time"}
                </Button>
              ) : null}
              {!apiPath && !isPreviewMode ? (
                <Menu>
                  <MenuTrigger render={<Button size="lg" variant="outline" />}>
                    <EllipsisVertical aria-hidden="true" />
                    More
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuItem onClick={() => { setActionError(""); setActionMessage(""); setContactOpen(true); }}>Change contact details</MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
              {snapshot.canCancel ? (
                <Button
                  size="lg"
                  variant="destructive-outline"
                  aria-haspopup="dialog"
                  className="sm:ms-auto"
                  onClick={() => {
                    setActionError("");
                    setActiveAction("cancel");
                  }}
                >
                  Cancel {t.appointment}
                </Button>
              ) : null}
            </div>
            <PolicyBlockedNotice messages={blockedMessages} phone={clinic.phone} />
          </section>
          {guestsAllowed ? (
            <GuestsCard
              snapshot={snapshot}
              saving={isSubmitting && !activeAction}
              error={guestError}
              onSave={(guests) => void performAction("edit_guests", { guests })}
            />
          ) : null}
          </>
        ) : null}
      </div>

      <Card render={<aside />} className="min-w-0 lg:sticky lg:top-6">
        <CardHeader className="p-5 pb-3">
          <CardTitle render={<h2 />} className="text-base">Before your {t.visit}</CardTitle>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4 p-5 pt-0">
          <dl className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground text-sm">Attendance</dt>
              <dd>
                <Badge variant={isConfirmed ? "success" : "warning"}>
                  {isConfirmed ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
                  {isConfirmed ? "Confirmed" : "Confirmation needed"}
                </Badge>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground text-sm">Pre-{t.visit} forms</dt>
              <dd>
                <Badge
                  variant={
                    appointment.formStatus === "submitted"
                      ? "success"
                      : appointment.formStatus === "not_assigned"
                        ? "secondary"
                        : "warning"
                  }
                >
                  {appointment.formStatus === "submitted" ? (
                    <CheckCircle2 aria-hidden="true" />
                  ) : appointment.formStatus === "not_assigned" ? (
                    <FileCheck2 aria-hidden="true" />
                  ) : (
                    <Clock3 aria-hidden="true" />
                  )}
                  {formLabel}
                </Badge>
              </dd>
            </div>
          </dl>
          <Separator />
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-sm">{t.Business} policy</h3>
            <p className="text-muted-foreground text-sm sm:text-xs">
              Online changes are available only while the {t.business}’s cancellation window is open. If a button is unavailable, call the {t.business}. Any late-cancellation fee applies only under the policy agreed with the {t.business}.
            </p>
          </div>
          {!manage && (!snapshot.canCancel || !snapshot.canReschedule) ? (
            <Alert role={undefined} variant="warning">
              <Clock3 aria-hidden="true" />
              <AlertDescription>
                At least one online change window has closed for this {t.appointment}.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardPanel>
        <CardFooter className="flex-col items-start gap-0.5 border-t p-5 py-4">
          <p className="font-medium text-sm">Need help?</p>
          <Button variant="link" className="h-auto px-0 tabular-nums" render={<a href={phoneHref(clinic.phone)} />}>
            {clinic.phone}
          </Button>
          <p className="break-all text-muted-foreground text-xs">{clinic.email}</p>
        </CardFooter>
      </Card>

      <CancelDialog
        open={activeAction === "cancel" && !stepUp}
        clinical={clinical}
        submitting={isSubmitting}
        error={activeAction === "cancel" ? actionError : ""}
        onClose={closeAction}
        onConfirm={(input) => void performAction("cancel", input)}
      />
      {contactOpen ? (
        <ChangeContactDialog
          bookingApi={bookingApi}
          hidden={stepUp?.action === "contact"}
          onClose={() => setContactOpen(false)}
          onNeedsCode={(retry) => setStepUp({ action: "contact", retry })}
          onSaved={() => {
            setContactOpen(false);
            setActionMessage("Your contact details were changed. We also let you know on your other contact.");
          }}
        />
      ) : null}
      {stepUpDialog}
    </div>
  );
}

function ActionErrorAlert({ message }: { message: string }) {
  const t = useTerms();
  return (
    <Alert variant="error">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>We could not update the {t.appointment}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
