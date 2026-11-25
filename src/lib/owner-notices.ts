/**
 * Kalendr's own mail to a business owner about their setup (features 11 and 13): the words, in one place so they can be
 * read and tested without sending anything. Each notice names a kind; the handler puts the kind and a few plain fields
 * (a hostname, a count) in the message body as JSON, and the email adapter turns that into one `owner_notice` email.
 * No customer name, phone or email ever goes through here.
 */

export const ownerNoticeKinds = ["domain_records_missing", "domain_stopped", "domain_failed", "onboarding_welcome", "onboarding_day1", "onboarding_day3"] as const;
export type OwnerNoticeKind = (typeof ownerNoticeKinds)[number];

export interface OwnerNoticeFields {
  hostname?: string;
  settingsUrl: string;
  /** Onboarding emails: where the checklist is, the public booking link, and how far the owner has got. */
  dashboardUrl?: string;
  bookingUrl?: string;
  done?: number;
  total?: number;
}

export interface OwnerNoticeContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  button: { label: string; url: string };
}

export function isOwnerNoticeKind(value: unknown): value is OwnerNoticeKind {
  return typeof value === "string" && (ownerNoticeKinds as readonly string[]).includes(value);
}

export function ownerNoticeContent(kind: OwnerNoticeKind, fields: OwnerNoticeFields): OwnerNoticeContent {
  const host = fields.hostname ?? "your web address";
  switch (kind) {
    case "domain_records_missing":
      return {
        subject: `${host} needs attention`,
        heading: "We can't find your web address records",
        paragraphs: [
          `The DNS records for ${host} are missing or have changed. Your booking page still works there for now.`,
          "Put the records back within 7 days to keep it live. After that the address stops showing your booking page. Your Kalendr link keeps working either way.",
        ],
        button: { label: "Check my address", url: fields.settingsUrl },
      };
    case "domain_stopped":
      return {
        subject: `${host} has been switched off`,
        heading: "Your web address is switched off",
        paragraphs: [
          `The DNS records for ${host} were missing for 7 days, so the address no longer shows your booking page.`,
          "Add the records again and check the address to bring it back. Your Kalendr link has kept working the whole time.",
        ],
        button: { label: "Set it up again", url: fields.settingsUrl },
      };
    case "domain_failed":
      return {
        subject: `We could not connect ${host}`,
        heading: "We could not connect your web address",
        paragraphs: [
          `We looked for the DNS records for ${host} for 3 days and did not find both of them.`,
          "Check the records with your domain provider, then ask for them to be shown again to start another 3 days.",
        ],
        button: { label: "See the records", url: fields.settingsUrl },
      };
    case "onboarding_welcome":
      return {
        subject: "Welcome to Kalendr: your booking page is ready",
        heading: "Your booking page is ready",
        paragraphs: [
          "We filled your account with typical services and opening hours so you do not start from a blank page. Change anything you like.",
          "The fastest way to see it work: make a test booking on your own page. It lands on your schedule and the confirmation reaches your phone, in a few minutes.",
        ],
        button: { label: "Make a test booking", url: fields.dashboardUrl ?? fields.settingsUrl },
      };
    case "onboarding_day1":
      return {
        subject: "Finish setting up your booking page",
        heading: "A few steps left",
        paragraphs: [
          `You have done ${fields.done ?? 0} of ${fields.total ?? 8} setup steps. Each takes about a minute, and the checklist remembers where you stopped.`,
          "Once your services and hours are right, make a test booking and share your link.",
        ],
        button: { label: "Pick up where you left off", url: fields.dashboardUrl ?? fields.settingsUrl },
      };
    case "onboarding_day3":
      return {
        subject: "Share your booking link to get your first booking",
        heading: "Ready for your first booking?",
        paragraphs: [
          "Nobody has booked yet. Put your link where your customers already are: your WhatsApp status, Instagram bio, Google Business profile, or a message to regulars.",
          fields.bookingUrl ? `Your link: ${fields.bookingUrl}` : "Your booking link is on your dashboard.",
        ],
        button: { label: "Open my dashboard", url: fields.dashboardUrl ?? fields.settingsUrl },
      };
  }
}
