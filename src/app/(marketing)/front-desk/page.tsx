import type { Metadata } from "next";
import { CalendarClock, CalendarDays, DoorOpen, Repeat, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardPanel } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TodayDemo } from "@/features/marketing/front-desk/today-demo";
import { ClosingBand, PageHero, PointGrid, Section, StartActions } from "@/features/marketing/page-parts";

export const metadata: Metadata = {
  title: "Front desk",
  description: "Today, the schedule, walk-ins, the waitlist, customer profiles and team logins for the people who run the day.",
};

const todayPoints = [
  { title: "The day at a glance", body: "Today is a board: Up next, Waiting, With your stylist or doctor, and Done. Tiles above it count who is still to arrive, who is waiting and the longest wait.", icon: <CalendarDays /> },
  { title: "Three ways to look", body: "Switch between Board, By stylist (By doctor in a clinic) and Timeline. Call next picks the urgent first, then by token, and Running late tells everyone still to be seen.", icon: <Users /> },
  { title: "A schedule by person and by room", body: "The Schedule shows one column per team member, or one per room, chair or station, and also a Week and a List. A double booking is stopped in the database, not just on screen.", icon: <DoorOpen /> },
  { title: "Repeating appointments", body: "Book every Tuesday at 10 for eight weeks in one action. A clash is offered another time. Move this and following, or cancel all: visits already completed stay as they are.", icon: <Repeat /> },
] as const;

const queuePoints = [
  { title: "Add walk-in", body: "Press Add walk-in in the Waiting column, or the C key. The person takes the next free opening unless you pick another, and gets a token." },
  { title: "A screen for the waiting area", body: "Open the waiting-room screen on a TV. It shows token numbers only: Now calling, Also called and Next. No names." },
  { title: "Their own page", body: "A customer's link shows Your token and where they stand. It works on the day of the visit only." },
  { title: "A QR code at the door", body: "Someone gives a first name and a phone number and gets a token. Close the queue for the day and door sign-ups stop." },
] as const;

const waitlistSteps = [
  { title: "A time frees up", body: "A booking is cancelled or moved away. The time is held, and it is not shown on the booking page while it is held." },
  { title: "The first person is offered it", body: "The page they open says A time just opened up, with Take this time and Not this time. Taking it books them in one tap." },
  { title: "No answer, or no thanks", body: "The offer passes to the next person. If nobody takes it, the time goes back to the booking page." },
] as const;

const customerPoints = [
  { title: "Tables you arrange", body: "Customers, Bookings and Records work like a table you own. Rename, sort, filter, move, hide and resize columns. Your arrangement is what the whole team sees." },
  { title: "Your own columns", body: "Add fields for what your business needs to know, such as a preferred stylist. Nine kinds, from text and dates to choices and links. Only owners and admins define them." },
  { title: "Notes and history", body: "A profile has one pinned note, tags and a single timeline of what happened. Notes are internal and dated." },
  { title: "Records stay separate", body: "For clinics, visit documents live in Records, where they are held for the doctors who saw that patient. Kalendr is not a full medical records system." },
] as const;

const teamPoints = [
  { title: "Team routing", body: "A customer who does not mind picks Anyone available. The person is chosen when the booking is made, by priority and fair share, and a returning customer can get the person they saw last time." },
  { title: "Time off with cover", body: "While someone is away, new bookings go to their cover. Move their bookings to the cover in one action; those that do not fit are listed as Needs a person." },
  { title: "Logins for practitioners", body: "An owner gives a doctor or stylist a login from their profile. Signed in, they see only their own Bookings, Customers, Reports and Today, and only their own column on the Schedule." },
  { title: "The bell", body: "One bell in the header opens Notifications, with Alerts and Needs attention. People who may approve can Approve or Decline a booking request right there." },
] as const;

