"use client";

import { MapPin } from "lucide-react";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Location } from "@/lib/domain";

import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

/**
 * What the invite and edit-access dialogs offer: the active locations, whether the field shows at all (two or more), and
 * whether "All locations" may be handed out (not by someone who is limited themselves).
 */
export function useMemberLocationChoices() {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const access = useStaffAccess();
  const locations = catalog.locations.filter((place) => place.isActive !== false);
  const me = staff?.snapshot?.team.find((member) => member.userId === access.userId);
  const myLocationIds = me?.locationIds && me.locationIds.length > 0 ? me.locationIds : [];
  // The server also defaults a limited person's invites to their own locations when the picker is hidden (fewer than two places).
  return { locations, show: locations.length >= 2, allowAll: myLocationIds.length === 0, myLocationIds };
}

/** The "all locations" row travels under this value, because Base UI reads an empty list as "nothing chosen". */
const ALL = "__all__";

/**
 * Which locations a team member works at. Nothing chosen means every location, which is the default and what owners always
 * have. Shown only when the business has two or more locations (the caller decides). Someone who is limited themselves can
 * hand out only their own locations, so `allowAll` is off for them.
 */
export function MemberLocationsField({ id, locations, value, onChange, allowAll = true, disabled, hint }: {
  id: string;
  locations: readonly Pick<Location, "id" | "name" | "address" | "city">[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  allowAll?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  const names = new Map(locations.map((place) => [place.id, place.name]));
  // A location that was switched off since is no longer in the list, but the person is still limited to it. It stays visible
  // here so it can be unticked; the server refuses to save a limit that names a switched-off location.
  const closed = value.filter((item) => !names.has(item));
  const shown = value.length === 0 && allowAll ? [ALL] : [...value];
  const items = [
    ...(allowAll ? [{ value: ALL, label: "All locations" }] : []),
    ...locations.map((place) => ({ value: place.id, label: place.name })),
    ...closed.map((item) => ({ value: item, label: "Closed location" })),
  ];
  return (
    <Field className="w-full">
      <FieldLabel htmlFor={id}>Locations</FieldLabel>
      <Select
        multiple
        items={items}
        value={shown}
        disabled={disabled}
        onValueChange={(next) => {
          const chosen = next as string[];
          // Picking "All locations" clears the rest; picking a place takes "All locations" off.
          if (allowAll && chosen.includes(ALL) && !shown.includes(ALL)) onChange([]);
          else onChange(chosen.filter((item) => item !== ALL));
        }}
      >
        <SelectTrigger id={id} size="lg" aria-label="Locations">
          <SelectValue>
            {(chosen: string[]) => chosen.length === 0 || chosen.includes(ALL)
              ? allowAll ? "All locations" : "Choose locations"
              : chosen.length <= 2 ? chosen.map((item) => names.get(item) ?? "A closed location").join(", ") : `${chosen.length} locations`}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {allowAll ? (
            <SelectItem value={ALL}>
              <span className="flex items-center gap-2"><MapPin aria-hidden="true" className="text-muted-foreground" /> All locations</span>
            </SelectItem>
          ) : null}
          {locations.map((place) => (
            <SelectItem key={place.id} value={place.id}>
              <span className="flex flex-col">
                <span>{place.name}</span>
                {place.address || place.city ? <span className="text-xs text-muted-foreground">{[place.address, place.city].filter(Boolean).join(", ")}</span> : null}
              </span>
            </SelectItem>
          ))}
          {closed.map((item) => (
            <SelectItem key={item} value={item}>Closed location</SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <FieldDescription>{closed.length > 0 ? "A closed location can't be kept. Untick it before saving." : hint ?? "They see and work with these locations only. Owners always see every location."}</FieldDescription>
    </Field>
  );
}
