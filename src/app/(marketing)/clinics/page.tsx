import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Armchair, BellRing, FileText, IdCard, ShieldCheck, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PortalDemo } from "@/features/marketing/clinics/portal-demo";
import { ClosingBand, PageHero, PointGrid, Section, StartActions } from "@/features/marketing/page-parts";
import { businessTypes, resourceKindLabels } from "@/lib/business-types";
import { recordKindLabels } from "@/lib/visit-records";

/** "a, b and c" */
const listOf = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export const metadata: Metadata = {
  title: "Clinics",
  description:
    "For general practice and dental clinics: visit documents with their own permissions, a patient portal, family bookings, recalls, rooms and chairs.",
};

const kinds = Object.values(recordKindLabels);
const dental = businessTypes.dental;
const chairServices = dental.starterServices.filter((service) => service.requiredResourceKind === "chair").map((service) => service.name);
const dentalSpaces = dental.resourceKinds.map((kind) => resourceKindLabels[kind].toLowerCase());
const credentials = dental.providerFields;

const records = [
  {
    title: `${kinds.join(", ")}`,
    body: "Write them against a visit, and attach files once you connect file storage. Each document is a draft until you share it.",
    icon: <FileText />,
  },
  {
    title: "Its own permission",
    body: "Opening patient records is a separate permission from running the schedule. A doctor sees only their own patients, and you can also see who opened a record.",
    icon: <ShieldCheck />,
  },
  {
    title: "Share and withdraw",
    body: "Sharing puts a document in the patient's portal straight away. Withdraw it if you need to change it.",
    icon: <ArrowRight />,
  },
] as const;

export default function ClinicsPage() {
  return (
    <>
      <PageHero
        eyebrow="Clinics"
        title="Visits, documents."
        titleMuted="Kept together."
        lead="For general practice and dental clinics. Patients book online, doctors keep visit documents against each visit, and patients open what you share from their own portal."
        actions={<StartActions secondary={{ href: "/front-desk", label: "See the front desk" }} />}
        demo={
          <figure aria-label="A doctor shares a prescription from Records. The patient signs in to the portal with a one-time code, sees the next visit, and opens the prescription under Documents.">
            <div aria-hidden="true">
              <PortalDemo />
            </div>
          </figure>
        }
      />

      <Section
        id="portal"
        title="A portal patients can open."
        lead="Patients sign in with a one-time code sent to the email or phone number they gave when they booked. No password to remember."
      >
        <PointGrid
          columns={3}
          points={[
            { title: "Their visits", body: "Upcoming and past visits in one list, each with Manage where the visit can be changed." },
            { title: "Shared documents", body: "Notes, reports and prescriptions you have shared, under Documents. Patients open them there." },
            {
              title: "Families on one phone",
              body: "When a family shares a phone or email, each person's documents stay closed until their date of birth is confirmed, or the clinic confirms it is them.",
            },
          ]}
        />
        <p className="mt-6 max-w-2xl text-pretty text-sm text-muted-foreground">
          Sign-in codes arrive once you connect your email, WhatsApp or text message account. Until then nothing is sent.
        </p>
      </Section>

      <Section
        id="records"
        title="Records, without the clutter."
        lead="Kalendr holds visit notes, reports and prescriptions, and the files that go with them. It is not a full medical records system."
      >
        <PointGrid points={records} columns={3} />
      </Section>

      <Section
        id="families"
        title="Book for the family. Remind when it is due."
        lead="Two things that keep a clinic's diary full without phone calls."
      >
        <PointGrid
          columns={2}
          points={[
            {
              title: "Book for a child or someone else",
              body: "When booking, choose Booking for someone else. The visit sits under that person, and their documents are kept apart from yours.",
              icon: <Users />,
            },
            {
              title: "Follow-ups for a check-up that is due",
              body: "A Follow-ups list shows who is due. Mark each person contacted, snooze them, mark them booked or close it. An automatic recall message goes out only after you connect email, WhatsApp or text, and only to people who agreed to marketing messages.",
              icon: <BellRing />,
            },
          ]}
        />
      </Section>

      <Section
        id="doctors"
        title="Doctors, rooms and chairs."
        lead="A booking can need a room or a chair as well as a doctor. The time is offered only when both are free."
      >
        <PointGrid
          columns={2}
          points={[
            {
              title: "Chairs, operatories and rooms",
              body: `Dental clinics can set up ${dentalSpaces.join(", ")}. ${listOf(chairServices)} are suggested as services that need a chair.`,
              icon: <Armchair />,
            },
            {
              title: "Qualifications on profiles",
              body: `Each doctor's profile can show ${credentials.qualifications.toLowerCase()} and a ${credentials.registrationNumber.toLowerCase()}, with a ${credentials.specialty.toLowerCase()} and a short bio. Doctors can also have their own login and see only their own work.`,
              icon: <IdCard />,
            },
          ]}
        />
      </Section>

      <Section
        id="waiting-room"
        title="The waiting room."
        lead="Add a walk-in from Today and Kalendr takes the next free opening and gives the patient a token number. The front desk page shows how the queue works."
      >
        <Button variant="outline" size="lg" render={<Link href="/front-desk" />}>
          How the front desk works <ArrowRight aria-hidden="true" />
        </Button>
      </Section>

      <ClosingBand title="Set up your clinic." />
    </>
  );
}
