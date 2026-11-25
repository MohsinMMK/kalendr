---
name: Kalendr marketing site
description: Six public pages that show the product working, each with a filmed Stageshow demo.
scope: Public routes /, /online-booking, /front-desk, /industries, /clinics, /trust
---

# Kalendr marketing site

## Overview

The public site has six pages. They share one header, one footer and one set of parts. Each page leads with a short two-line headline and a small, quiet demo of the real product. The demo plays once and then holds on its result.

The [root design system](../../DESIGN.md) owns the tokens. This guide covers only the public pages.

| Route | Page | What it shows |
| --- | --- | --- |
| `/` | Home | What Kalendr does across the day, how a business starts, and that the words change per business type. |
| `/online-booking` | Online booking | The booking page, the website embed, forms and booking rules. |
| `/front-desk` | Front desk | Today, Schedule, walk-ins and the waiting-room screen, the waitlist offer, and tables. |
| `/industries` | Businesses | Salons, tutors, studios and clinics in their own words, plus rooms and chairs. |
| `/clinics` | Clinics | Visit documents, the patient portal, family bookings and recalls. |
| `/trust` | Privacy and security | Tenant isolation, roles and branch limits, sign-in and second factor, activity log, privacy centre. |

## Code

- **Routes:** `src/app/(marketing)/`. The group layout renders, in order:
  - the skip link
  - `SiteHeader`
  - `<main id="main-content">`
  - `SiteFooter`

  It also loads `src/features/marketing/stage-look.css`.
- **Page list:** `src/features/marketing/site-nav.ts` (`marketingPages`). The header, the mobile menu, the footer, `sitemap.ts` and `robots.ts` all read it. Add a page there, not in each consumer.
- **Shared parts** (`src/features/marketing/page-parts.tsx`):
  - `PageHero` renders the page's only `<h1>`.
  - `Section`
  - `PointGrid`
  - `StartActions`
  - `ClosingBand`
- **Demos:** each page's demo and its notes live in `src/features/marketing/<page>/`:
  - the demo component (`*-demo.tsx`)
  - its CSS, scoped under its own class prefix
  - `page.test.tsx`

## Look

- **Type and colour:**
  - Inter, through `font-sans` and `font-heading`.
  - Porcelain background and charcoal ink.
  - `primary` (charcoal in light mode) for actions.
  - Headlines are two lines: `title`, then a muted `titleMuted`.
- **Tokens only:** use `bg-background`, `text-muted-foreground`, `border` and so on, never raw hex.
- **Light only:** like every public page, these pages are always light. Dark mode is a staff-side theme choice (`.dark` set by the staff frame).
- **Header:**
  - At `lg` and wider, the full nav is shown.
  - Below `lg`, the nav is a menu button (`mobile-nav.tsx`).
  - The breakpoint is `lg` because the five nav labels overflow at 768px.
- **Pages:**
  - The container is `max-w-7xl` with `px-4 sm:px-6 lg:px-8`.
  - No horizontal scroll at 375, 768, 1024 or 1440px.
- **Never:**
  - purple, gradients, glass panels or sparkles
  - stock clinicians, stethoscopes or heartbeat lines

## Demos (Stageshow)

- **The kit:** demos use the vendored Stageshow kit (`src/components/stageshow`, v1.1.1).
- **Structure:** each demo is a Stage with a script whose beats run cause, then action, then result. It also has:
  - a `compact` layout about 358px wide for phones
  - a `poster` state, shown for reduced motion and as the first paint
- **Wrapper:** wrap each demo in `.mk-demo` so it takes the shared token look.
- **Accessibility:**
  - The demo `<figure>` has an `aria-label` that says what it shows.
  - The moving content is `aria-hidden`.
  - Every fact a demo shows is also in the page text.
- **Film gate:** before a demo changes, film it with Stageshow's film script and `--gate` at full width, at `--width 390` and with `--reduced`, and look at each contact sheet. The script lives in the Stageshow skill, not in this repository.
- **Accepted gate output:**
  - **Kit override:** "kit override" lines for `.ss-*` selectors that the page's own CSS does not touch. The gate skips only stylesheets served from `/kit/`, and Next bundles the kit CSS into the app chunk, so these lines are false positives.
  - **Dev mode:** "inconclusive" sampling gaps.

## Words and claims

- **Fictional businesses**, all on the same date, Monday 12 October:
  - Northside Studio (salon). Team: Anika Iyer, Rohan Das, Meera Nair; Sameer Joshi on the front desk.
  - Lakeview Dental (clinic). Dr Sana Qureshi, Dr Vikram Rao; Chair 1 and Chair 2.
  - Brightpath Tutoring (tutor). Farah Ali; students go by first name.
  - One client keeps one booking per page, so a name never sits in two places at once on the same demo.
- **Product strings:** labels and statuses come from the app's own code (for example `src/lib/business-types.ts` and the status names).
- **Claims:** only what [STATUS.md](../STATUS.md) lists as Done.
  - **Needs keys:** email, WhatsApp, SMS, calendar sync, video, payments, push, SSO and the assistant appear only as "once you connect your … account".
  - **Partial:** shown within its limits. For example, classes do not charge seats.
- **Never write:**
  - customer counts, testimonials, ratings, pricing or uptime
  - "certified", "compliant", "HIPAA", "ISO", "SOC 2"
  - "seamless", "all-in-one" or "AI-powered"

  Each page test checks the rendered HTML for the worst of these.
- **Clinics:** Kalendr holds visit documents and notes. It is not a full medical records system, and the clinics page says so.
