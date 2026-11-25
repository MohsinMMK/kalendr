import {
  CalendarClock,
  Gauge,
  HandHelping,
  Hourglass,
  ListChecks,
  Route,
  UserRound,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { BookingDemo } from "@/features/marketing/online-booking/booking-demo";
import { eventSnippet, inlineSnippet, linkSnippet, popupSnippet } from "@/features/marketing/online-booking/snippets";
import { ClosingBand, PageHero, PointGrid, Section, StartActions } from "@/features/marketing/page-parts";

export const metadata: Metadata = {
  title: "Online booking",
  description: "A booking page, website embed and forms that customers use on their own, without an account.",
};

const bookingPagePoints = [
  {
    title: "Services and lengths",
    body: "Each service has its own lengths and prices. A haircut can be 45 minutes and a colour 90.",
    icon: <ListChecks />,
  },
  {
    title: "The right team member",
    body: "Customers pick who they see, or take anyone available. The team shows with photos.",
    icon: <UserRound />,
  },
  {
    title: "Free times, worked out for you",
    body: "Times come from working hours, breaks, time off and the bookings already made. A buffer after each visit keeps time for clean-up.",
    icon: <CalendarClock />,
  },
  {
    title: "Instant or Request",
    body: "A service books straight away, or arrives as a Request you approve. Ask for approval always, only for short notice, or only for free-mail addresses. Customers see the Request badge before they pick.",
    icon: <HandHelping />,
  },
  {
    title: "Notice and limits",
    body: "Set the least notice you need and how far ahead people can book. Cap bookings per day, week, month or year, for a service, a person, a location or the whole team.",
    icon: <Gauge />,
  },
  {
    title: "A time held while they finish",
    body: "The time a customer chose is held for them, with a short countdown, so two people do not take the same slot.",
    icon: <Hourglass />,
  },
] as const;

function Snippet({ label, children }: { label: string; children: string }): ReactNode {
  return (
    <pre
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
    >
      <code>{children}</code>
    </pre>
  );
}

export default function OnlineBookingPage() {
  return (
    <>
      <PageHero
        eyebrow="Online booking"
        title="Customers book"
        titleMuted="without calling."
        lead="Share one link. A customer picks a service and a time on their phone, answers your question and confirms. The booking page then shows a private link to manage it."
        actions={<StartActions secondary={{ href: "/embed-demo", label: "Try the website embed" }} />}
        demo={<div className="mx-auto w-full max-w-[560px]"><BookingDemo /></div>}
      />

      <Section
        id="booking-page"
        title="Your booking page"
        lead="One page for the whole business. It shows what you offer and only the times that are really free."
      >
        <PointGrid points={bookingPagePoints} />
        <p className="mt-8 flex items-start gap-3 text-sm text-muted-foreground">
          <Wallet aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
          <span>Take a deposit online once you connect Razorpay or Stripe.</span>
        </p>
      </Section>

      <Section
        id="website"
        title="On your website"
        lead="Share the link, embed the whole page, or put a button on a page you already have."
      >
        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Frame className="min-w-0">
            <FramePanel className="min-w-0">
              <FrameHeader className="p-0 pb-3">
                <FrameTitle>A link</FrameTitle>
                <FrameDescription>Works in any website builder, a print QR code or a social bio.</FrameDescription>
              </FrameHeader>
              <Snippet label="Booking link snippet">{linkSnippet}</Snippet>
            </FramePanel>
            <FramePanel className="min-w-0">
              <FrameHeader className="p-0 pb-3">
                <FrameTitle>The page, inline</FrameTitle>
                <FrameDescription>The booking page fills the spot you give it.</FrameDescription>
              </FrameHeader>
              <Snippet label="Inline embed snippet">{inlineSnippet}</Snippet>
            </FramePanel>
            <FramePanel className="min-w-0">
              <FrameHeader className="p-0 pb-3">
                <FrameTitle>A button that opens a popup</FrameTitle>
                <FrameDescription>Use mode &quot;floating&quot; for a button that stays in a corner.</FrameDescription>
              </FrameHeader>
              <Snippet label="Popup button snippet">{popupSnippet}</Snippet>
            </FramePanel>
          </Frame>
          <div className="flex min-w-0 flex-col gap-5">
            <PointGrid
              columns={2}
              points={[
                { title: "Count what worked", body: "Short links show how many visits they brought. Add Google Analytics, Tag Manager, a Meta pixel or Plausible, loaded only after the visitor agrees." },
                { title: "Tell your site", body: "The page sends ids and times to your website, never a name, email or phone." },
                { title: "After booking", body: "Show the booking confirmation, or send people to your own thank-you page." },
              ]}
            />
            <Snippet label="Listen for a booking">{eventSnippet}</Snippet>
            <p className="text-sm text-muted-foreground">
              A website can frame the booking page only if you have allowed its address. Plain links need nothing.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" render={<Link href="/embed-demo" />}>See the embed demo</Button>
              <Button variant="ghost" render={<Link href="/developers" />}>Developer reference</Button>
            </div>
          </div>
        </div>
      </Section>

      <Section
        id="questions"
        title="Ask what you need"
        lead="Get the answers before the visit, and send each person to the right place."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle render={<h3 />} className="flex items-center gap-2 text-lg">
                <ListChecks aria-hidden="true" className="size-5 text-primary" /> Booking questions
              </CardTitle>
              <CardDescription>Your own questions, asked for the service the customer chose.</CardDescription>
            </CardHeader>
            <CardPanel className="space-y-3 text-sm text-muted-foreground">
              <p>Yes or no, single choice and multiple choice are taps. An optional written question starts as No or Yes and opens its box on Yes.</p>
              <p>A question can appear only when an earlier answer calls for it. Add a ready-made form in Settings or write your own.</p>
            </CardPanel>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle render={<h3 />} className="flex items-center gap-2 text-lg">
                <Route aria-hidden="true" className="size-5 text-primary" /> Routing forms
              </CardTitle>
              <CardDescription>A short form that sends a person to the right service and team member.</CardDescription>
            </CardHeader>
            <CardPanel className="space-y-3 text-sm text-muted-foreground">
              <p>A clinic asks &quot;First visit?&quot; and &quot;Language?&quot;. A first-time Tamil speaker lands on a consultation with a Tamil-speaking doctor.</p>
              <p>Routes are checked in order and every form needs a fallback. Answers never go in the web address. Each booking records which route the customer took.</p>
            </CardPanel>
          </Card>
        </div>
      </Section>

      <Section
        id="manage"
        title="Change or cancel without calling"
        lead="Customers do not need an account to look after their booking."
      >
        <PointGrid
          points={[
            {
              title: "A private manage link",
              body: "Every booking gets one. The confirmation page shows it as Manage appointment, next to Add to calendar.",
              icon: <CalendarClock />,
            },
            {
              title: "Your policy decides",
              body: "You choose whether customers may cancel or reschedule online, and how long before the start. Inside the cut-off, the page shows your rule and phone number instead of a button.",
              icon: <Gauge />,
            },
            {
              title: "A code before any change",
              body: "To cancel, move or change contact details from a link, the customer confirms with a one-time code, so a forwarded link cannot change anything.",
              icon: <HandHelping />,
            },
            {
              title: "Sign in with a one-time code",
              body: "Returning customers sign in with their email or phone to see all their bookings. Manage links stop opening 30 days after the visit, and signing in still shows the booking.",
              icon: <UsersRound />,
            },
          ]}
          columns={2}
        />
        <p className="mt-8 max-w-2xl text-sm text-muted-foreground">
          Codes are sent by email, WhatsApp or text message once you connect those accounts.
        </p>
      </Section>

      <ClosingBand />
    </>
  );
}
