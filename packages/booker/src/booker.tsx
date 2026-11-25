"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import { AvailabilityPicker } from "./availability-picker";
import { BookerApiError, createBookerApi, type BookerApi, type BookerCatalog, type BookerDetails, type BookerService, type BookerSlot } from "./api";
import { emitBookerEvent, type BookerEventHandler } from "./events";

export interface BookerProps {
  /** The business's link name, the part after /book/ in its booking page address. */
  clinicSlug: string;
  /** Where Kalendr runs, for example `https://book.example.com`. Defaults to the page's own origin. */
  baseUrl?: string;
  /** Start on one service instead of the list. */
  serviceId?: string;
  onEvent?: BookerEventHandler;
  /** For tests and server rendering. */
  fetch?: typeof fetch;
  className?: string;
}

type Step = "service" | "time" | "details" | "done";
type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; catalog: BookerCatalog };

const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const emptyDetails: BookerDetails = { firstName: "", lastName: "", email: "", phone: "" };

/** One "Full name" box, sent as first and last name: the last word is the last name, one word is a first name alone. */
function splitFullName(full: string): Pick<BookerDetails, "firstName" | "lastName"> {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { firstName: words[0] ?? "", lastName: "" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] ?? "" };
}

/**
 * A booking form for any React site. It lists services, offers open times, takes the customer's details and books
 * through the public API. Look and feel come from CSS variables (see booker.css); events go to `onEvent`.
 */
