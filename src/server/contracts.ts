import { z } from "zod";


import { customFieldValuesSchema } from "@/lib/visit-fields";
import { heardFromValues } from "@/lib/heard-from";

import { appointmentStatusSchema, dateOfBirthSchema, reasonForVisitSchema } from "@/lib/contracts";
import { businessTypeIds, featureKeys, resourceKinds, termKeys } from "@/lib/business-types";
import { declineReasons } from "@/lib/approval";
import { customerCancelReasons, MAX_NOTE_LENGTH } from "@/lib/cancel-policy";
import { limitOverrideReasons } from "@/lib/booking-limits";
import { clockModes } from "@/lib/booking-page";
import { bookingLocationChoiceSchema } from "@/lib/service-setup";
import { assignableRoles, permissionKeys } from "@/lib/permissions";
import { maxTermLength, roleNameKeys } from "@/lib/terminology";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);

export const availabilityQuerySchema = z
  .object({
    clinicSlug: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    locationId: identifierSchema,
    serviceId: identifierSchema,
    practitionerId: identifierSchema.default("first_available"),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    /** One of the service's lengths. Defaults to the service's usual length. */
    durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
    /** Moving a booked visit: list openings for its own length even if the service no longer offers it. */
    keepLength: z.literal("1").optional(),
    /** A hold this visitor already has (a link an assistant made, feature 54): its own time is listed as open for them. */
    holdToken: z.string().trim().min(20).max(200).optional(),
    /** A routing form's token (feature 46): only the people the form picked are listed. */
    routingToken: z.string().trim().regex(/^[A-Za-z0-9_-]{20,200}$/).optional(),
    /** A combined link's address (feature 45): only times when everyone on the link is free. */
    combo: z.string().trim().max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  })
  .superRefine((value, context) => {
    if (!value.from && !value.to) return;
    if (!value.from || !value.to) {
      context.addIssue({
        code: "custom",
        path: [value.from ? "to" : "from"],
        message: "from and to must be provided together",
      });
      return;
    }
    const from = new Date(value.from);
    const to = new Date(value.to);
    const rangeMilliseconds = to.getTime() - from.getTime();
    if (rangeMilliseconds <= 0) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be after from",
      });
    }
    if (rangeMilliseconds > 31 * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "availability ranges cannot exceed 31 days",
      });
    }
  });

/** The one thing a customer may add to their booking afterwards: how they found the business. */
export const heardFromAnswerSchema = z.strictObject({
  heardFrom: z.enum(heardFromValues),
});

export const manageAppointmentActionSchema = z
  .object({
    action: z.enum(["confirm", "cancel", "reschedule", "edit_guests"]),
    /** Older clients sent free text here; it is read as the note. */
    reason: z.string().trim().min(3).max(300).optional(),
    /** Why the customer is cancelling, from a short fixed list (feature 42). */
    reasonCode: z.enum(customerCancelReasons).optional(),
    /** An optional note with a cancel or a move. Sealed on the booking and shown only to staff. */
    note: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    /** Moving to another person's time, when the service lets customers do that. */
    practitionerId: identifierSchema.optional(),
    /** The whole guest list after the change, for `edit_guests`. */
    guests: z.array(z.email().max(254)).max(10).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    if (value.action === "edit_guests" && !value.guests) {
      context.addIssue({ code: "custom", path: ["guests"], message: "guests is required when editing guests" });
    }
    if (value.action === "reschedule" && !value.startsAt) {
      context.addIssue({
        code: "custom",
        path: ["startsAt"],
        message: "startsAt is required when rescheduling",
      });
    }
  });

export const staffAppointmentStatusSchema = z.object({
  status: appointmentStatusSchema,
  reason: z.string().trim().min(3).max(300).optional(),
  expectedVersion: z.number().int().positive(),
});

