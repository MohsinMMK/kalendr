"use client";

import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Trash2, TriangleAlert } from "lucide-react";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import type { TermWords } from "@/lib/terminology";
import { FALLBACK_ID, routingLimits, type Destination, type Route, type RoutingBuilderOptions, type RoutingWarning } from "@/lib/routing-forms";

import { blankRoute, canAddRoute, moveItem, type WorkingDraft } from "./builder-state";
import { DestinationEditor } from "./destination-editor";
import { RouteConditions } from "./route-conditions";

export interface RoutesShared {
  draft: WorkingDraft;
  options: RoutingBuilderOptions;
  errors: Record<string, string>;
  warnings: readonly RoutingWarning[];
  disabled: boolean;
  terms: TermWords;
}

function Warnings({ warnings, routeId }: { warnings: readonly RoutingWarning[]; routeId: string }) {
  const mine = warnings.filter((warning) => warning.routeId === routeId);
  if (mine.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {mine.map((warning, at) => (
        <Alert key={at} variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>{warning.message}</AlertDescription></Alert>
      ))}
    </div>
  );
}

function RouteCard({ route, index, count, shared, onChange, onMove, onRemove }: {
  route: Route; index: number; count: number; shared: RoutesShared; onChange: (route: Route) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  const { draft, options, errors, warnings, disabled, terms } = shared;
  const number = index + 1;
  const id = `routing-route-${route.id}`;
  return (
    <FramePanel className="flex flex-col gap-4" role="group" aria-labelledby={`${id}-heading`}>
      <div className="flex items-center justify-between gap-2">
        <p id={`${id}-heading`} className="font-medium text-sm">Route {number} of {count}</p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Move route ${number} up`} disabled={disabled || index === 0} onClick={() => onMove(-1)}><ArrowUp aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Move route ${number} down`} disabled={disabled || index === count - 1} onClick={() => onMove(1)}><ArrowDown aria-hidden="true" /></Button>
          <Menu>
            <MenuTrigger render={<Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`More for route ${number}`} disabled={disabled} />}><MoreHorizontal aria-hidden="true" /></MenuTrigger>
            <MenuPopup align="end">
              <MenuItem variant="destructive" onClick={onRemove}><Trash2 aria-hidden="true" /> Remove route</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <Warnings warnings={warnings} routeId={route.id} />
      <TextField label="Route name" hint="Only you see this. It also appears in the report." value={route.name} maxLength={routingLimits.name} error={errors[`routes.${index}.name`]} disabled={disabled} onChange={(event) => onChange({ ...route, name: event.target.value })} />
      <RouteConditions routeIndex={index} conditions={route.conditions} questions={draft.questions} errors={errors} disabled={disabled} onChange={(conditions) => onChange({ ...route, conditions })} />
      <DestinationEditor idPrefix={id} destination={route.destination} options={options} questions={draft.questions} isFallback={false} errorBase={`routes.${index}.destination`} errors={errors} disabled={disabled} terms={terms}
        onChange={(destination) => onChange({ ...route, destination })} />
    </FramePanel>
  );
}

/** The ordered routes: the first whose conditions hold wins. Then the fallback, which catches everyone else. */
export function RoutesSection({ shared, onChange }: { shared: RoutesShared; onChange: (patch: Partial<Pick<WorkingDraft, "routes" | "fallback">>) => void }) {
  const { draft, options, errors, warnings, disabled, terms } = shared;
  const setRoute = (index: number, route: Route) => onChange({ routes: draft.routes.map((entry, at) => (at === index ? route : entry)) });
  return (
    <>
      <Frame>
        <FrameHeader>
          <FrameTitle>Routes</FrameTitle>
          <FrameDescription>{draft.routes.length} of {routingLimits.routes} routes. We check them from the top. The first one that fits sends the {terms.customer} on.</FrameDescription>
        </FrameHeader>
        {draft.routes.length === 0 ? <FramePanel><p className="text-muted-foreground text-sm">No routes yet. Everyone goes to the fallback below until you add one.</p></FramePanel> : null}
        {draft.routes.map((route, index) => (
          <RouteCard key={route.id} route={route} index={index} count={draft.routes.length} shared={shared} onChange={(next) => setRoute(index, next)}
            onMove={(by) => onChange({ routes: moveItem(draft.routes, index, by) })} onRemove={() => onChange({ routes: draft.routes.filter((_, at) => at !== index) })} />
        ))}
        <FrameFooter className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={disabled || !canAddRoute(draft)} onClick={() => onChange({ routes: [...draft.routes, blankRoute(options, draft.routes.length + 1)] })}>
            <Plus aria-hidden="true" /> Add a route
          </Button>
          {canAddRoute(draft) ? null : <p className="text-muted-foreground text-xs">A form can have up to {routingLimits.routes} routes.</p>}
        </FrameFooter>
      </Frame>
      <Frame>
        <FrameHeader>
          <FrameTitle>Fallback</FrameTitle>
          <FrameDescription>For anyone no route fits. Every form needs one before it can go live.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          <Warnings warnings={warnings} routeId={FALLBACK_ID} />
          <DestinationEditor idPrefix="routing-fallback" destination={draft.fallback} options={options} questions={draft.questions} isFallback errorBase="fallback" errors={errors} disabled={disabled} terms={terms}
            onChange={(fallback: Destination) => onChange({ fallback })} />
        </FramePanel>
      </Frame>
    </>
  );
}
