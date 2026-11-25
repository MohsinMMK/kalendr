"use client";

import { useState } from "react";
import { Check, DoorOpen, Ellipsis } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { Resource } from "@/lib/domain";
import { resourceKindLabel } from "@/lib/terminology";

import { BookingLimitsDialog } from "./booking-limits-panel";
import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

/** The body of a rename or switch on or off, shared with the tests. */
export function resourceUpdateBody(change: { name?: string; isActive?: boolean }) {
  return {
    ...(change.name !== undefined ? { name: change.name.trim() } : {}),
    ...(change.isActive !== undefined ? { isActive: change.isActive } : {}),
  };
}

function ResourceRow({ resource, locationLabel, onMessage }: { resource: Resource; locationLabel: string; onMessage: (value: string) => void }) {
  const staff = useOptionalStaffSnapshot();
  const [name, setName] = useState(resource.name);
  const [pending, setPending] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const active = resource.isActive !== false;
  const dirty = name.trim() !== resource.name && name.trim().length >= 2;

  async function save(change: { name?: string; isActive?: boolean }, done: string) {
    setPending(true);
    onMessage("");
    try {
      await staffMutation(`/api/staff/resources/${resource.id}`, "PATCH", resourceUpdateBody(change));
      await staff?.refresh();
      toastManager.add({ title: done, type: "success" });
    } catch (cause: unknown) {
      onMessage(cause instanceof Error ? cause.message : "Could not save this change.");
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Name of ${resource.name}`}
          value={name}
          maxLength={160}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty) void save({ name }, "Saved.");
            if (event.key === "Escape") setName(resource.name);
          }}
          className="min-w-0 flex-1"
        />
        {dirty ? (
          <Button size="icon" variant="outline" aria-label={`Save name for ${resource.name}`} disabled={pending} onClick={() => void save({ name }, "Saved.")}>
            {pending ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" />}
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger render={<Button size="icon" variant="ghost" aria-label={`More for ${resource.name}`} disabled={pending} />}>
            <Ellipsis aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void save({ isActive: !active }, active ? `${resource.name} is no longer offered.` : `${resource.name} is offered again.`)}>
              {active ? "Stop using" : "Use again"}
            </MenuItem>
            <MenuItem onClick={() => setLimitsOpen(true)}>Booking limits…</MenuItem>
          </MenuPopup>
        </Menu>
        <BookingLimitsDialog open={limitsOpen} onOpenChange={setLimitsOpen} scope="resource" scopeId={resource.id} label={resource.name} />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>{resourceKindLabel(resource.kind)}</span>
        {locationLabel ? <span>· {locationLabel}</span> : null}
        {!active ? <Badge variant="outline" size="sm">Not in use</Badge> : null}
      </p>
    </li>
  );
}

/** Lists every room or chair so it can be renamed or switched off. New ones are made while setting up a service. */
export function ResourcesSettings() {
  const catalog = useCatalogLookups();
  const t = useTerms();
  const profile = useBusinessProfile();
  const [message, setMessage] = useState("");
  const clinical = isClinicalBusinessType(profile.businessType);
  const title = clinical ? "Rooms and chairs" : t.Resources;
  const manyLocations = catalog.locations.length > 1;

  return (
    <Frame>
      <FrameHeader>
        <h3 className="text-sm font-semibold">{title}</h3>
        <FrameDescription className="text-xs">
          Rename one, or stop using it. A {t.resource} that is not in use is left out of new {t.appointments}; past ones keep their record.
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="py-1">
        {message ? <Alert variant="error" className="my-2"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {catalog.resources.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><DoorOpen aria-hidden="true" /></EmptyMedia>
              <EmptyDescription>No {title.toLowerCase()} yet. Add one while setting up a {t.service} that needs it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {catalog.resources.map((resource) => (
              <ResourceRow
                key={`${resource.id}-${resource.name}-${resource.isActive}`}
                resource={resource}
                locationLabel={manyLocations ? catalog.locationName(resource.locationId) : ""}
                onMessage={setMessage}
              />
            ))}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}
