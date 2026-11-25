import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface ClassNoticeEmailProps {
  brand: EmailBrand;
  customerName: string;
  /** What this message is about. */
  kind: "enrolled" | "waitlisted" | "offer" | "session_cancelled" | "broadcast";
  serviceName: string;
  /** "Tue, 24 Nov 2026, 6:00 pm IST", in the place's own time zone. */
  when: string;
  /** The line the business wrote, for a cancellation or a message to everyone. */
  message: string;
  /** For an offered seat: minutes to answer. */
  minutes: number;
  /** The private link to this place: see it, cancel it or take an offered seat. */
  seatUrl: string;
}

export function subject({ brand, kind, serviceName, when }: ClassNoticeEmailProps): string {
  switch (kind) {
    case "enrolled": return `${brand.businessName}: you're in for ${serviceName}, ${when}`;
    case "waitlisted": return `${brand.businessName}: you're on the waiting list for ${serviceName}`;
    case "offer": return `A seat opened up: ${serviceName}, ${when}`;
    case "session_cancelled": return `${brand.businessName}: ${serviceName} on ${when} is cancelled`;
    default: return `${brand.businessName}: a message about ${serviceName}, ${when}`;
  }
}

export default function ClassNoticeEmail({ brand, customerName, kind, serviceName, when, message, minutes, seatUrl }: ClassNoticeEmailProps) {
  const title = kind === "enrolled" ? "You have a place" : kind === "waitlisted" ? "You're on the waiting list" : kind === "offer" ? "A seat just opened up" : kind === "session_cancelled" ? "This class is cancelled" : "A message about your class";
  const lead = kind === "enrolled"
    ? `You're booked into ${serviceName} on ${when}.`
    : kind === "waitlisted"
      ? `${serviceName} on ${when} is full. We'll message you the moment a seat opens, and you'll have time to take it.`
      : kind === "offer"
        ? `A seat in ${serviceName} on ${when} is yours if you want it. Take it within ${minutes} minutes, or it goes to the next person.`
        : kind === "session_cancelled"
          ? `${brand.businessName} has cancelled ${serviceName} on ${when}. We're sorry.`
          : `${brand.businessName} wrote about ${serviceName} on ${when}.`;
  return (
    <EmailLayout brand={brand} preview={lead}>
      <Title>{title}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{lead}</Paragraph>
      {message ? <Paragraph>{message}</Paragraph> : null}
      {kind !== "session_cancelled" && seatUrl ? (
        <ActionButton href={seatUrl} accent={brand.accentColor}>{kind === "offer" ? "Take this seat" : "See or cancel your place"}</ActionButton>
      ) : null}
    </EmailLayout>
  );
}

ClassNoticeEmail.PreviewProps = {
  brand: previewBrand, customerName: "Priya", kind: "offer", serviceName: "Morning yoga", when: "Tue, 24 Nov 2026, 6:00 pm IST",
  message: "", minutes: 120, seatUrl: "https://kalendr.example/class/token",
} satisfies ClassNoticeEmailProps;
