import { Text } from "react-email";

import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, styles, Title } from "./_shared/layout";

export interface SummaryRow {
  label: string;
  /** Already written for reading: "42", "₹18,500". */
  value: string;
  /** "up 12%", "down 5%", "no change". */
  change: string;
}

export interface OwnerSummaryEmailProps {
  brand: EmailBrand;
  /** "week" or "month". */
  periodWord: string;
  /** "16 November to 22 November". */
  periodLabel: string;
  rows: SummaryRow[];
  reportsUrl: string;
}

export function subject({ periodWord, periodLabel }: OwnerSummaryEmailProps): string {
  return `Your ${periodWord} in numbers: ${periodLabel}`;
}

export default function OwnerSummaryEmail({ brand, periodWord, periodLabel, rows, reportsUrl }: OwnerSummaryEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`How ${brand.businessName} did, ${periodLabel}`}>
      <Title>{`Your ${periodWord} in numbers`}</Title>
      <Paragraph>{`${periodLabel}. The change is against the ${periodWord} before.`}</Paragraph>
      {rows.map((row) => (
        <Text key={row.label} style={{ ...styles.text, margin: "0 0 6px" }}>{`${row.label}: ${row.value} (${row.change})`}</Text>
      ))}
      <ActionButton href={reportsUrl} accent={brand.accentColor}>See the full reports</ActionButton>
      <Paragraph>You get this because you are an owner. Choose weekly, monthly or off under Notifications in your profile menu.</Paragraph>
    </EmailLayout>
  );
}

OwnerSummaryEmail.PreviewProps = {
  brand: previewBrand,
  periodWord: "week",
  periodLabel: "16 November to 22 November",
  rows: [
    { label: "Bookings", value: "42", change: "up 12%" },
    { label: "Cancellations", value: "3", change: "down 25%" },
    { label: "No-shows", value: "1", change: "no change" },
    { label: "New customers", value: "9", change: "up from none" },
    { label: "Revenue", value: "₹18,500", change: "up 8%" },
  ],
  reportsUrl: "https://kalendr.example/reports",
} satisfies OwnerSummaryEmailProps;
