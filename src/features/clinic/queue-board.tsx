"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity } from "motion/react";
import { ArrowUpRight, ChevronDown, ChevronRight, ChevronUp, Ellipsis, Megaphone, Plus, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import type { Appointment } from "@/lib/domain";
import { formatMoney, visitBalance } from "@/lib/money";
import type { TermWords } from "@/lib/terminology";
import { cn } from "@/lib/utils";

import { appointmentTime } from "./clinic-format";
import { ChoiceField, type Choice } from "./choice-field";
import { VisitNotesField, VisitPractitionerField, VisitReasonField, VisitRoomField, VisitServiceField, VisitSourceField, VisitTimeField } from "./visit-editors";
import { useVisitEdits } from "./use-visit-edits";
import { CustomValue, PropertyRows, useVisitProperties, type BuiltInProperty, type VisitProperty } from "./visit-properties";
import {
  moveRule,
  queueOrder,
  stageOf,
  visitActions,
  visitFlags,
  type QuickStep,
  type Stage,
  type Timings,
  type VisitFlag,
  type VisitActions,
  type VisitHandlers,
} from "./today-queue-card";

export interface BoardColumn {
  id: Stage;
  title: string;
  empty: string;
}

/** One row of the board in swimlane mode: everything one person is seeing today. */
export interface BoardLane {
  id: string;
  name: string;
  image?: string | null;
}

interface QueueBoardProps {
  columns: BoardColumn[];
  /** Today's visits after search and filters. */
  visits: Appointment[];
  /** Set to split the board into a row per person. */
  lanes?: BoardLane[];
  timings: Timings;
  clockIso: string;
  t: TermWords;
  currency?: string;
  nameOf: (appointment: Appointment) => string;
  serviceName: (id: string) => string;
  person: (id: string) => { name: string; image?: string | null } | undefined;
  roomsOf: (appointment: Appointment) => string;
  /** Whether cards can be dragged to the next column. Cards still open their details without it. */
  canDrag: boolean;
  busyId: string | null;
  handlersFor: (appointment: Appointment) => VisitHandlers;
  /** Saves a dragged card's step. Resolves true once it is saved and the day has reloaded. */
  onMove: (appointment: Appointment, step: QuickStep) => Promise<boolean>;
  columnMenu?: (column: BoardColumn, index: number) => ActionMenuEntry[];
  /** Above this many, Waiting says it is over its limit. */
  waitingLimit?: number;
  onAddWalkIn?: () => void;
  onNewVisit: () => void;
}

const stageTone: Record<Stage, string> = { up_next: "text-primary", waiting: "text-warning", with_practitioner: "text-info", done: "text-success" };

const formWords: Record<Appointment["formStatus"], string> = {
  not_assigned: "Not assigned",
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
};

const flagBadge: Record<VisitFlag["tone"], "error" | "warning" | "info" | "secondary"> = { error: "error", warning: "warning", info: "info", muted: "secondary" };

/** A drop target is a whole column, or one person's cell in it when the board has lanes. */
function targetId(stage: Stage, lane?: string) {
  return lane ? `cell:${stage}:${lane}` : `col:${stage}`;
}

function parseTarget(id: UniqueIdentifier): { stage: Stage; lane?: string } {
  const [, stage, lane] = String(id).split(":");
  return { stage: stage as Stage, lane: lane || undefined };
}

function tokenOf(appointment: Appointment) {
  return appointment.queue ? `#${appointment.queue.number}` : appointmentTime(appointment.startsAt);
}

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

const arrowDirections: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };

/** Arrow keys jump a lifted card to the nearest column (or lane) in that direction. */
const boardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = arrowDirections[event.code];
  const current = context.collisionRect;
  if (!direction || !current) return undefined;
  event.preventDefault();
  const centerX = current.left + current.width / 2;
  const centerY = current.top + current.height / 2;
  let best: { score: number; rect: { left: number; top: number; width: number } } | null = null;
  for (const container of context.droppableContainers.getEnabled()) {
    const rect = context.droppableRects.get(container.id);
    if (!rect) continue;
    const dx = rect.left + rect.width / 2 - centerX;
    const dy = rect.top + Math.min(rect.height / 2, 48) - centerY;
    const along = dx * direction[0] + dy * direction[1];
    if (along <= 8) continue;
    const across = Math.abs(dx * direction[1]) + Math.abs(dy * direction[0]);
    const score = along + 3 * across;
    if (!best || score < best.score) best = { score, rect };
  }
  if (!best) return undefined;
  return { x: best.rect.left + (best.rect.width - current.width) / 2, y: best.rect.top + 52 };
};

