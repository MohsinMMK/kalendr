"use client";

import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { PersonSchedules } from "./person-schedules";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { TimeOffScreen } from "./time-off-panel";
import { TravelPanel } from "./travel-panel";

/**
 * Everything feature 37 adds to the Hours settings: named schedules with several ranges a day and
 * date changes, public holidays, out of office and travel. The simple weekly editor above it
 * keeps working and edits the default schedule.
 */
export function AvailabilityExtras() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  if (!catalog.database || catalog.practitioners.length === 0) return null;
  const rules = staff?.snapshot?.availability ?? [];
  return (
    <section className="flex flex-col gap-4" aria-labelledby="schedules-heading">
      <div>
        <h2 id="schedules-heading" className="text-sm font-semibold">Schedules and dates</h2>
        <p className="text-xs text-muted-foreground">Several ranges in a day, different hours on certain dates, public holidays, time away and travel. Changes apply to new bookings; existing {t.visits} stay where they are.</p>
      </div>
      {catalog.practitioners.map((person) => (
        // The simple editor above rewrites the default schedule, so a change there reloads this list.
        <PersonSchedules
          key={`${person.id}-${JSON.stringify(rules.filter((rule) => rule.practitionerId === person.id))}`}
          practitionerId={person.id}
          name={person.name}
          title={person.title}
        />
      ))}
      <TimeOffScreen />
      <TravelPanel />
    </section>
  );
}
