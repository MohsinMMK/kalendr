import { z } from "zod";

import type { StaffRole } from "./permissions";

/**
 * "One login, many businesses": which business a person who works in several has open right now.
 *
 * The choice lives in one httpOnly, SameSite=Lax cookie holding the business's public slug. It is only a preference: every
 * request re-checks it against the person's active memberships, so a stale or forged value (a business they were removed
 * from, one they never belonged to) is ignored and they land on their first business instead. The cookie grants nothing.
 */
export const activeBusinessCookie = "kalendr_business";

/** A year; the person picks a business rarely and expects it to stick. */
export const activeBusinessCookieMaxAge = 60 * 60 * 24 * 365;

/** The same shape the business slug is registered with, so nothing else can ride in the cookie. */
export const businessSlugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** The slug in a `Cookie` request header, or null when there is none or it is not a well-formed slug. */
export function readActiveBusinessSlug(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== activeBusinessCookie) continue;
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    const parsed = businessSlugSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/**
 * Which of a person's active memberships to open.
 * - A slug asked for by name (a URL or a caller) wins, and must match: if it does not, there is no business, never a fallback.
 * - Otherwise the cookie, but only when it names a business they are in; a stale cookie is ignored without a word.
 * - Otherwise the first business (the list is already in a stable order).
 */
export function chooseMembership<T extends { slug: string }>(
  memberships: readonly T[],
  choice: { requestedSlug?: string | undefined; cookieSlug?: string | null | undefined },
): T | undefined {
  if (choice.requestedSlug) return memberships.find((item) => item.slug === choice.requestedSlug);
  const remembered = choice.cookieSlug ? memberships.find((item) => item.slug === choice.cookieSlug) : undefined;
  return remembered ?? memberships[0];
}

/** What the switch route sends back: the one slug to remember. */
export const switchBusinessSchema = z.object({ slug: businessSlugSchema });
export type SwitchBusinessInput = z.infer<typeof switchBusinessSchema>;

/** One business in the switcher. Never more than the name and the person's own role there. */
export interface OwnBusiness {
  slug: string;
  name: string;
  role: StaffRole;
  /** The business open in this browser right now. */
  current: boolean;
}