function pie(fraction: number) {
  const angle = fraction * Math.PI * 2;
  const x = 7 + 3 * Math.sin(angle);
  const y = 7 - 3 * Math.cos(angle);
  return `M7 7 L7 4 A3 3 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
}

/** How far along the day a column is: dashed for not here yet, filling up, then a tick. */
export function StatusIcon({ stage, className }: { stage: Stage; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" className={cn("size-3.5 shrink-0", stageTone[stage], className)}>
      {stage === "up_next" ? (
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.3 2" />
      ) : stage === "done" ? (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M4.3 7.2 6.2 9l3.5-3.7" fill="none" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={pie(stage === "waiting" ? 1 / 3 : 2 / 3)} fill="currentColor" />
        </>
      )}
    </svg>
  );
}

const stageAfter: Partial<Record<QuickStep, Stage>> = { checkin: "waiting", start: "with_practitioner", complete: "done" };

/**
 * The visit's stage as a select: it lists only the moves that make sense from here (the next step, left,
 * no-show, cancel), so staff change status in place the way they would any other property.
 */
function VisitStatusField({ appointment, stage, title, actions, onStep, busy }: {
  appointment: Appointment;
  stage: Stage;
  title: string;
  actions: VisitActions;
  onStep?: (step: QuickStep) => void;
  busy: boolean;
}) {
  const router = useRouter();
  const menuEntry = (id: string) => actions.menu.find((item) => item.id === id);
  const left = menuEntry("left");
  const noShow = menuEntry("no_show");
  const canCancel = appointment.status === "booked" || appointment.status === "requested";
  const choices: (Choice & { run: () => void })[] = [
    ...(actions.quick && onStep ? [{
      id: actions.quick,
      label: actions.step.label,
      leading: <StatusIcon stage={stageAfter[actions.quick] ?? stage} />,
      run: () => onStep(actions.quick!),
    }] : []),
    ...(appointment.status === "requested" ? [{ id: "review", label: actions.step.label, run: () => router.push(actions.href) }] : []),
    ...(left && "onSelect" in left && left.onSelect ? [{ id: "left", label: "Left without being seen", run: left.onSelect }] : []),
    ...(noShow && "onSelect" in noShow && noShow.onSelect ? [{ id: "no_show", label: "Mark no-show", run: noShow.onSelect }] : []),
    ...(canCancel ? [{ id: "cancel", label: `Cancel ${appointment.status === "requested" ? "request" : "visit"}…`, run: () => router.push(`${actions.detailsHref}&action=cancel`) }] : []),
  ];
  const current = <span className="inline-flex items-center gap-1.5"><StatusIcon stage={stage} />{title}</span>;
  if (!choices.length) return current;
  return (
    <ChoiceField
      label="Status"
      value={{ id: stage, label: title, leading: <StatusIcon stage={stage} /> }}
      choices={choices}
      loading={busy}
      placeholder={title}
      empty="Nothing to change"
      onPick={(id) => choices.find((choice) => choice.id === id)?.run()}
    />
  );
}

/** A count whose digits roll up or down when it changes. */
function RollingCount({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState({ value, direction: 0 });
  if (shown.value !== value) setShown({ value, direction: value > shown.value ? 1 : -1 });
  return (
    <span className={cn("relative inline-flex h-5 overflow-hidden tabular-nums", className)}>
      <AnimatePresence mode="popLayout" initial={false} custom={shown.direction}>
        <motion.span
          key={value}
          custom={shown.direction}
          variants={{
            enter: (direction: number) => ({ y: direction > 0 ? "100%" : "-100%", opacity: 0 }),
            center: { y: 0, opacity: 1 },
            exit: (direction: number) => ({ y: direction > 0 ? "-100%" : "100%", opacity: 0 }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ type: "spring", stiffness: 500, damping: 34 }}
          className="inline-block leading-5"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

interface CardModel {
  appointment: Appointment;
  stage: Stage;
  name: string;
  service: string;
  person?: { name: string; image?: string | null };
  flags: VisitFlag[];
}

/** What a card shows, shared by the card in its column and the one under the pointer while dragging. */
function CardFace({ card, busy }: { card: CardModel; busy?: boolean }) {
  const { appointment, flags } = card;
  const extra = flags.length - 3;
  return (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{tokenOf(appointment)}</span>
        {appointment.queue ? <span aria-hidden="true">· {appointmentTime(appointment.startsAt)}</span> : null}
        <span className="ms-auto flex items-center">
          {busy ? (
            <Spinner className="size-4" />
          ) : card.person ? (
            <PersonAvatar name={card.person.name} image={card.person.image} className="size-5 [&_[data-slot=avatar-fallback]]:text-[0.5625rem]" />
          ) : null}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm leading-snug font-medium text-foreground">{card.name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="inline-flex h-5 max-w-full items-center truncate rounded-md border px-1.5 text-[0.6875rem] text-muted-foreground">{card.service}</span>
        {flags.slice(0, 3).map((flag) => (
          <Badge key={flag.id} variant={flagBadge[flag.tone]} size="sm" className="h-5 gap-1 px-1.5 text-[0.6875rem] [&_svg]:size-3">
            <flag.Icon aria-hidden="true" />
            {flag.short}
          </Badge>
        ))}
        {extra > 0 ? <span className="text-[0.6875rem] text-muted-foreground">+{extra}</span> : null}
      </div>
    </>
  );
}

function cardLabel(card: CardModel) {
  const ticket = card.appointment.queue ? `Token ${card.appointment.queue.number}` : appointmentTime(card.appointment.startsAt);
  return [ticket, card.name, card.service, card.person?.name, ...card.flags.map((flag) => flag.label)].filter(Boolean).join(", ");
}

const cardClass =
  "relative block w-full cursor-pointer touch-manipulation select-none rounded-[10px] border bg-card p-2.5 text-start shadow-xs/5 outline-none transition-[box-shadow,border-color,opacity] hover:border-foreground/16 focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32";

function BoardCard({ card, canDrag, busy, selected, onOpen }: { card: CardModel; canDrag: boolean; busy: boolean; selected: boolean; onOpen: (id: string, focusPanel: boolean) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.appointment.id, disabled: !canDrag });
  const dragProps = canDrag ? { ...attributes, "aria-roledescription": "Draggable card" } : {};
  // dnd-kit's own key handler picks the card up on Space; Enter opens the details instead.
  const { onKeyDown: liftKey, ...pointerListeners } = (canDrag ? listeners : undefined) ?? {};
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || (!canDrag && event.key === " ")) {
      event.preventDefault();
      onOpen(card.appointment.id, true);
      return;
    }
    liftKey?.(event);
  }
  return (
    <div
      ref={setNodeRef}
      {...dragProps}
      role="button"
      tabIndex={0}
      aria-busy={busy || undefined}
      aria-current={selected || undefined}
      data-card-id={card.appointment.id}
      {...pointerListeners}
      onKeyDown={onKeyDown}
      onClick={() => onOpen(card.appointment.id, false)}
      className={cn(
        cardClass,
        canDrag && "cursor-grab active:cursor-grabbing",
        selected && "border-primary/50 ring-2 ring-primary/30",
        isDragging && "border-dashed opacity-40 shadow-none",
        busy && "opacity-70",
      )}
    >
      {/* The card's name: the visible face is shorthand (initials, "15m"), so it is read from this line instead. */}
      <span className="sr-only">{cardLabel(card)}</span>
      <div aria-hidden="true">
        <CardFace card={card} busy={busy} />
      </div>
    </div>
  );
}

interface DropState {
  id: string;
  ok: boolean;
  reason?: string;
}

interface CardListProps {
  cards: CardModel[];
  drop: DropState | null;
  dropTarget: string;
  placeholderHeight: number;
  droppedId: string | null;
  canDrag: boolean;
  busyId: string | null;
  selectedId: string | null;
  onOpen: (id: string, focusPanel: boolean) => void;
  empty: string;
  label: string;
  footer?: ReactNode;
}

/** The cards in one column (or one lane's cell), with neighbours that glide when a card leaves or lands. */
function CardList({ cards, drop, dropTarget, placeholderHeight, droppedId, canDrag, busyId, selectedId, onOpen, empty, label, footer }: CardListProps) {
  const hovering = drop?.id === dropTarget;
  return (
    <>
      {hovering && !drop.ok && drop.reason ? (
        <p className="mb-1.5 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive-foreground">{drop.reason}</p>
      ) : null}
      <ul className="flex flex-col gap-1.5" aria-label={label}>
        <AnimatePresence initial={false} mode="popLayout">
          {cards.map((card) => {
            const justDropped = card.appointment.id === droppedId;
            return (
              <motion.li
                key={card.appointment.id}
                layout={justDropped ? false : "position"}
                layoutId={justDropped ? undefined : `queue-card-${card.appointment.id}`}
                initial={justDropped ? false : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
              >
                <BoardCard card={card} canDrag={canDrag} busy={busyId === card.appointment.id} selected={selectedId === card.appointment.id} onOpen={onOpen} />
              </motion.li>
            );
          })}
          {hovering && drop.ok ? (
            <motion.li
              key="drop-placeholder"
              aria-hidden="true"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ height: placeholderHeight }}
              className="rounded-[10px] border-2 border-dashed border-primary/40 bg-primary/4"
            />
          ) : null}
        </AnimatePresence>
      </ul>
      {!cards.length && !(hovering && drop.ok) ? <p className="px-1 py-3 text-center text-xs text-muted-foreground">{empty}</p> : null}
      {footer}
    </>
  );
}

function DropZone({ id, className, children, drop, overLimit, ...rest }: { id: string; className?: string; children: ReactNode; drop: DropState | null; overLimit?: boolean } & React.HTMLAttributes<HTMLElement>) {
  const { setNodeRef } = useDroppable({ id });
  const state = drop?.id === id ? (drop.ok ? "ok" : "no") : undefined;
  return (
    <section
      ref={setNodeRef}
      data-over={state}
      data-limit={overLimit ? "over" : undefined}
      className={cn(
        "transition-[background-color,box-shadow] duration-150",
        "data-[limit=over]:bg-warning/6 data-[over=no]:bg-destructive/4 data-[over=no]:ring-destructive/40 data-[over=ok]:bg-primary/4 data-[over=ok]:ring-primary/50",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

function ColumnHead({ column, count, limit, menu, add }: { column: BoardColumn; count: number; limit?: number; menu?: ActionMenuEntry[]; add?: ReactNode }) {
  const over = limit !== undefined && count > limit;
  return (
    <header className="flex h-10 items-center gap-2 px-3">
      <StatusIcon stage={column.id} />
      <h3 id={`queue-${column.id}`} className="min-w-0 truncate text-sm font-medium">{column.title}</h3>
      <span className={cn("flex items-center text-sm text-muted-foreground", over && "text-warning-foreground")} aria-label={limit !== undefined ? `${count} of ${limit}` : `${count}`}>
        <RollingCount value={count} />
        {limit !== undefined ? <span aria-hidden="true">/{limit}</span> : null}
      </span>
      {over ? <Badge variant="warning" size="sm">Over limit</Badge> : null}
      <span className="ms-auto flex items-center gap-0.5">
        {add}
        {menu ? (
          <ActionMenuButton className="size-7" icon={<Ellipsis aria-hidden="true" />} iconOnly items={menu} label={`${column.title} column options`} variant="ghost" />
        ) : null}
      </span>
    </header>
  );
}

/** The properties every visit has, in their default order. Businesses can rename, re-icon, hide and reorder them. */
function panelProperties(t: TermWords, hasRooms: boolean): BuiltInProperty[] {
  return [
    { id: "status", label: "Status", icon: "circle-dot", required: true },
    { id: "token", label: "Token", icon: "hash" },
    { id: "time", label: "Time", icon: "clock", required: true },
    { id: "practitioner", label: t.Practitioner, icon: "stethoscope" },
    ...(hasRooms ? [{ id: "room", label: t.Resource, icon: "door-open" } as BuiltInProperty] : []),
    { id: "service", label: "Service", icon: "layers" },
    { id: "source", label: "Booked via", icon: "inbox" },
    { id: "form", label: "Form", icon: "file-text" },
    { id: "payment", label: "Payment", icon: "wallet" },
    { id: "reason", label: "Reason", icon: "message-square" },
    { id: "notes", label: "Notes", icon: "sticky-note" },
  ];
}

/** Everything about one visit, beside the board, so staff never lose their place in the queue. */
function VisitPanel({
  card,
  column,
  index,
  total,
  onPrev,
  onNext,
  onClose,
  handlers,
  clockIso,
  t,
  currency,
  timing,
  rooms,
  busy,
  panelRef,
}: {
  card: CardModel;
  column?: BoardColumn;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  handlers: VisitHandlers;
  clockIso: string;
  t: TermWords;
  currency?: string;
  timing: Timings[string];
  rooms: string;
  busy: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
}) {
  const { appointment, stage, name } = card;
  const actions = visitActions(appointment, stage, clockIso, t, handlers, currency);
  const money = visitBalance(appointment.priceMinor, appointment.paidMinor, appointment.refundedMinor);
  const payment = money.state === "unpriced"
    ? "No set price"
    : money.dueMinor > 0
      ? `${formatMoney(money.dueMinor, currency)} due of ${formatMoney(money.priceMinor ?? 0, currency)}`
      : `Paid ${formatMoney(money.netPaidMinor, currency)}`;
  const activity = [
    { label: "Checked in", at: timing?.checkedInAt ?? appointment.checkedInAt },
    { label: appointment.queue && appointment.queue.callCount > 1 ? `Called (${appointment.queue.callCount} times)` : "Called", at: appointment.queue?.calledAt },
    { label: `${t.Visit} started`, at: timing?.startedAt ?? appointment.startedAt },
    { label: "Finished", at: appointment.completedAt },
  ].filter((item): item is { label: string; at: string } => Boolean(item.at));
  const edits = useVisitEdits();
  const canEdit = edits.canEditVisit;
  const visitProperties = useVisitProperties(panelProperties(t, Boolean(rooms)));
  const values = appointment.customFields ?? {};
  const value = (property: VisitProperty): ReactNode => {
    if (property.custom) {
      const field = property.custom;
      return (
        <CustomValue
          key={`${appointment.id}-${field.id}`}
          field={field}
          value={values[field.id]}
          disabled={!canEdit}
          editor={visitProperties.editor}
          canEditProperties={visitProperties.canEdit}
          onChange={(next) => edits.saveDetails(appointment, { customFields: { [field.id]: next } })}
        />
      );
    }
    switch (property.id) {
      case "status":
        return <VisitStatusField appointment={appointment} stage={stage} title={column?.title ?? stage} actions={actions} onStep={handlers.onStep} busy={busy} />;
      case "token":
        return appointment.queue ? <span className="font-mono">#{appointment.queue.number}</span> : <span className="text-muted-foreground">Not yet</span>;
      case "time":
        return <VisitTimeField key={`${appointment.id}-time`} appointment={appointment} label={property.label} />;
      case "practitioner":
        return <VisitPractitionerField appointment={appointment} label={property.label} />;
      case "room":
        return <VisitRoomField appointment={appointment} label={property.label} />;
      case "service":
        return <VisitServiceField appointment={appointment} label={property.label} />;
      case "source":
        return <VisitSourceField appointment={appointment} label={property.label} />;
      case "form":
        return (
          <span className="flex w-full items-center gap-2">
            {formWords[appointment.formStatus]}
            {canEdit && appointment.formStatus !== "submitted" && appointment.formStatus !== "not_assigned" && ["requested", "booked", "checked_in"].includes(appointment.status) ? (
              <button type="button" className="ms-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => void edits.markFormReceived(appointment)}>Mark received</button>
            ) : null}
          </span>
        );
      case "payment":
        return payment;
      case "reason":
        return <VisitReasonField appointment={appointment} label={property.label} />;
      case "notes":
        return <VisitNotesField appointment={appointment} label={property.label} />;
      default:
        return null;
    }
  };

  const primary = actions.collect && handlers.onPay ? (
    <Button size="sm" onClick={handlers.onPay} disabled={busy}>{actions.collect}</Button>
  ) : actions.quick && handlers.onStep ? (
    <Button size="sm" aria-label={`${actions.step.label} · ${name}`} onClick={() => handlers.onStep?.(actions.quick!)} disabled={busy}>
      {busy ? <Spinner className="size-4" /> : null}{actions.step.label}
    </Button>
  ) : (
    <Button size="sm" variant="outline" aria-label={`${actions.step.label} · ${name}`} render={<Link href={actions.href} />}>{actions.step.label}</Button>
  );

  return (
    <motion.aside
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="visit-panel-title"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
      onKeyDown={(event) => {
        // Popovers render in a portal, but their key events still bubble here through React.
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (event.key === "Escape" && !(event.target as HTMLElement).closest("[role=menu]")) {
          event.stopPropagation();
          onClose();
        }
      }}
      className="absolute inset-y-0 end-0 z-30 flex w-full flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg/8 outline-none sm:w-[26rem]"
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 ps-1 text-sm text-muted-foreground">
          <StatusIcon stage={stage} />
          <span className="truncate">{column?.title}</span>
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-foreground">{tokenOf(appointment)}</span>
        </nav>
        <span className="px-1 text-xs text-muted-foreground tabular-nums">{index + 1} of {total}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={onPrev} disabled={index <= 0}><ChevronUp aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={onNext} disabled={index >= total - 1}><ChevronDown aria-hidden="true" /></Button>
        <ActionMenuButton className="size-7" icon={<Ellipsis aria-hidden="true" />} iconOnly items={actions.menu} label={`More for ${name}`} variant="ghost" />
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}><X aria-hidden="true" /></Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
      <div className="px-4 py-4">
        <h2 id="visit-panel-title" className="text-lg leading-tight font-semibold">{name}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{card.service} · {appointmentTime(appointment.startsAt)}</p>
        {card.flags.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {card.flags.map((flag) => (
              <Badge key={flag.id} variant={flagBadge[flag.tone]} className="gap-1 [&_svg]:size-3"><flag.Icon aria-hidden="true" />{flag.label}</Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {primary}
          {actions.call ? (
            <Button size="sm" variant="outline" onClick={actions.call.onSelect} disabled={busy}><Megaphone aria-hidden="true" />{actions.call.label}</Button>
          ) : null}
        </div>

        <PropertyRows className="mt-5" properties={visitProperties} renderValue={value} />

        {activity.length ? (
          <section aria-label="Activity" className="mt-5 border-t pt-4">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Activity</h3>
            <ol className="flex flex-col gap-2">
              {activity.map((item) => (
                <li key={item.label} className="flex items-center gap-2 text-sm">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/50" />
                  <span>{item.label}</span>
                  <span className="ms-auto text-xs text-muted-foreground tabular-nums">{appointmentTime(item.at)}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
      </ScrollArea>

      <footer className="shrink-0 border-t p-2">
        <Button variant="ghost" size="sm" className="w-full justify-between" render={<Link href={actions.detailsHref} />}>
          Open full {t.visit}
          <ArrowUpRight aria-hidden="true" />
        </Button>
      </footer>
    </motion.aside>
  );
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("input, textarea, select, [role=dialog], [role=menu], [role=listbox]"));
}

/**
 * Today's queue as a board: a column per stage of the day, cards that drag one column forward to save
 * the next step, an optional row per person, and a details panel that opens beside the board.
 */
export function QueueBoard(props: QueueBoardProps) {
  const { columns, visits, lanes, timings, clockIso, t, currency, canDrag, busyId, handlersFor, onMove, columnMenu, waitingLimit, onAddWalkIn, onNewVisit } = props;
  const reduce = useReducedMotion() ?? false;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [pending, setPending] = useState<Record<string, Stage>>({});
  const [droppedId, setDroppedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placeholderHeight, setPlaceholderHeight] = useState(76);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dropNote = useRef("");
  const dragX = useMotionValue(0);
  const velocity = useVelocity(dragX);
  const tilt = useSpring(useTransform(velocity, [-1400, 0, 1400], [-6, 0, 6], { clamp: true }), { stiffness: 320, damping: 26 });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] }, coordinateGetter: boardCoordinates }),
  );

  const stageFor = (appointment: Appointment) => pending[appointment.id] ?? stageOf(appointment, timings);
  const cards = useMemo(() => {
    const model = (appointment: Appointment): CardModel => {
      const stage = pending[appointment.id] ?? stageOf(appointment, timings);
      return {
        appointment,
        stage,
        name: props.nameOf(appointment),
        service: props.serviceName(appointment.serviceId),
        person: props.person(appointment.practitionerId),
        flags: visitFlags(stage, appointment, timings[appointment.id], clockIso, currency),
      };
    };
    const byStage = new Map<Stage, CardModel[]>();
    for (const column of columns) {
      const inStage = visits.filter((appointment) => (pending[appointment.id] ?? stageOf(appointment, timings)) === column.id);
      byStage.set(column.id, (column.id === "waiting" ? queueOrder(inStage, clockIso) : inStage).map(model));
    }
    return byStage;
    // The lookups are stable per render of the page; the visits, timings and clock are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, visits, timings, clockIso, pending, currency]);

  const laneCards = (stage: Stage, lane: string) => (cards.get(stage) ?? []).filter((card) => card.appointment.practitionerId === lane);
  const shownLanes = lanes?.filter((lane) => columns.some((column) => laneCards(column.id, lane.id).length)) ?? [];

  // Reading order for J/K and the panel's "3 of 12": lane by lane, then column by column.
  const order: CardModel[] = lanes
    ? shownLanes.flatMap((lane) => (collapsed.has(lane.id) ? [] : columns.flatMap((column) => laneCards(column.id, lane.id))))
    : columns.flatMap((column) => cards.get(column.id) ?? []);
  const byId = (id: UniqueIdentifier | null) => (id ? order.find((card) => card.appointment.id === String(id)) ?? [...cards.values()].flat().find((card) => card.appointment.id === String(id)) : undefined);
  const selectedIndex = selectedId ? order.findIndex((card) => card.appointment.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? order[selectedIndex] : undefined;
  const active = byId(activeId);
  const columnTitle = (stage: Stage) => columns.find((column) => column.id === stage)?.title ?? stage;

  function focusCard(id: string) {
    rootRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.focus();
  }

  function open(id: string, focusPanel: boolean) {
    // The click that ends a drag is not a request to open the card.
    if (justDragged.current) return;
    setSelectedId(id);
    if (focusPanel) requestAnimationFrame(() => panelRef.current?.focus());
  }

  function close() {
    const id = selectedId;
    setSelectedId(null);
    if (id) requestAnimationFrame(() => focusCard(id));
  }

  function step(by: 1 | -1) {
    if (!order.length) return;
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-card-id]")?.dataset.cardId;
    const from = selectedId ?? focused;
    const index = from ? order.findIndex((card) => card.appointment.id === from) : -1;
    const next = order[Math.min(order.length - 1, Math.max(0, index === -1 ? 0 : index + by))];
    if (!next) return;
    if (selectedId) setSelectedId(next.appointment.id);
    focusCard(next.appointment.id);
  }

  // J/K walk through the cards and Escape closes the panel, from anywhere on the page.
  const keys = useRef({ step, close, selectedId, dragging: false });
  useEffect(() => {
    keys.current = { step, close, selectedId, dragging: Boolean(activeId) };
  });
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || keys.current.dragging) return;
      if (event.key === "Escape" && keys.current.selectedId && !(event.target as HTMLElement | null)?.closest?.("[role=menu], [role=dialog], [role=listbox]")) {
        keys.current.close();
        return;
      }
      if (isTyping(event.target)) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        keys.current.step(event.key === "j" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function judge(id: UniqueIdentifier, target: UniqueIdentifier): { ok: true; step: QuickStep } | { ok: false; reason: string } | null {
    const card = byId(id);
    if (!card) return null;
    const { stage, lane } = parseTarget(target);
    const from = stageFor(card.appointment);
    if (lane && lane !== card.appointment.practitionerId) {
      return { ok: false, reason: `Keep it in the same ${t.practitioner}'s row. Open the ${t.visit} to change who it is with.` };
    }
    const rule = moveRule(card.appointment, from, stage, t);
    if (!rule) return null;
    return "step" in rule ? { ok: true, step: rule.step } : { ok: false, reason: rule.reason };
  }

  const justDragged = useRef(false);

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    setPlaceholderHeight(Math.round(event.active.rect.current.initial?.height ?? 76));
    dragX.jump(0);
  }

  function onDragOver(event: DragOverEvent) {
    if (!event.over) return setDrop(null);
    const verdict = judge(event.active.id, event.over.id);
    setDrop(verdict ? { id: String(event.over.id), ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason } : null);
  }

  function onDragEnd(event: DragEndEvent) {
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
    const card = byId(event.active.id);
    setActiveId(null);
    setDrop(null);
    dropNote.current = card ? `${card.name} returned to ${columnTitle(card.stage)}.` : "";
    if (!card || !event.over) return;
    const verdict = judge(event.active.id, event.over.id);
    if (!verdict) return;
    if (!verdict.ok) {
      dropNote.current = `${verdict.reason} ${card.name} returned to ${columnTitle(card.stage)}.`;
      return;
    }
    const { stage } = parseTarget(event.over.id);
    const id = card.appointment.id;
    dropNote.current = `Dropped ${card.name} in ${columnTitle(stage)}. Saving.`;
    setPending((current) => ({ ...current, [id]: stage }));
    setDroppedId(id);
    window.setTimeout(() => setDroppedId((current) => (current === id ? null : current)), 600);
    void onMove(card.appointment, verdict.step).finally(() => {
      setPending((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    });
  }

  function onDragCancel() {
    setActiveId(null);
    setDrop(null);
  }

  const announcements: Announcements = {
    onDragStart: ({ active: item }) => {
      const card = byId(item.id);
      return `Picked up ${card ? `${tokenOf(card.appointment)}, ${card.name}` : "card"} in ${card ? columnTitle(card.stage) : "its column"}. Use the arrow keys to move it to another column, Space to drop, or Escape to cancel.`;
    },
    onDragOver: ({ active: item, over }) => {
      const card = byId(item.id);
      if (!over) return `${card?.name ?? "The card"} is not over a column.`;
      const { stage } = parseTarget(over.id);
      const verdict = judge(item.id, over.id);
      if (verdict && !verdict.ok) return `${columnTitle(stage)}: ${verdict.reason}`;
      return `${card?.name ?? "The card"} is over ${columnTitle(stage)}.`;
    },
    onDragEnd: () => dropNote.current,
    onDragCancel: ({ active: item }) => {
      const card = byId(item.id);
      return `Cancelled. ${card?.name ?? "The card"} returned to ${card ? columnTitle(card.stage) : "its column"}.`;
    },
  };

  const dropAnimation: DropAnimation | null = reduce
    ? null
    : { duration: 280, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.15)", sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }) };

  const shared = { placeholderHeight, droppedId, canDrag, busyId, selectedId, onOpen: open, drop };
  const addButton = (stage: Stage, compact: boolean) => {
    if (stage === "waiting" && onAddWalkIn) {
      return compact
        ? <Button variant="ghost" size="icon-xs" aria-label="Add walk-in" onClick={onAddWalkIn}><UserPlus aria-hidden="true" /></Button>
        : <Button variant="ghost" size="sm" className="mt-1.5 w-full justify-start text-muted-foreground" onClick={onAddWalkIn}><Plus aria-hidden="true" />Add walk-in</Button>;
    }
    if (stage === "up_next") {
      return compact
        ? <Button variant="ghost" size="icon-xs" aria-label={`New ${t.appointment}`} onClick={onNewVisit}><Plus aria-hidden="true" /></Button>
        : <Button variant="ghost" size="sm" className="mt-1.5 w-full justify-start text-muted-foreground" onClick={onNewVisit}><Plus aria-hidden="true" />New {t.appointment}</Button>;
    }
    return null;
  };
  const limitFor = (stage: Stage) => (stage === "waiting" ? waitingLimit : undefined);
  const countFor = (stage: Stage) => cards.get(stage)?.length ?? 0;

  return (
    <MotionConfig reducedMotion="user">
      <DndContext
        id="today-queue-board"
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragMove={(event) => dragX.set(event.delta.x)}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: canDrag
              ? "Press Enter to open the details. Press Space to pick up the card, the arrow keys to move it to the next column, Space again to drop it, or Escape to cancel."
              : "Press Enter to open the details.",
          },
        }}
      >
        <LayoutGroup id="today-queue">
          <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
            {lanes ? (
              <ScrollArea className="min-h-0 flex-1 bg-muted/30" overscrollContain clampContentMinWidth={false}>
                <div className="grid min-w-max" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(16rem, 1fr))` }}>
                  {columns.map((column, index) => (
                    <div key={column.id} role="group" aria-labelledby={`queue-${column.id}`} className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm">
                      <ColumnHead column={column} count={countFor(column.id)} limit={limitFor(column.id)} menu={columnMenu?.(column, index)} add={addButton(column.id, true)} />
                    </div>
                  ))}
                  {shownLanes.map((lane) => {
                    const isCollapsed = collapsed.has(lane.id);
                    const total = columns.reduce((sum, column) => sum + laneCards(column.id, lane.id).length, 0);
                    return (
                      <Fragment key={lane.id}>
                        <div className="col-span-full border-b bg-background/60">
                          <button
                            type="button"
                            aria-expanded={!isCollapsed}
                            onClick={() => setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(lane.id)) next.delete(lane.id);
                              else next.add(lane.id);
                              return next;
                            })}
                            className="sticky start-0 flex items-center gap-2 px-3 py-2 text-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ChevronRight aria-hidden="true" className={cn("size-3.5 text-muted-foreground transition-transform", !isCollapsed && "rotate-90")} />
                            <PersonAvatar name={lane.name} image={lane.image} className="size-5 [&_[data-slot=avatar-fallback]]:text-[0.5625rem]" />
                            {lane.name}
                            <span className="text-muted-foreground tabular-nums">{total}</span>
                          </button>
                        </div>
                        {isCollapsed ? null : columns.map((column) => {
                          const id = targetId(column.id, lane.id);
                          return (
                            <DropZone key={id} id={id} drop={drop} aria-label={`${lane.name}, ${column.title}`} className="min-h-24 border-e border-b p-2 ring-1 ring-transparent ring-inset last:border-e-0">
                              <CardList {...shared} cards={laneCards(column.id, lane.id)} dropTarget={id} empty="" label={`${lane.name}, ${column.title}`} />
                            </DropZone>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </div>
                {!shownLanes.length ? <p className="p-6 text-center text-sm text-muted-foreground">No {t.visits} match.</p> : null}
              </ScrollArea>
            ) : (
              <ScrollAreaPrimitive.Root className="min-h-0 flex-1">
                <ScrollAreaPrimitive.Viewport className="size-full snap-x snap-mandatory scroll-px-3 rounded-[inherit] overscroll-x-contain outline-none xl:snap-none" data-slot="scroll-area-viewport">
                  <ScrollAreaPrimitive.Content
                    className={cn(
                      "flex h-full min-w-full gap-3 p-3",
                      // The columns settle in left to right. While the page itself is arriving, the dashboard sets
                      // --queue-offset so they wait for the blocks above; switching views later replays them at once.
                      "*:motion-safe:fade-in-0 *:motion-safe:slide-in-from-bottom-2 *:motion-safe:animate-in *:motion-safe:fill-mode-backwards *:motion-safe:duration-500 *:motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
                      "*:motion-safe:[--tw-animation-delay:var(--queue-offset,0ms)] [&>*:nth-child(2)]:motion-safe:[--tw-animation-delay:calc(var(--queue-offset,0ms)_+_60ms)] [&>*:nth-child(3)]:motion-safe:[--tw-animation-delay:calc(var(--queue-offset,0ms)_+_120ms)] [&>*:nth-child(4)]:motion-safe:[--tw-animation-delay:calc(var(--queue-offset,0ms)_+_180ms)] [&>*:nth-child(n+5)]:motion-safe:[--tw-animation-delay:calc(var(--queue-offset,0ms)_+_240ms)]",
                    )}
                  >
                  {columns.map((column, index) => {
                    const id = targetId(column.id);
                    const limit = limitFor(column.id);
                    const count = countFor(column.id);
                    return (
                      <DropZone
                        key={column.id}
                        id={id}
                        drop={drop}
                        overLimit={limit !== undefined && count > limit}
                        role="group"
                        aria-labelledby={`queue-${column.id}`}
                        className="flex w-[85vw] max-w-sm min-w-0 shrink-0 snap-start flex-col rounded-xl bg-muted/50 sm:w-72 xl:w-auto xl:max-w-none xl:flex-1"
                      >
                        <ColumnHead column={column} count={count} limit={limit} menu={columnMenu?.(column, index)} add={addButton(column.id, true)} />
                        <ScrollArea className="min-h-0 flex-1" overscrollContain>
                        <div className="px-2 pb-2">
                          <CardList
                            {...shared}
                            cards={cards.get(column.id) ?? []}
                            dropTarget={id}
                            empty={column.empty}
                            label={`${column.title} ${t.visits}`}
                            footer={addButton(column.id, false)}
                          />
                        </div>
                        </ScrollArea>
                      </DropZone>
                    );
                  })}
                  </ScrollAreaPrimitive.Content>
                </ScrollAreaPrimitive.Viewport>
                <ScrollBar orientation="horizontal" />
              </ScrollAreaPrimitive.Root>
            )}

            <AnimatePresence>
              {selected ? (
                <VisitPanel
                  key="visit-panel"
                  card={selected}
                  column={columns.find((column) => column.id === selected.stage)}
                  index={selectedIndex}
                  total={order.length}
                  onPrev={() => { const prev = order[selectedIndex - 1]; if (prev) setSelectedId(prev.appointment.id); }}
                  onNext={() => { const next = order[selectedIndex + 1]; if (next) setSelectedId(next.appointment.id); }}
                  onClose={close}
                  handlers={handlersFor(selected.appointment)}
                  clockIso={clockIso}
                  t={t}
                  currency={currency}
                  timing={timings[selected.appointment.id]}
                  rooms={props.roomsOf(selected.appointment)}
                  busy={busyId === selected.appointment.id}
                  panelRef={panelRef}
                />
              ) : null}
            </AnimatePresence>
          </div>
        </LayoutGroup>

        <DragOverlay dropAnimation={dropAnimation} zIndex={60}>
          {active ? (
            <motion.div
              style={{ rotate: reduce ? 0 : tilt }}
              initial={{ scale: 1 }}
              animate={{ scale: reduce ? 1 : 1.02 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className={cn(cardClass, "cursor-grabbing border-foreground/16 shadow-lg/10")}
            >
              <CardFace card={active} />
            </motion.div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </MotionConfig>
  );
}
