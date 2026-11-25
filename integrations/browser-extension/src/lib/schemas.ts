import { z } from "zod";

/** What the Kalendr API sends the extension. Every reply is checked before it is drawn, so a changed server cannot put markup or surprises on screen. */

const data = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export const meSchema = data(z.object({ businessName: z.string(), businessSlug: z.string(), scopes: z.array(z.string()) }));

export const servicesSchema = data(z.array(z.object({
  id: z.string(), name: z.string(), url: z.string().url(), hidden: z.boolean(), durationMinutes: z.number().int(),
})));
export type Service = z.infer<typeof servicesSchema>["data"][number];

export const todaySchema = data(z.object({
  date: z.string(),
  timezone: z.string(),
  bookings: z.array(z.object({
    id: z.string(), startsAt: z.string(), endsAt: z.string(), status: z.string(), serviceName: z.string(), firstName: z.string(),
  })),
}));
export type Today = z.infer<typeof todaySchema>["data"];

export const emailTimesSchema = data(z.object({
  times: z.array(z.object({ startsAt: z.string(), label: z.string(), href: z.string().url() })),
  html: z.string(),
}));
export type EmailTimes = z.infer<typeof emailTimesSchema>["data"];

export const linkSchema = data(z.object({ id: z.string(), url: z.string().url() }));

export const deviceStartSchema = z.object({
  device_code: z.string(), user_code: z.string(), verification_uri: z.string().url(), verification_uri_complete: z.string().url(),
  expires_in: z.number().int(), interval: z.number().int(),
});

export const tokenSchema = z.object({
  access_token: z.string(), refresh_token: z.string(), expires_in: z.number().int(), scope: z.string().optional(),
});

export const errorSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })]),
  error_description: z.string().optional(),
});