export function Booker({ clinicSlug, baseUrl, serviceId: initialServiceId, onEvent, fetch: fetchImpl, className }: BookerProps) {
  const api: BookerApi = useMemo(
    () => createBookerApi({ baseUrl: baseUrl ?? (typeof window === "undefined" ? "" : window.location.origin), clinicSlug, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    [baseUrl, clinicSlug, fetchImpl],
  );
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [step, setStep] = useState<Step>("service");
  const [service, setService] = useState<BookerService | null>(null);
  const [slotResult, setSlotResult] = useState<{ key: string; slots?: BookerSlot[]; error?: string } | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [slot, setSlot] = useState<BookerSlot | null>(null);
  const [details, setDetails] = useState<BookerDetails>(emptyDetails);
  const [fullName, setFullName] = useState("");
  // The customer says so themselves: the booking page asks the same, and the server refuses a booking without it.
  const [agreed, setAgreed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bookedId, setBookedId] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { name: useId(), email: useId(), phone: useId() };

  const chooseService = useCallback((next: BookerService) => {
    setService(next);
    setSlot(null);
    setWeekOffset(0);
    setStep("time");
    emitBookerEvent(onEventRef.current, { type: "service_selected", serviceId: next.id });
  }, []);

  const fetchCatalog = useCallback(() => {
    api.catalog().then(
      (catalog) => {
        setLoad({ state: "ready", catalog });
        const preselected = initialServiceId ? catalog.services.find((entry) => entry.id === initialServiceId) : undefined;
        if (preselected) chooseService(preselected);
      },
      (error: unknown) => setLoad({ state: "error", message: error instanceof Error ? error.message : "Booking is not available right now." }),
    );
  }, [api, initialServiceId, chooseService]);

  useEffect(() => {
    fetchCatalog();
    emitBookerEvent(onEventRef.current, { type: "opened" });
  }, [fetchCatalog]);

  const catalog = load.state === "ready" ? load.catalog : null;
  const location = service && catalog ? (catalog.locations.find((place) => service.locationIds.includes(place.id)) ?? catalog.locations[0]) : undefined;
  const timeZone = location?.timezone ?? catalog?.business.timezone ?? "UTC";
  // The times on screen belong to one service, place and week; anything else means they are still loading.
  const slotKey = `${service?.id ?? ""}|${location?.id ?? ""}|${weekOffset}`;
  const shownSlots = slotResult?.key === slotKey ? slotResult : null;

  useEffect(() => {
    if (step !== "time" || !service || !location) return;
    let cancelled = false;
    const key = slotKey;
    const from = new Date(Date.now() + weekOffset * WINDOW_DAYS * DAY_MS);
    const to = new Date(Date.now() + (weekOffset + 1) * WINDOW_DAYS * DAY_MS);
    api.slots({ serviceId: service.id, locationId: location.id, from, to }).then(
      (found) => { if (!cancelled) setSlotResult({ key, slots: found }); },
      (error: unknown) => { if (!cancelled) setSlotResult({ key, error: error instanceof Error ? error.message : "Times could not be loaded." }); },
    );
    return () => { cancelled = true; };
  }, [api, step, service, location, weekOffset, slotKey]);

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  function chooseSlot(next: BookerSlot) {
    setSlot(next);
    setStep("details");
    emitBookerEvent(onEventRef.current, { type: "slot_selected", ...(service ? { serviceId: service.id } : {}), personId: next.practitionerId, startsAt: next.startsAt, endsAt: next.endsAt });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!service || !slot || !location || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.book({ serviceId: service.id, locationId: location.id, slot, details: { ...details, ...splitFullName(fullName) }, agreedToPrivacyNotice: agreed, idempotencyKey: idempotencyKey.current });
      setBookedId(result.appointmentId);
      setStep("done");
      emitBookerEvent(onEventRef.current, { type: "booked", serviceId: service.id, personId: slot.practitionerId, startsAt: slot.startsAt, endsAt: slot.endsAt, appointmentId: result.appointmentId });
    } catch (error: unknown) {
      const code = error instanceof BookerApiError ? error.code : "request_failed";
      emitBookerEvent(onEventRef.current, { type: "failed", serviceId: service.id, errorCode: code });
      setProblem(error instanceof Error ? error.message : "The booking could not be made. Please try again.");
      // A taken time sends the customer back to pick another; a new key is needed because the request changed.
      if (code === "slot_unavailable") {
        idempotencyKey.current = crypto.randomUUID();
        setSlotResult(null);
        setStep("time");
        setWeekOffset(0);
      }
    } finally {
      setBusy(false);
    }
  }

  const set = (field: keyof BookerDetails) => (event: { target: { value: string } }) => setDetails((current) => ({ ...current, [field]: event.target.value }));
  const root = ["kalendr-booker", className].filter(Boolean).join(" ");

  if (load.state === "loading") return <div className={root} aria-busy="true"><p role="status">Loading…</p></div>;
  if (load.state === "error") {
    return (
      <div className={root}>
        <p role="alert">{load.message}</p>
        <button type="button" className="kalendr-booker__button" onClick={() => { setLoad({ state: "loading" }); fetchCatalog(); }}>Try again</button>
      </div>
    );
  }

  return (
    <div className={root}>
      {step === "service" ? (
        <section>
          <h2 ref={headingRef} tabIndex={-1} className="kalendr-booker__heading">Book with {load.catalog.business.name}</h2>
          {load.catalog.services.length === 0 ? <p className="kalendr-booker__empty">Nothing can be booked online yet.</p> : (
            <ul className="kalendr-booker__services">
              {load.catalog.services.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="kalendr-booker__service" onClick={() => chooseService(entry)}>
                    <span className="kalendr-booker__service-name">{entry.name}</span>
                    <span className="kalendr-booker__muted">{entry.durationMinutes} min{entry.priceLabel ? ` · ${entry.priceLabel}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {step === "time" && service ? (
        <section>
          <h2 ref={headingRef} tabIndex={-1} className="kalendr-booker__heading">Pick a time for {service.name}</h2>
          {shownSlots?.error ? (
            <p role="alert">{shownSlots.error}</p>
          ) : !shownSlots?.slots ? (
            <p role="status">Finding open times…</p>
          ) : (
            <AvailabilityPicker slots={shownSlots.slots} timeZone={timeZone} selectedId={slot?.id} onSelect={chooseSlot} />
          )}
          {problem ? <p role="alert" className="kalendr-booker__error">{problem}</p> : null}
          <div className="kalendr-booker__row">
            <button type="button" className="kalendr-booker__button kalendr-booker__button--quiet" onClick={() => { setProblem(null); setService(null); setStep("service"); }}>Back</button>
            {weekOffset > 0 ? <button type="button" className="kalendr-booker__button kalendr-booker__button--quiet" onClick={() => setWeekOffset(weekOffset - 1)}>Earlier</button> : null}
            <button type="button" className="kalendr-booker__button kalendr-booker__button--quiet" onClick={() => setWeekOffset(weekOffset + 1)}>Later</button>
          </div>
        </section>
      ) : null}

      {step === "details" && service && slot ? (
        <form onSubmit={submit} noValidate={false}>
          <h2 ref={headingRef} tabIndex={-1} className="kalendr-booker__heading">Your details</h2>
          <p className="kalendr-booker__muted">
            {service.name}, {new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(slot.startsAt))}
          </p>
          <label htmlFor={ids.name} className="kalendr-booker__label">Full name</label>
          <input id={ids.name} className="kalendr-booker__input" required minLength={2} maxLength={161} autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} />
          <label htmlFor={ids.email} className="kalendr-booker__label">Email</label>
          <input id={ids.email} className="kalendr-booker__input" type="email" required autoComplete="email" value={details.email} onChange={set("email")} />
          <label htmlFor={ids.phone} className="kalendr-booker__label">Phone</label>
          <input id={ids.phone} className="kalendr-booker__input" type="tel" required minLength={8} autoComplete="tel" value={details.phone} onChange={set("phone")} />
          <label className="kalendr-booker__check">
            <input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
            <span>I understand and agree to the business&apos;s privacy notice.</span>
          </label>
          {problem ? <p role="alert" className="kalendr-booker__error">{problem}</p> : null}
          <div className="kalendr-booker__row">
            <button type="button" className="kalendr-booker__button kalendr-booker__button--quiet" onClick={() => setStep("time")}>Back</button>
            <button type="submit" className="kalendr-booker__button" disabled={busy}>{busy ? "Booking…" : "Confirm booking"}</button>
          </div>
        </form>
      ) : null}

      {step === "done" ? (
        <section role="status">
          <h2 ref={headingRef} tabIndex={-1} className="kalendr-booker__heading">You&apos;re booked</h2>
          <p>We sent the details to your email. Your reference is <strong data-testid="booker-reference">{bookedId}</strong>.</p>
        </section>
      ) : null}
    </div>
  );
}