export const staffBookingSchema = z.object({
  clinicSlug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  locationId: identifierSchema,
  serviceId: identifierSchema,
  practitionerId: identifierSchema,
  startsAt: z.iso.datetime({ offset: true }),
  /** One of the service's lengths. Defaults to the usual one. */
  durationMinutes: z.number().int().min(5).max(480).optional(),
  /** How the customer will meet, when the service offers more than one way. */
  locationChoice: bookingLocationChoiceSchema.optional(),
  /** Staff chose to go past a booking limit. A fixed choice, so no free text reaches the audit trail. */
  limitOverrideReason: z.enum(limitOverrideReasons).optional(),
  /** A discount code, or a package credit to spend, applied at the desk (feature 25). One or the other. */
  couponCode: z.string().trim().min(1).max(40).optional(),
  customerPackageId: identifierSchema.optional(),
  /** phone: booked on a call. desk: booked in person for later. walk_in: here now, checked in on save. */
  source: z.enum(["phone", "desk", "walk_in"]).default("desk"),
  /** false: no confirmation or reminder goes out for this booking (a data import, feature 12). */
  notifyCustomer: z.boolean().optional(),
  reasonForVisit: reasonForVisitSchema.optional(),
  /** Staff-only notes on the visit, and the values of the business's own properties. */
  notes: z.string().trim().max(2000).optional(),
  customFields: customFieldValuesSchema.optional(),
  patientId: identifierSchema.optional(),
  /** Set when staff rebook an earlier visit, so history stays linked (feature 42). Checked inside the business by a foreign key. */
  rebookedFromId: identifierSchema.optional(),
  newPatient: z.object({
    firstName: z.string().trim().min(1).max(80),
    /** A walk-in can be added with a first name and phone only. */
    lastName: z.string().trim().max(80).default(""),
    phone: z.string().trim().min(7).max(32),
    email: z.union([z.email().max(254), z.literal("")]).default(""),
    dateOfBirth: dateOfBirthSchema.optional(),
    preferredChannel: z.enum(["sms", "email", "whatsapp", "phone"]),
    accessibilityNeed: z.string().trim().max(500).optional(),
    isDependent: z.boolean().default(false),
    messagingConsent: z.boolean().default(false),
  }).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.patientId) === Boolean(value.newPatient)) {
    context.addIssue({
      code: "custom",
      path: ["patientId"],
      message: "Provide exactly one existing person or new person.",
    });
  }
  if (value.newPatient && value.source !== "walk_in") {
    if (!value.newPatient.email) context.addIssue({ code: "custom", path: ["newPatient", "email"], message: "Enter an email address." });
  }
  if (value.newPatient?.preferredChannel === "email" && !value.newPatient.email) {
    context.addIssue({ code: "custom", path: ["newPatient", "preferredChannel"], message: "Choose a channel the customer can be reached on." });
  }
});

/** How staff took a booking themselves. These can be corrected later; online sources cannot. */
export const staffBookingSources = ["phone", "staff", "walk_in"] as const;
/** Shortest and longest a visit can be made by dragging its end. A service sets the usual length. */
export const resizeMinutes = { min: 5, max: 480 } as const;

