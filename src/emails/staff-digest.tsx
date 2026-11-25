import { Text } from "react-email";

import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, styles, Title } from "./_shared/layout";

export interface DigestLine {
  time: string;
  service: string;
  firstName: string;
}

export interface StaffDigestEmailProps {
  brand: EmailBrand;
  /** "Friday 20 November". */
  dayLabel: string;
  today: DigestLine[];
  todayCount: number;
  waiting: number;
  cancelled: DigestLine[];
  staffUrl: string;
}

export function subject({ todayCount, waiting, dayLabel }: StaffDigestEmailProps): string {
  const parts = [todayCount === 1 ? "1 booking" : `${todayCount} bookings`, ...(waiting ? [`${waiting} waiting for a yes`] : [])];
  return `${dayLabel}: ${parts.join(", ")}`;
}

function Lines({ lines, empty }: { lines: DigestLine[]; empty: string }) {
  if (lines.length === 0) return <Paragraph>{empty}</Paragraph>;
  return (
    <>
      {lines.map((line, index) => (
        <Text key={`${line.time}-${index}`} style={{ ...styles.text, margin: "0 0 4px" }}>{`${line.time} · ${line.firstName} · ${line.service}`}</Text>
      ))}
    </>
  );
}

export default function StaffDigestEmail({ brand, dayLabel, today, todayCount, waiting, cancelled, staffUrl }: StaffDigestEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`${todayCount} on today, ${waiting} waiting`}>
      <Title>{`Your day: ${dayLabel}`}</Title>
      <Paragraph>{todayCount === 0 ? "Nothing is booked today." : todayCount === 1 ? "One booking today:" : `${todayCount} bookings today:`}</Paragraph>
      <Lines lines={today} empty="" />
      {todayCount > today.length ? <Paragraph>{`…and ${todayCount - today.length} more in the schedule.`}</Paragraph> : null}
      {waiting > 0 ? <Paragraph>{waiting === 1 ? "1 request is waiting for your yes." : `${waiting} requests are waiting for your yes.`}</Paragraph> : null}
      {cancelled.length > 0 ? (
        <>
          <Paragraph>Cancelled yesterday:</Paragraph>
          <Lines lines={cancelled} empty="" />
        </>
      ) : null}
      <ActionButton href={staffUrl} accent={brand.accentColor}>Open the schedule</ActionButton>
      <Paragraph>This is your morning summary. Change the time, or turn it off, under Notifications in your profile menu.</Paragraph>
    </EmailLayout>
  );
}

StaffDigestEmail.PreviewProps = {
  brand: previewBrand,
  dayLabel: "Friday 20 November",
  today: [{ time: "9:00 am", firstName: "Asha", service: "Dental consultation" }, { time: "10:30 am", firstName: "Ravi", service: "Cleaning" }],
  todayCount: 2,
  waiting: 1,
  cancelled: [{ time: "Thu 4:00 pm", firstName: "Meera", service: "Whitening" }],
  staffUrl: "https://kalendr.example/schedule",
} satisfies StaffDigestEmailProps;
