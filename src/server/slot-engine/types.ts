import type { BookingWindow } from "@/lib/service-setup";

/**
 * The slot engine's input and output. The engine is a pure function: everything it needs is
 * in `SlotEngineInput`, loaded by `load.ts`, so the public page, the staff list, a reschedule
 * and the booking commit all get the same answer from the same rules.
 */

/** A stretch of time in epoch milliseconds, start included and end excluded. */
export interface Span {
  start: number;
  end: number;
}

/** One weekly range of working time, read on the wall clock of the schedule's timezone. */
export interface WorkingRule {
  /** 1 is Monday and 7 is Sunday, like Postgres `isodow`. */
  dayOfWeek: number;
  /** `HH:MM` or `HH:MM:SS`. */
  startsAtLocal: string;
  endsAtLocal: string;
  /** `YYYY-MM-DD`, in the schedule's timezone. */
  validFrom: string;
  validThrough: string | null;
}

/** A date that differs from the weekly pattern. `ranges: null` closes the day. */
export interface DateOverrideInput {
  date: string;
  ranges: Array<{ start: string; end: string }> | null;
}

/** A named weekly pattern plus its date changes, in its own timezone. */
export interface ScheduleInput {
  timezone: string;
  rules: WorkingRule[];
  overrides: DateOverrideInput[];
}

/** Dates when the weekly pattern is read in another timezone. */
export interface TravelInput {
  from: string;
  through: string;
  timezone: string;
}

export interface OutOfOfficeInput {
  span: Span;
  note: string | null;
}

/** Time a booking holds, with its buffers. `visitStart` and `visitEnd` are the visit alone, for explaining. */
export interface BusySpan extends Span {
  visitStart?: number;
  visitEnd?: number;
}

export interface PersonInput {
  id: string;
  /** Only candidates are offered. The others still count when working out which days the business is open. */
  candidate: boolean;
  /** When set, this person is offered only inside these spans: they cover for a teammate who is away. */
  candidateWithin?: Span[];
  /** The schedule in force for the service being offered. `null` is a person with no hours at all. */
  schedule: ScheduleInput | null;
  travel: TravelInput[];
  outOfOffice: OutOfOfficeInput[];
  /** Bookings that already hold this person, with their buffers included. */
  busy: BusySpan[];
  /** Time the business or this person blocked off. */
  blocks: Span[];
  /** Busy time in calendars this person connected (feature 16). Cached; never fetched while a customer chooses. */
  calendarBusy?: Span[];
}

export interface ResourceInput {
  id: string;
  busy: Span[];
}

export interface ServiceRules {
  /** The length being offered, one of the service's lengths. */
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  window: BookingWindow;
  /** Spacing between starts. `null` means the same as the length. */
  slotIntervalMinutes: number | null;
  startOffsetMinutes: number;
  /** When set, every slot also needs a free resource of this kind. */
  requiresResource: boolean;
  /** Each person offers only their earliest free start of each day (feature 38). Ignored for walk-ins and moves that keep their time. */
  firstSlotOnly?: boolean;
  /** Also offer the starts that sit right next to an existing booking, so the day has fewer gaps. Only for ordinary bookings. */
  optimizedSlots?: boolean;
}

/** A cap on bookings or booked minutes, already narrowed to the ones that can touch this service. */
export interface LimitRuleInput {
  id: string;
  scope: import("@/lib/booking-limits").LimitScope;
  scopeId: string | null;
  /** The people in a team pool. Empty for every other scope. */
  memberIds: string[];
  measure: import("@/lib/booking-limits").LimitMeasure;
  period: import("@/lib/booking-limits").LimitPeriod;
  maxValue: number;
  weekStart: 1 | 7;
}

/** What one limit already holds, as counts per local day. Days with nothing are left out. */
export interface LimitUsageInput {
  ruleId: string;
  days: Array<{ date: string; count: number; minutes: number }>;
}

/**
 * `walk_in` offers starts from 15 minutes ago to 12 hours ahead and ignores notice and window.
 * `existing` also ignores them, for checking a visit that is already booked and is not moving in time.
 */
export type SlotMode = "standard" | "walk_in" | "existing";

export interface SlotEngineInput {
  now: Date;
  /** Offered slots start at or after this moment and end at or before `to`. */
  from: Date;
  to: Date;
  mode: SlotMode;
  /** The location's timezone: business days and the booking window are counted in it. */
  timezone: string;
  service: ServiceRules;
  people: PersonInput[];
  resources: ResourceInput[];
  /** Public holidays that close the business, as dates on each person's wall clock. */
  holidays: Array<{ date: string; name: string }>;
  /** Narrows everyone's hours for this service to the overlap with this schedule. */
  restriction: ScheduleInput | null;
  /** Needed to tell which limits apply. Optional so a hand-built input in a test can leave them out. */
  serviceId?: string;
  locationId?: string;
  limits?: LimitRuleInput[];
  usage?: LimitUsageInput[];
}

export interface OfferedSlot {
  practitionerId: string;
  startsAt: Date;
  endsAt: Date;
  resourceId: string | null;
}

/** A start the engine is considering, before the filters decide whether to keep it. */
export interface Candidate {
  practitionerId: string;
  start: number;
  end: number;
  /** The service plus its buffers: the span that must be free. */
  reservedStart: number;
  reservedEnd: number;
  /** Filled in by the resource filter. */
  resourceId: string | null;
  /** The working day this start came from, so the hours filter can say which step closed it. */
  day?: import("./working-hours").WorkingDay;
}

export interface EngineContext {
  input: SlotEngineInput;
  people: Map<string, PersonInput>;
  /** The days the business is open, as `YYYY-MM-DD` in `input.timezone`, ascending. */
  openDays: string[];
}

/**
 * One rule that can remove a start. Later features add theirs to the list in
 * `offerable-slots.ts`: limits (38), holds (41), calendar busy time (16).
 * `reason` is a stable code; `explain.ts` turns codes into sentences.
 */
export interface SlotFilter {
  id: string;
  reject(candidate: Candidate, context: EngineContext): { reason: string; detail?: string } | null;
}