export const staffAppointmentMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["reschedule", "suggest"]),
    startsAt: z.iso.datetime({ offset: true }),
    practitionerId: identifierSchema,
    /** Moves the visit to another service at the same time; its length and price follow the new service. */
    serviceId: identifierSchema.optional(),
    /** Keeps the visit in this room (or other resource) instead of the first free one. */
    resourceId: identifierSchema.optional(),
    /** Staff chose to go past a booking limit. A fixed choice, so no free text reaches the audit trail. */
    limitOverrideReason: z.enum(limitOverrideReasons).optional(),
    expectedVersion: z.number().int().positive(),
    /** False when staff chose not to tell the customer about the new time. Recorded for the worker; defaults to telling them. */
    notifyCustomer: z.boolean().optional(),
  }),
  z.object({
    // Dragging the bottom edge: the start and the staff member stay, only the length changes.
    action: z.literal("resize"),
    endsAt: z.iso.datetime({ offset: true }),
    expectedVersion: z.number().int().positive(),
    notifyCustomer: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("form_received"),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("start"),
    expectedVersion: z.number().int().positive(),
  }),
  /** A request is accepted, optionally at one of the times the customer offered (feature 41). */
  z.object({
    action: z.literal("approve"),
    chosenStart: z.iso.datetime({ offset: true }).optional(),
    expectedVersion: z.number().int().positive(),
  }),
  /** A request is turned down. The reason is a fixed code; the message goes to the customer only. */
  z.object({
    action: z.literal("decline"),
    reason: z.enum(declineReasons),
    message: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().positive(),
  }),
  /** Staff free the slot and ask the customer to choose another time, keeping this booking and its history (feature 42). */
  z.object({
    action: z.literal("request_reschedule"),
    /** Shown to the customer in the message. It travels in the outbox, never in the audit trail. */
    message: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
    expectedVersion: z.number().int().positive(),
  }),
  /** Staff cancel with a quick reason. A preset gives the reason code; a note is for staff only. */
  z.object({
    action: z.literal("cancel"),
    presetId: identifierSchema.optional(),
    note: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
    /** False when staff chose not to tell the customer. Recorded for the worker; defaults to telling them. */
    notifyCustomer: z.boolean().optional(),
    expectedVersion: z.number().int().positive(),
  }),
  /** Book a cancelled or past visit again at a new time. A new booking is made and linked to this one. */
  z.object({
    action: z.literal("rebook"),
    startsAt: z.iso.datetime({ offset: true }),
    practitionerId: identifierSchema.optional(),
    expectedVersion: z.number().int().positive(),
  }),
  /** Give a booking to another person at the same time (feature 43). */
  z.object({
    action: z.literal("reassign"),
    practitionerId: identifierSchema,
    expectedVersion: z.number().int().positive(),
  }),
  /** Change how and where it happens; the choice must be one the service offers. */
  z.object({
    action: z.literal("edit_location"),
    locationChoice: bookingLocationChoiceSchema,
    expectedVersion: z.number().int().positive(),
  }),
  /** Flag a booking as spam (feature 44): it and its open repeats are cancelled quietly and a report opens for review. */
  z.object({
    action: z.literal("report_spam"),
    reasonCode: z.enum(["fake_details", "abusive", "duplicate", "other"]),
    expectedVersion: z.number().int().positive(),
  }),
  /** Record who did not turn up: the customer, or the business (the customer is offered a free rebook). */
  z.object({
    action: z.literal("mark_no_show"),
    who: z.enum(["customer", "host"]).default("customer"),
    expectedVersion: z.number().int().positive(),
  }),
  /** Replace the guest list (feature 40's guests) on a booking that has not started. */
  z.object({
    action: z.literal("edit_guests"),
    guests: z.array(z.email().max(254)).max(10),
    expectedVersion: z.number().int().positive(),
  }),
  /** Edit the visit in place. An empty reason or note clears it; custom fields merge, and an empty value removes its key. */
  z.object({
    action: z.literal("details"),
    reasonForVisit: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(2000).optional(),
    customFields: customFieldValuesSchema.optional(),
    /** Only the ways staff take a booking themselves can be corrected; online sources are recorded facts. */
    bookingSource: z.enum(staffBookingSources).optional(),
    expectedVersion: z.number().int().positive(),
  }).refine(
    (value) => value.reasonForVisit !== undefined || value.notes !== undefined || value.customFields !== undefined || value.bookingSource !== undefined,
    { message: "Change at least one detail.", path: ["reasonForVisit"] },
  ),
]);

