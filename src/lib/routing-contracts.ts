import { z } from "zod";

/** Team routing (feature 20): what the screens and the routes agree on. */

export const assignmentModes = ["customer_chooses", "any_available", "round_robin"] as const;
export const assignmentSchema = z.enum(assignmentModes);
export type AssignmentMode = z.infer<typeof assignmentSchema>;

export const assignmentLabels: Record<AssignmentMode, { label: string; hint: string }> = {
  customer_chooses: { label: "The customer chooses", hint: "They pick a person, or take anyone available." },
  any_available: { label: "Whoever is free", hint: "The first person in priority order, then whoever is furthest below their share." },
  round_robin: { label: "Take turns", hint: "Bookings rotate fairly by weight. Priority is ignored." },
};

const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const serviceRoutingSchema = z.object({
  assignment: assignmentSchema,
  preferReturningPerson: z.boolean(),
  people: z.array(z.object({
    practitionerId: id,
    priority: z.number().int().min(0).max(100),
    weight: z.number().int().min(1).max(100),
  }).strict()).max(200),
  expectedVersion: z.number().int().min(1),
}).strict();
export type ServiceRoutingInput = z.infer<typeof serviceRoutingSchema>;

export interface ServiceRoutingView {
  serviceId: string;
  serviceName: string;
  version: number;
  assignment: AssignmentMode;
  preferReturningPerson: boolean;
  people: Array<{ practitionerId: string; name: string; priority: number; weight: number }>;
}

/** A month's bookings per person, with the share each was meant to take. */
export interface TeamShareView {
  month: string;
  total: number;
  people: Array<{ practitionerId: string; name: string; bookings: number; sharePercent: number; weightPercent: number }>;
}

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export interface LeaveBookingView {
  appointmentId: string;
  version: number;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  customerName: string;
  /** Free at that time, so the move would succeed. Null when no cover person is set to check against. */
  coverFree: boolean | null;
}

export interface LeaveBookingsView {
  timeOffId: string;
  practitionerId: string;
  coverPractitionerId: string | null;
  coverName: string | null;
  bookings: LeaveBookingView[];
}

export const leaveReassignSchema = z.object({
  timeOffId: id,
  /** Defaults to the cover person on the time off. */
  toPractitionerId: id.optional(),
  /** Leave out to move every affected booking. */
  appointmentIds: z.array(id).max(200).optional(),
}).strict();
export type LeaveReassignInput = z.infer<typeof leaveReassignSchema>;

export interface LeaveReassignResult {
  moved: number;
  needsPerson: Array<{ appointmentId: string; reason: string }>;
}
