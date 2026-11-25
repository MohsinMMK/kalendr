import { z } from "zod";

/** The two switches lane B adds to a service. Each is saved alone, so a request may carry either or both. */
export const serviceBookingOptionsSchema = z.object({
  optimizedSlots: z.boolean(),
  rebookFromOldLink: z.boolean(),
});
export type ServiceBookingOptions = z.infer<typeof serviceBookingOptionsSchema>;

export const serviceBookingOptionsInputSchema = serviceBookingOptionsSchema.partial().refine(
  (value) => value.optimizedSlots !== undefined || value.rebookFromOldLink !== undefined,
  { message: "Choose a setting to change." },
);
export type ServiceBookingOptionsInput = z.infer<typeof serviceBookingOptionsInputSchema>;