export const staffPatientSearchSchema = z.object({
  q: z.string().trim().max(80).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const staffServiceModesSchema = z.object({
  serviceModes: z.record(identifierSchema, z.enum(["instant", "request"])).refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 80,
    { message: "Choose at least one service to update." },
  ),
});

const localTimeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Use 24-hour time such as 09:00.");

function refineTimeOrder(
  start: string,
  end: string,
  context: z.RefinementCtx,
  path: Array<string | number>,
  message = "End time must be after start time.",
): void {
  if (end <= start) {
    context.addIssue({ code: "custom", path, message });
  }
}

function refineBreak(
  start: string,
  end: string,
  breakStart: string | undefined,
  breakEnd: string | undefined,
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): void {
  if (!breakStart && !breakEnd) return;
  if (!breakStart || !breakEnd) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, breakStart ? "breakEndsAtLocal" : "breakStartsAtLocal"],
      message: "Set both lunch start and end.",
    });
    return;
  }
  if (breakEnd <= breakStart) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "breakEndsAtLocal"],
      message: "Lunch must end after it starts.",
    });
  }
  if (breakStart <= start || breakEnd >= end) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "breakStartsAtLocal"],
      message: "Lunch must fall inside working hours.",
    });
  }
}

export const workingHourWindowSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  startsAtLocal: localTimeSchema,
  endsAtLocal: localTimeSchema,
  breakStartsAtLocal: localTimeSchema.optional(),
  breakEndsAtLocal: localTimeSchema.optional(),
}).superRefine((value, context) => {
  refineTimeOrder(value.startsAtLocal, value.endsAtLocal, context, ["endsAtLocal"]);
  refineBreak(value.startsAtLocal, value.endsAtLocal, value.breakStartsAtLocal, value.breakEndsAtLocal, context);
});

export const workingHoursSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  startsAtLocal: localTimeSchema.optional(),
  endsAtLocal: localTimeSchema.optional(),
  breakStartsAtLocal: localTimeSchema.optional(),
  breakEndsAtLocal: localTimeSchema.optional(),
  windows: z.array(workingHourWindowSchema).min(1).max(7).optional(),
}).superRefine((value, context) => {
  const hasWindows = Boolean(value.windows?.length);
  const hasDays = Boolean(value.days?.length && value.startsAtLocal && value.endsAtLocal);
  if (!hasWindows && !hasDays) {
    context.addIssue({
      code: "custom",
      path: ["days"],
      message: "Set working hours for at least one day.",
    });
    return;
  }
  if (hasWindows && hasDays) {
    context.addIssue({
      code: "custom",
      path: ["windows"],
      message: "Set weekly hours or per-day hours, not both.",
    });
    return;
  }
  if (!hasDays) return;
  refineTimeOrder(value.startsAtLocal!, value.endsAtLocal!, context, ["endsAtLocal"]);
  if (new Set(value.days).size !== value.days!.length) {
    context.addIssue({
      code: "custom",
      path: ["days"],
      message: "Choose each weekday only once.",
    });
  }
  refineBreak(value.startsAtLocal!, value.endsAtLocal!, value.breakStartsAtLocal, value.breakEndsAtLocal, context);
});

/** A small square photo as a data URL. SVG is excluded because it can carry scripts. */
export const practitionerPhotoSchema = z
  .string()
  .max(120_000, "That photo is too large.")
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, "Use a JPEG, PNG or WebP photo.");

const practitionerProfileFields = {
  photoDataUrl: practitionerPhotoSchema.nullable().optional(),
  bio: z.string().trim().max(600).optional(),
  qualifications: z.string().trim().max(200).optional(),
  registrationNumber: z.string().trim().max(60).optional(),
  experienceYears: z.number().int().min(0).max(70).nullable().optional(),
  languages: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
};

/** An email for a bookable person who has no login yet; they get an invite to choose their own password. */
export const staffPractitionerLoginSchema = z.object({ email: z.email().max(254) }).strict();

