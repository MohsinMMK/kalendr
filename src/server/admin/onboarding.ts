import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminCall } from "./db";

const count = z.coerce.number().int().min(0);

const rowSchema = z.object({
  step_key: z.string(),
  started: count,
  done: count,
  skipped: count,
  median_minutes: z.coerce.number().int().nullable(),
});

export interface OnboardingFunnelStep {
  stepKey: string;
  /** Businesses that signed up in the window. */
  started: number;
  done: number;
  skipped: number;
  /** Median minutes from sign-up to finishing the step, or null when nobody has. */
  medianMinutes: number | null;
}

/** Where new owners drop off (feature 11): counts per checklist step for businesses started in the last `days` days. */
export async function onboardingFunnel(adminUserId: string, days: number): Promise<OnboardingFunnelStep[]> {
  const rows = await adminCall((database) => database.execute(sql`select * from admin_onboarding_funnel(${adminUserId}, ${days})`));
  return z.array(rowSchema).parse([...rows]).map((row) => ({
    stepKey: row.step_key, started: row.started, done: row.done, skipped: row.skipped, medianMinutes: row.median_minutes,
  }));
}
