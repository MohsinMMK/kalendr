import { Link } from "react-email";
import type { ReactNode } from "react";

import { previewBrand, type EmailBrand } from "./_shared/brand";
import { EmailLayout, Paragraph } from "./_shared/layout";

/**
 * An owner-written message from a workflow (feature 5). The text is already filled in with the booking's
 * details; this only lays it out in the business's branded email. Web addresses become links.
 */
export interface WorkflowMessageEmailProps {
  brand: EmailBrand;
  subject: string;
  body: string;
}

export function subject(props: WorkflowMessageEmailProps): string {
  return props.subject;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+)/g;

function withLinks(line: string, accent: string): ReactNode[] {
  return line.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1
      ? <Link key={index} href={part} style={{ color: accent, textDecoration: "underline" }}>{part}</Link>
      : part,
  );
}

export default function WorkflowMessageEmail({ brand, subject: heading, body }: WorkflowMessageEmailProps) {
  const paragraphs = body.split(/\n{2,}/).map((block) => block.split("\n"));
  return (
    <EmailLayout brand={brand} preview={heading}>
      {paragraphs.map((lines, index) => (
        <Paragraph key={index}>
          {lines.flatMap((line, lineIndex) => [lineIndex > 0 ? <br key={`br-${lineIndex}`} /> : null, ...withLinks(line, brand.accentColor)])}
        </Paragraph>
      ))}
    </EmailLayout>
  );
}

WorkflowMessageEmail.PreviewProps = {
  brand: previewBrand,
  subject: "Reminder: Check-up on Mon, 16 Nov at 10:30 am",
  body: "Hi Priya,\n\nThis is a reminder from Riverbend Care.\n\nChange or cancel: https://kalendr.example/manage/token",
} satisfies WorkflowMessageEmailProps;