export default function FrontDeskPage() {
  return (
    <>
      <PageHero
        eyebrow="Front desk"
        title="Run the day."
        titleMuted="Not the phone."
        lead="Today shows who is coming, who is waiting and who is with the team. Requests, check-in and walk-ins are handled right on Today."
        actions={<StartActions secondary={{ href: "/online-booking", label: "See online booking" }} />}
        demo={<TodayDemo />}
      />

      <Section id="today" title="Today and the schedule." lead="The board the front desk works from, and the calendar behind it.">
        <PointGrid points={todayPoints} columns={2} />
        <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
          Group classes are on the schedule too, with seats, a roster and one-tap attendance. Seats are not charged yet: the class price is shown but not collected online.
        </p>
      </Section>

      <Section id="queue" title="Walk-ins and the queue." lead="Someone arrives without a booking. They join the line like everyone else.">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PointGrid points={queuePoints} columns={2} />
          <figure aria-label="The waiting-room screen: Now calling 12, please go to Chair 1; also called 11; next 13, 14 and 15." className="m-0">
            <Card>
              <CardPanel className="flex flex-col gap-4 p-6">
                <div>
                  <p className="text-sm text-muted-foreground">Now calling</p>
                  <p className="font-heading text-7xl font-semibold leading-none tabular-nums">12</p>
                  <p className="mt-2 font-medium">Please go to Chair 1</p>
                </div>
                <dl className="grid grid-cols-2 gap-4 border-t pt-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Also called</dt>
                    <dd className="mt-1 font-medium tabular-nums">11 · Chair 2</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Next</dt>
                    <dd className="mt-1 font-medium tabular-nums">13 14 15</dd>
                  </div>
                </dl>
              </CardPanel>
            </Card>
            <figcaption className="mt-2 text-xs text-muted-foreground">Lakeview Dental&rsquo;s waiting-room screen. Tokens only.</figcaption>
          </figure>
        </div>
        <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
          Telling a waiting person that it is their turn goes by message, once you connect your WhatsApp or text account. The screen and the token page work without one.
        </p>
      </Section>

      <Section id="waitlist" title="A smart waitlist." lead="When a time frees up, the people waiting for it hear about it, in order.">
        <ol className="grid gap-6 sm:grid-cols-3">
          {waitlistSteps.map((step, index) => (
            <li key={step.title} className="flex min-w-0 gap-3">
              <span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">{index + 1}</span>
              <div className="min-w-0">
                <h3 className="font-medium">{step.title}</h3>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="font-medium">What staff see</h3>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">An Offers tab lists each open time with who was asked and who answered. You can offer a time by hand, release a held time to the booking page, and turn automatic offers off for a service.</p>
          </div>
          <div>
            <h3 className="font-medium">How offers are delivered</h3>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">Offers go by email or WhatsApp once you connect your email or WhatsApp account. There is no text-message offer. Until then the hold, the Offers tab and the offer page all work, but nothing is sent.</p>
          </div>
        </div>
      </Section>

      <Section id="customers" title="Customer profiles." lead="Know who is on the other side of the booking.">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PointGrid points={customerPoints} columns={2} />
          <figure aria-label="A Customers table with Client, Phone and a business's own Preferred stylist column." className="m-0">
            <Card>
              <CardPanel className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Preferred stylist</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ["Riya Shah", "090000 00001", "Anika Iyer"],
                      ["Priya Menon", "090000 00002", "Rohan Das"],
                      ["Arjun Rao", "090000 00003", "Meera Nair"],
                    ].map(([name, phone, stylist]) => (
                      <TableRow key={name}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell className="tabular-nums">{phone}</TableCell>
                        <TableCell><Badge variant="outline">{stylist}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardPanel>
            </Card>
            <figcaption className="mt-2 text-xs text-muted-foreground">Northside Studio added its own Preferred stylist column.</figcaption>
          </figure>
        </div>
      </Section>

      <Section id="team" title="The team." lead="Everyone sees what their job needs, and the right person gets the booking.">
        <PointGrid points={teamPoints} columns={2} />
        <p className="mt-6 flex max-w-2xl items-start gap-2 text-sm text-muted-foreground">
          <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          Alerts reach your phone or inbox once you connect push and email. The bell in the app works without them.
        </p>
      </Section>

      <ClosingBand title="Give your front desk a calmer day." />
    </>
  );
}
