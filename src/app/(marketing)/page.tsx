import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardPanel } from "@/components/ui/card";
import { Frame, FramePanel } from "@/components/ui/frame";
import { HeroDemo } from "@/features/marketing/home/hero-demo";
import { capitalize } from "@/features/marketing/industries/words";
import { ClosingBand, container, PageHero, Section, sectionHeading, StartActions } from "@/features/marketing/page-parts";
import { marketingPages } from "@/features/marketing/site-nav";
import { businessTypes, type BusinessTypeId } from "@/lib/business-types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { absolute: "Kalendr · Online booking and scheduling for any business" },
  description:
    "Online booking and scheduling for salons, tutors, studios and clinics: a booking page, a front desk for the day, and your own words for customers and staff.",
};

const steps = [
  ["Create your business", "Sign up with an email code and pick your type of business."],
  ["Add services, team and hours", "Starter services are there already. Change them, add people and set working hours."],
  ["Share your booking link", "Send the link, or embed the booking page on your own website."],
] as const;

const wordTypes = ["wellness", "education", "healthcare", "real_estate"] as const satisfies readonly BusinessTypeId[];

const questions = [
  ["Who is Kalendr for?", "Any business that runs on appointments: salons, clinics, tutors, studios, consultants and more."],
  ["Do my customers need an account?", "No. They book and manage their booking with a private link."],
  ["What do I need to start?", "Your business, one service, one team member and working hours. Add a room or a piece of equipment if a booking needs one."],
  ["Can I use my own words?", "Yes. Your business type sets the words, and you can rename any of them in Settings."],
  ["Can Kalendr send reminders?", "Once you connect an email or SMS account and check delivery. Until then nothing is sent."],
  ["Does Kalendr keep medical records?", "For clinics, Kalendr holds visit documents such as reports and prescriptions, and notes. It is not a full medical records system."],
] as const;

export default function HomePage() {
  return (
    <>
      <PageHero
        title="Your bookings."
        titleMuted="Up to date."
        lead="Online booking and scheduling for any business that runs on appointments. Customers book themselves; your team sees the day."
        actions={<StartActions secondary={{ href: "/online-booking", label: "See how booking works" }} />}
        demo={<HeroDemo />}
      />

      <Section id="product" title="One product for the whole day." lead="From the booking page to the front desk to the people you look after.">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {marketingPages.map((page) => (
            <li key={page.href} className="min-w-0">
              <Card className="h-full">
                <CardPanel className="flex h-full flex-col gap-3 p-5">
                  <h3 className="font-heading text-lg font-semibold">{page.label}</h3>
                  <p className="text-pretty text-sm text-muted-foreground">{page.summary}</p>
                  <Link
                    href={page.href}
                    aria-label={`${page.label}: read more`}
                    className="mt-auto inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Read more <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                </CardPanel>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="start" title="How it starts." lead="You can take your first booking the same day.">
        <ol className="grid gap-6 sm:grid-cols-3">
          {steps.map(([title, body], index) => (
            <li key={title} className="flex gap-3">
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0">
                <h3 className="font-medium">{title}</h3>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        id="words"
        title="Your words."
        lead={
          <>
            Your business type sets what Kalendr calls people and visits. Rename any of it in Settings.{" "}
            <Link href="/industries" className="font-medium text-primary underline-offset-4 hover:underline">
              See each business type
            </Link>
            .
          </>
        }
      >
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {wordTypes.map((id) => {
            const type = businessTypes[id];
            return (
              <li key={id} className="min-w-0">
                <Card className="h-full">
                  <CardPanel className="flex h-full flex-col gap-3 p-4">
                    <h3 className="font-heading font-semibold">{type.label}</h3>
                    <div className="mt-auto flex flex-wrap gap-1.5">
                      {[type.terms.customer, type.terms.provider, type.terms.appointment].map((term) => (
                        <Badge key={term.plural} variant="outline">
                          {capitalize(term.plural)}
                        </Badge>
                      ))}
                    </div>
                  </CardPanel>
                </Card>
              </li>
            );
          })}
        </ul>
      </Section>

      <section
        id="questions"
        aria-labelledby="questions-title"
        className={cn(container, "grid scroll-mt-20 gap-6 py-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 lg:py-16")}
      >
        <h2 id="questions-title" className={sectionHeading}>
          A few answers.
        </h2>
        <Frame>
          <FramePanel className="px-4 py-0">
            <Accordion multiple>
              {questions.map(([question, answer]) => (
                <AccordionItem key={question} value={question}>
                  <AccordionTrigger>{question}</AccordionTrigger>
                  <AccordionPanel hiddenUntilFound>{answer}</AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          </FramePanel>
        </Frame>
      </section>

      <ClosingBand />
    </>
  );
}
