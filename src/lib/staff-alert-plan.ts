import { resolvePermissions, type PermissionOverrides, type StaffRole } from "./permissions";
import { quietUntil } from "./quiet-hours";
import { mayReceiveAlert, type AlertKind } from "./staff-alerts";

/** What each channel does when a person has not chosen: everyone gets the bell; a practitioner's own bookings also push. Nobody gets an email per alert. */
export function defaultChannels(role: StaffRole): { inApp: boolean; push: boolean; email: boolean } {
  return { inApp: true, push: role === "practitioner", email: false };
}

export interface PlanMember {
  id: string;
  userId: string;
  role: StaffRole;
  overrides: PermissionOverrides;
  /** The permission keys of the person's custom role, when they have one (feature 53). */
  customPermissions?: readonly string[] | null | undefined;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  /** What this person chose for this kind. Missing means the defaults above. */
  choice: { inApp: boolean; push: boolean; email: boolean } | null;
  hasPushDevice: boolean;
}

export interface PlanInput {
  kind: AlertKind;
  members: PlanMember[];
  /** The person who did it, so they are not told about their own action. */
  exceptUserId?: string | null | undefined;
  /** The sign-in of the person the appointment is with, when it is about one. A practitioner hears only about their own. */
  appointmentPractitionerUserId?: string | null | undefined;
  /** True when the alert is about one appointment (so "the person it is with" applies). */
  aboutAppointment: boolean;
  now: Date;
  timeZone: string;
}

export interface PlannedAlert {
  membershipId: string;
  inApp: boolean;
  /** When the push may go, or null for no push. */
  push: { availableAt: Date } | null;
  email: { availableAt: Date } | null;
}

/**
 * Who is told, and by which channel (feature 56). People who could not open the appointment under their permissions are never
 * told; a practitioner hears about their own appointments only; push and email wait out quiet hours while the bell never does.
 * Pure, so the web app and the worker share it.
 */
export function planStaffAlert(input: PlanInput): PlannedAlert[] {
  const planned: PlannedAlert[] = [];
  for (const member of input.members) {
    if (member.userId === input.exceptUserId) continue;
    if (!mayReceiveAlert(resolvePermissions(member.role, member.overrides, member.customPermissions), input.kind)) continue;
    if (input.aboutAppointment && member.role === "practitioner" && member.userId !== input.appointmentPractitionerUserId) continue;
    const channels = member.choice ?? defaultChannels(member.role);
    const quiet = quietUntil(input.now, input.timeZone, member.quietStartMinute, member.quietEndMinute);
    const availableAt = quiet ?? input.now;
    planned.push({
      membershipId: member.id,
      inApp: channels.inApp,
      push: channels.push && member.hasPushDevice ? { availableAt } : null,
      email: channels.email ? { availableAt } : null,
    });
  }
  return planned.filter((entry) => entry.inApp || entry.push || entry.email);
}