export const staffCreatePractitionerSchema = z.object({
  ...practitionerProfileFields,
  attachToCurrentUser: z.boolean().default(false),
  name: z.string().trim().min(2).max(160),
  title: z.string().trim().min(2).max(120),
  specialty: z.string().trim().min(2).max(160),
  initials: z.string().trim().min(1).max(12).optional(),
  email: z.email().max(254).optional(),
  locationIds: z.array(identifierSchema).min(1).max(20),
  serviceIds: z.array(identifierSchema).min(1).max(40),
  hours: workingHoursSchema,
}).superRefine((value, context) => {
  if (value.attachToCurrentUser) return;
  if (!value.email) {
    context.addIssue({ code: "custom", path: ["email"], message: "A work email is required." });
  }
});

export const staffUpdatePractitionerSchema = z.object({
  ...practitionerProfileFields,
  name: z.string().trim().min(2).max(160).optional(),
  title: z.string().trim().min(2).max(120).optional(),
  specialty: z.string().trim().min(2).max(160).optional(),
  isActive: z.boolean().optional(),
  locationIds: z.array(identifierSchema).min(1).max(20).optional(),
  serviceIds: z.array(identifierSchema).min(1).max(40).optional(),
  hours: workingHoursSchema.optional(),
});

// One optional on/off switch per permission. An explicit object rather than z.partialRecord:
// the dev server's bundled zod treated the enum-keyed record as exhaustive and asked for every key.
const permissionOverridesSchema = z.strictObject(
  Object.fromEntries(permissionKeys.map((key) => [key, z.boolean().optional()])) as Record<(typeof permissionKeys)[number], z.ZodOptional<z.ZodBoolean>>,
);

/** A job title is free text, at most 80 characters. Blank means none, so the form can clear it. */
/** One line: line breaks and control characters become single spaces before the length is checked. */
export const jobTitleSchema = z.string().transform((value) => value.replace(/[\s\p{Cc}]+/gu, " ").trim()).pipe(z.string().max(80)).transform((value) => value || null).nullable();

/** The locations a team member is limited to. Empty or left out means every location. */
export const memberLocationIdsSchema = z.array(identifierSchema).max(50);

export const staffCreateMemberSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.email().max(254),
  role: z.enum(["admin", "receptionist", "billing", "read_only"]),
  permissionOverrides: permissionOverridesSchema.optional(),
  jobTitle: jobTitleSchema.optional(),
  locationIds: memberLocationIdsSchema.optional(),
});

export const staffUpdateMemberSchema = z.object({
  isActive: z.boolean().optional(),
  role: z.enum(assignableRoles).optional(),
  permissionOverrides: permissionOverridesSchema.optional(),
  /** A custom role (feature 53), or null to go back to a built-in role. Setting one also sets the role to the custom role's base. */
  customRoleId: z.string().trim().min(1).max(64).nullable().optional(),
  /** What the person is called in the business. Blank or null clears it. */
  jobTitle: jobTitleSchema.optional(),
  /** Limits the person to these locations; an empty list lifts the limit. */
  locationIds: memberLocationIdsSchema.optional(),
}).refine((value) => value.isActive !== undefined || value.role !== undefined || value.permissionOverrides !== undefined || value.customRoleId !== undefined || value.jobTitle !== undefined || value.locationIds !== undefined, {
  message: "Nothing to change.",
});

/** Hands the business to another active person. The target is a membership id from the team list. */
export const staffTransferOwnershipSchema = z.object({
  membershipId: z.string().trim().min(1).max(64),
}).strict();

/** Links a team login to a doctor/stylist profile that has no login yet. */
export const staffLinkProfileSchema = z.object({
  practitionerId: z.string().trim().min(1).max(64),
}).strict();

export const staffSelfUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  jobTitle: jobTitleSchema.optional(),
  profile: z.object({
    ...practitionerProfileFields,
    title: z.string().trim().min(2).max(120).optional(),
    specialty: z.string().trim().min(2).max(160).optional(),
  }).optional(),
  hours: workingHoursSchema.optional(),
});

