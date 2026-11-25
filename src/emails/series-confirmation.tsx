import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface SeriesConfirmationEmailProps {
  brand: EmailBrand;
  customerName: string;
  /** `booked` for a new series, `changed` when staff moved it, `cancelled` when the remaining visits were cancelled. */
  kind: "booked" | "changed" | "cancelled";
  serviceName: string;
  /** Every date, in the place's own time zone: "Tue, 24 Nov 2026, 10:00 am IST". */
  dates: string[];
  /** The private link to one visit, so the customer can change or cancel just that one. Empty when cancelled. */
  manageUrl: string;
}

export function subject({ brand, kind, dates }: SeriesConfirmationEmailProps): string {
  const count = `${dates.length} ${brand.words.appointments}`;
  if (kind === "cancelled") return `${brand.businessName}: ${count} cancelled`;
  return `${brand.businessName}: ${count} ${kind === "changed" ? "changed" : "booked"}`;
}

export default function SeriesConfirmationEmail({ brand, customerName, kind, serviceName, dates, manageUrl }: SeriesConfirmationEmailProps) {
  const { words } = brand;
  const heading = kind === "cancelled" ? `Your repeating ${words.appointments} are cancelled` : kind === "changed" ? `Your repeating ${words.appointments} have changed` : `Your repeating ${words.appointments} are booked`;
  const lead = kind === "cancelled"
    ? `${brand.businessName} has cancelled these ${serviceName} ${words.appointments}.`
    : `${brand.businessName} has you booked for ${serviceName} on these dates.`;
  return (
    <EmailLayout brand={brand} preview={`${dates.length} ${words.appointments}, starting ${dates[0] ?? ""}`}>
      <Title>{heading}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{lead}</Paragraph>
      {dates.map((date) => <Paragraph key={date}>{date}</Paragraph>)}
      {kind !== "cancelled" && manageUrl ? (
        <>
          <Paragraph>{`You can change or cancel one ${words.appointment} from its own link. To change all of them, please contact ${brand.businessName}.`}</Paragraph>
          <ActionButton href={manageUrl} accent={brand.accentColor}>{`Manage the first ${words.appointment}`}</ActionButton>
        </>
      ) : null}
    </EmailLayout>
  );
}

SeriesConfirmationEmail.PreviewProps = {
  brand: previewBrand, customerName: "Priya", kind: "booked", serviceName: "Physiotherapy",
  dates: ["Tue, 24 Nov 2026, 10:00 am IST", "Tue, 1 Dec 2026, 10:00 am IST", "Tue, 8 Dec 2026, 10:00 am IST"],
  manageUrl: "https://kalendr.example/manage/token",
} satisfies SeriesConfirmationEmailProps;
