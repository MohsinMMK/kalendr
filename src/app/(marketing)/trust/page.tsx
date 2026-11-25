import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Building2, ClipboardList, FileDown, KeyRound, MapPin, ShieldCheck, UserRoundX, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ClosingBand, container, PageHero, PointGrid, Section, sectionHeading, StartActions } from "@/features/marketing/page-parts";
import { AccessDemo } from "@/features/marketing/trust/access-demo";

export const metadata: Metadata = {
  title: "Privacy and security",
  description: "How Kalendr keeps each business's data apart, gives people only the pages they need, and records who changed what.",
};

const roles = [
  { name: "Owner", body: "Everything, including the business's billing and closing the account." },
  { name: "Admin", body: "Everything except changing the owner." },
  { name: "Receptionist", body: "Front desk: books appointments, checks customers in, runs the waitlist." },
  { name: "Practitioner", body: "Sees their own schedule and customers." },
  { name: "Billing", body: "Sees the schedule and customers, takes payments and gives refunds." },
  { name: "Read only", body: "Sees the schedule and customers. Changes nothing." },
] as const;

export default function TrustPage() {
  return (
    <>
      <PageHero
        eyebrow="Privacy and security"
        title="Your data stays yours."
        titleMuted="Your team sees what they need."
        lead="Each business's data is kept apart by the database itself. Roles, location limits and a second sign-in step decide who on your team sees what, and the Activity log shows who changed it."
        actions={<StartActions secondary={{ href: "/developers", label: "For developers" }} />}
        demo={
          <div className="mk-demo">
            <figure className="m-0">
              <AccessDemo />
              <figcaption className="mt-3 text-sm text-muted-foreground">
                An owner gives Sameer Joshi the Receptionist role at Banjara Hills only. His Schedule then lists only that location, and the change is in Activity.
              </figcaption>
            </figure>
          </div>
        }
      />

      <Section
        id="separation"
        title="Each business's data stays its own."
        lead="Kalendr serves many businesses from one system. The separation between them is enforced in the database, not only in the app."
      >
        <PointGrid
          columns={3}
          points={[
            {
              icon: <Building2 />,
              title: "Row-level security",
              body: "Every table that holds a business's data has row-level security switched on and forced. The database itself only returns rows that belong to the business asking.",
            },
            {
              icon: <ShieldCheck />,
              title: "Tested as the real app role",
              body: "The app and its background worker run as separate database roles that cannot bypass those rules. The separation is tested with those exact roles.",
            },
            {
              icon: <KeyRound />,
              title: "Linked to the right business",
              body: "Related records are linked by the business as well as by their own id, so a booking cannot point at another business's customer.",
            },
          ]}
        />
      </Section>

      <Section
        id="access"
        title="The right people see the right pages."
        lead="Every staff page opens only for roles that hold its permission, from one table that the page guard, the sidebar and the command palette all read."
      >
        <ul className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roles.map((role) => (
            <li key={role.name}>
              <Card className="h-full">
                <CardPanel className="p-4">
                  <h3 className="font-medium">{role.name}</h3>
                  <p className="mt-1 text-pretty text-sm text-muted-foreground">{role.body}</p>
                </CardPanel>
              </Card>
            </li>
          ))}
        </ul>
        <PointGrid
          columns={2}
          points={[
            {
              icon: <UsersRound />,
              title: "Permissions, switch by switch",
              body: "Each role starts with its own permissions. Under Sign-in and access you can switch single ones on or off for one person, and nobody can hand out a permission they do not hold.",
            },
            {
              icon: <MapPin />,
              title: "Limit someone to a location",
              body: "An owner or admin can limit a team member to some of the business's locations. A limited person does not see the other locations' customers, practitioners, services, bookings or reports.",
            },
            {
              icon: <ClipboardList />,
              title: "Practitioners see their own work",
              body: "A practitioner's Bookings, Customers, Reports and Today hold only their own visits, and their Schedule shows only their own column. An owner gives an existing practitioner a login from their profile.",
            },
            {
              icon: <UserRoundX />,
              title: "Remove someone",
              body: "Remove a person from the team and their access to your business ends at once, with their sessions. You can also cancel an invite that has not been accepted, or sign someone out from every device.",
            },
          ]}
        />
        <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
          One person can work at two businesses with one login and switch between them. A business only sees its own side of that: it cannot change that login&apos;s email or send it a password link.
        </p>
      </Section>

      <Section
        id="sign-in"
        title="Sign-in."
        lead="Owners and admins must use a second step to see anything. A business can ask the same of everyone."
      >
        <PointGrid
          columns={3}
          points={[
            {
              title: "Authenticator app",
              body: "A code from an authenticator app, with backup codes. Passkeys work too: a fingerprint, face or device PIN.",
            },
            {
              title: "A fresh check for sensitive actions",
              body: "Changing roles, payment settings or API keys, exporting data or deleting a customer asks for a second-step check from the last 10 minutes.",
            },
            {
              title: "Customers sign in with a one-time code",
              body: "In the customer portal, a customer signs in with a one-time code that expires. Their session is separate from staff sessions. Sending codes needs your email or messaging account to be connected.",
            },
            {
              title: "Google and Microsoft, once connected",
              body: "Once you connect your Google or Microsoft account, your team can use it to sign in. It never creates access: only a person you have invited can get in.",
            },
          ]}
        />
      </Section>

      <Section
        id="activity"
        title="See who changed what, and when."
        lead="Activity lists changes to your team, settings and bookings, newest first, with refused attempts too."
      >
        <PointGrid
          columns={3}
          points={[
            { title: "Who and what", body: "Each line names the person, what they did and the time. Role changes show the role before and after." },
            { title: "Filter it", body: "Filter by person, kind of change, result or date. Refused shows what someone tried that their access did not allow." },
            { title: "Only for people you choose", body: "Activity opens for roles that hold the audit permission. Everyone else does not see the page." },
          ]}
        />
      </Section>

      <Section
        id="privacy-tools"
        title="Privacy tools for your customers."
        lead="Kalendr gives you tools to help you meet your duties to your customers. They are drafted in plain language and have not yet had a legal review, so check the wording with your own adviser."
      >
        <PointGrid
          columns={3}
          points={[
            { icon: <ShieldCheck />, title: "Separate consent choices", body: "Appointment messages, marketing messages, reviews and records sharing are asked about separately. Marketing needs a clear yes, and a withdrawal is recorded, not overwritten." },
            { icon: <FileDown />, title: "A copy of their data", body: "A customer can ask for a copy of their data. It is a zip with a complete data file and a readable summary, and its link works once." },
            { icon: <UserRoundX />, title: "Erasure, with a plain account", body: "When you approve an erasure, the customer's details are anonymised and they get a plain summary of what was removed and what was kept, such as payment records and consent history." },
            { icon: <ClipboardList />, title: "Retention periods", body: "Set how long message logs, cancelled booking details and records are kept. The defaults are starting points, not legal advice." },
            { icon: <UsersRound />, title: "Requests in one place", body: "Staff with the privacy permission see each request with the days remaining, and approve or refuse it with a reason." },
          ]}
        />
      </Section>

      <section aria-labelledby="developers-title" id="developers" className={cn(container, "scroll-mt-20 py-12 lg:py-16")}>
        <Card>
          <CardPanel className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
            <div className="max-w-2xl">
              <h2 id="developers-title" className={sectionHeading}>For developers.</h2>
              <p className="mt-3 text-pretty text-muted-foreground">
                API keys carry scopes, so a key can do only what you gave it. Webhooks are signed, so you can check an event came from Kalendr. Keys and webhooks are listed in the Activity log when they are created or changed.
              </p>
            </div>
            <Button variant="outline" size="lg" render={<Link href="/developers" />}>
              Read the API reference <ArrowRight aria-hidden="true" />
            </Button>
          </CardPanel>
        </Card>
      </section>

      <ClosingBand title="Set up your business with the right people in the right places." />
    </>
  );
}