export const staffCreateServiceSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(2).max(500),
  durationMinutes: z.number().int().min(5).max(480),
  bookingMode: z.enum(["instant", "request"]).default("instant"),
  requiredResourceKind: z.enum(resourceKinds).nullable().optional(),
  priceLabel: z.string().trim().max(80).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  locationIds: z.array(identifierSchema).min(1).max(20).optional(),
  practitionerIds: z.array(identifierSchema).max(40).optional(),
});

export {
  serviceSetupSchema,
  serviceSetupUpdateSchema,
  type ServiceSetup,
  type ServiceSetupUpdate,
} from "@/lib/service-setup";

export const staffUpdateServiceSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().min(2).max(500).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  bookingMode: z.enum(["instant", "request"]).optional(),
  isActive: z.boolean().optional(),
  priceLabel: z.string().trim().max(80).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  requiredResourceKind: z.enum(resourceKinds).nullable().optional(),
  locationIds: z.array(identifierSchema).min(1).max(20).optional(),
  practitionerIds: z.array(identifierSchema).max(40).optional(),
}).refine(
  (value) => Object.values(value).some((entry) => entry !== undefined),
  { message: "Choose a service change to save." },
);

const scheduleBlockFields = z.object({
  practitionerId: identifierSchema.optional().nullable(),
  locationId: identifierSchema.optional().nullable(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().max(200).default(""),
});

function endAfterStart(
  value: { startsAt: string; endsAt: string },
  context: z.RefinementCtx,
) {
  if (new Date(value.endsAt).getTime() <= new Date(value.startsAt).getTime()) {
    context.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "End time must be after start time.",
    });
  }
}

export const staffCreateScheduleBlockSchema = scheduleBlockFields.superRefine(endAfterStart);

/** Editing a closed time sends the whole block again, so the same rules apply as when it was made. */
export const staffUpdateScheduleBlockSchema = scheduleBlockFields.superRefine(endAfterStart);

export const staffCreateResourceSchema = z.object({
  name: z.string().trim().min(2).max(160),
  kind: z.enum(resourceKinds),
  locationId: identifierSchema.optional(),
});

export const staffUpdateResourceSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  isActive: z.boolean().optional(),
}).refine(
  (value) => Object.values(value).some((entry) => entry !== undefined),
  { message: "Choose a change to save." },
);

export const staffClinicProfileSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  legalName: z.string().trim().min(2).max(200).optional(),
  phone: z.string().trim().min(7).max(32).optional(),
  city: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().min(4).max(300).optional(),
  /** The name of the first location, the one the address and city belong to. */
  locationName: z.string().trim().min(2).max(160).optional(),
  /** The public description on the business page. Empty clears it. */
  about: z.string().trim().max(1500).nullable().optional(),
});

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type BookingContactChange = z.infer<typeof bookingContactChangeSchema>;
export type ManageAppointmentAction = z.infer<
  typeof manageAppointmentActionSchema
>;
export type StaffAppointmentStatusInput = z.infer<
  typeof staffAppointmentStatusSchema
>;
export type StaffBookingInput = z.infer<typeof staffBookingSchema>;
export type StaffAppointmentMutation = z.infer<typeof staffAppointmentMutationSchema>;
/** The actions `mutateStaffAppointment` itself handles. The rest go through `src/server/staff-transitions.ts`. */
export type CoreStaffAppointmentMutation = Exclude<StaffAppointmentMutation, { action: "approve" | "decline" | "request_reschedule" | "cancel" | "rebook" | "edit_guests" | "reassign" | "edit_location" | "mark_no_show" | "report_spam" }>;
export type StaffServiceModesInput = z.infer<typeof staffServiceModesSchema>;
export type StaffCreatePractitionerInput = z.infer<typeof staffCreatePractitionerSchema>;
export type StaffUpdatePractitionerInput = z.infer<typeof staffUpdatePractitionerSchema>;
export type StaffCreateMemberInput = z.infer<typeof staffCreateMemberSchema>;
export type StaffUpdateMemberInput = z.infer<typeof staffUpdateMemberSchema>;
export type StaffSelfUpdateInput = z.infer<typeof staffSelfUpdateSchema>;
export type StaffCreateServiceInput = z.infer<typeof staffCreateServiceSchema>;
export type StaffUpdateServiceInput = z.infer<typeof staffUpdateServiceSchema>;
export type StaffUpdateResourceInput = z.infer<typeof staffUpdateResourceSchema>;
export type StaffUpdateScheduleBlockInput = z.infer<typeof staffUpdateScheduleBlockSchema>;
export type StaffCreateResourceInput = z.infer<typeof staffCreateResourceSchema>;
export type StaffClinicProfileInput = z.infer<typeof staffClinicProfileSchema>;
export type StaffCreateScheduleBlockInput = z.infer<typeof staffCreateScheduleBlockSchema>;
export type WorkingHoursInput = z.infer<typeof workingHoursSchema>;

export const portalCodeRequestSchema = z.object({
  kind: z.enum(["email", "phone"]),
  contact: z.string().trim().min(5).max(254),
  /** "text" skips WhatsApp, for a customer whose WhatsApp code never arrived. */
  via: z.enum(["text"]).optional(),
}).strict();

export const portalCodeVerifySchema = portalCodeRequestSchema.omit({ via: true }).extend({
  code: z.string().regex(/^[0-9]{6}$/),
  /** "Remember this device for 30 days": the session lasts 30 days instead of 24 hours. */
  remember: z.boolean().optional(),
}).strict();

/** What a manage-link holder is trying to do, so the code they are sent can be tied to it (feature 8). */
export const stepUpRequestSchema = z.object({
  action: z.enum(["cancel", "reschedule", "contact"]),
}).strict();

export const stepUpVerifySchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
}).strict();

/** New contact details for the booking's customer. Each is checked against the normal contact rules in the route. */
export const bookingContactChangeSchema = z.object({
  phone: z.string().trim().min(5).max(32).optional(),
  email: z.string().trim().min(5).max(254).optional(),
}).strict().refine((value) => value.phone !== undefined || value.email !== undefined, { message: "Give a phone number or an email address." });

const recordIdSchema = z.string().trim().min(1).max(120);

export const portalIdentitySchema = z.object({
  clinicSlug: z.string().trim().min(1).max(80),
  patientId: recordIdSchema,
  dateOfBirth: z.iso.date().optional(),
}).strict();

export const visitRecordInputSchema = z.object({
  patientId: recordIdSchema,
  appointmentId: recordIdSchema.nullable(),
  kind: z.enum(["note", "report", "prescription"]),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(20_000),
}).strict();

export const visitRecordPatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("share") }).strict(),
  z.object({ action: z.literal("withdraw") }).strict(),
  z.object({
    action: z.literal("edit"),
    kind: z.enum(["note", "report", "prescription"]),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(20_000),
  }).strict(),
]);

const termOverrideSchema = z.object({
  singular: z.string().trim().max(40).optional(),
  plural: z.string().trim().max(40).optional(),
}).strict();

export const staffBusinessProfileSchema = z.object({
  businessType: z.enum(businessTypeIds),
  terminology: z.partialRecord(z.enum(termKeys), termOverrideSchema),
  features: z.partialRecord(z.enum(featureKeys), z.boolean()),
  /** The business's own names for its staff roles. Left out means unchanged; a blank name puts the standard one back. */
  roleNames: z.partialRecord(z.enum(roleNameKeys), z.string().trim().max(maxTermLength)).optional(),
  /** How the booking page writes times, for every service. Left out means unchanged. */
  defaultClock: z.enum(clockModes).optional(),
  /** First day of the week on the booking page: 1 is Monday, 7 is Sunday. Left out means unchanged. */
  weekStart: z.union([z.literal(1), z.literal(7)]).optional(),
}).strict();
export type StaffBusinessProfileInput = z.infer<typeof staffBusinessProfileSchema>;
