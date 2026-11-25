import { Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text } from "react-email";
import type { ReactNode } from "react";

import { readAccent } from "../../lib/brand-theme";
import { safeAccent, type EmailAppointment, type EmailBrand } from "./brand";

const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const styles = {
  body: { backgroundColor: "#f4f4f5", fontFamily: font, margin: 0, padding: "24px 0" },
  container: { backgroundColor: "#ffffff", borderRadius: "8px", margin: "0 auto", maxWidth: "560px", padding: "32px 28px" },
  heading: { color: "#18181b", fontSize: "22px", fontWeight: 600, lineHeight: "30px", margin: "0 0 12px" },
  text: { color: "#3f3f46", fontSize: "15px", lineHeight: "24px", margin: "0 0 12px" },
  muted: { color: "#71717a", fontSize: "13px", lineHeight: "20px", margin: "0 0 8px" },
  detailLabel: { color: "#71717a", fontSize: "12px", letterSpacing: "0.04em", margin: "0", textTransform: "uppercase" as const },
  detailValue: { color: "#18181b", fontSize: "15px", lineHeight: "22px", margin: "0 0 10px" },
  code: { color: "#18181b", fontFamily: "ui-monospace, Menlo, monospace", fontSize: "32px", fontWeight: 600, letterSpacing: "0.3em", margin: "8px 0 16px" },
};

export function EmailLayout({ brand, preview, children }: { brand: Pick<EmailBrand, "businessName" | "logoUrl" | "accentColor" | "showBadge">; preview: string; children: ReactNode }) {
  const accent = safeAccent(brand.accentColor);
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={{ ...styles.container, borderTop: `4px solid ${accent}` }}>
          <Section style={{ marginBottom: "20px" }}>
            {brand.logoUrl ? (
              <Img src={brand.logoUrl} alt={brand.businessName} height="40" style={{ maxHeight: "40px", width: "auto" }} />
            ) : (
              <Text style={{ ...styles.text, color: "#18181b", fontWeight: 600, margin: 0 }}>{brand.businessName}</Text>
            )}
          </Section>
          {children}
          <Hr style={{ borderColor: "#e4e4e7", margin: "24px 0 16px" }} />
          <Text style={styles.muted}>{brand.showBadge === false ? `Sent by ${brand.businessName}.` : `Sent by ${brand.businessName} using Kalendr.`} Reply to this email to reach them.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Heading as="h1" style={styles.heading}>{children}</Heading>;
}

export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={styles.text}>{children}</Text>;
}

export function ActionButton({ href, accent, children }: { href: string; accent: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "20px 0" }}>
      <Button
        href={href}
        style={{ backgroundColor: safeAccent(accent), borderRadius: "6px", color: readAccent(safeAccent(accent)).text, fontSize: "15px", fontWeight: 600, padding: "12px 20px" }}
      >
        {children}
      </Button>
    </Section>
  );
}

/** When, what, with whom and where, plus the manage link and the calendar-file note. */
export function AppointmentDetails({ brand, appointment, previousWhen }: { brand: EmailBrand; appointment: EmailAppointment; previousWhen?: string | null }) {
  const { words } = brand;
  return (
    <Section style={{ backgroundColor: "#fafafa", border: "1px solid #e4e4e7", borderRadius: "6px", margin: "16px 0", padding: "16px 18px" }}>
      {previousWhen ? (
        <>
          <Text style={styles.detailLabel}>Was</Text>
          <Text style={{ ...styles.detailValue, textDecoration: "line-through", color: "#71717a" }}>{previousWhen}</Text>
        </>
      ) : null}
      <Text style={styles.detailLabel}>{previousWhen ? "Now" : "When"}</Text>
      <Text style={styles.detailValue}>{appointment.when}</Text>
      <Text style={styles.detailLabel}>{words.Service}</Text>
      <Text style={styles.detailValue}>{appointment.serviceName}</Text>
      <Text style={styles.detailLabel}>{words.Provider}</Text>
      <Text style={styles.detailValue}>{appointment.providerName}</Text>
      {appointment.place ? (
        <>
          <Text style={styles.detailLabel}>Where</Text>
          <Text style={{ ...styles.detailValue, margin: 0 }}>{appointment.place}</Text>
        </>
      ) : null}
    </Section>
  );
}

export function ManageLink({ brand, appointment, label }: { brand: EmailBrand; appointment: EmailAppointment; label?: string }) {
  if (appointment.manageUrl) {
    return <ActionButton href={appointment.manageUrl} accent={brand.accentColor}>{label ?? `View or change your ${brand.words.appointment}`}</ActionButton>;
  }
  return (
    <Paragraph>
      To make a change, use the link in your first confirmation email
      {appointment.businessPhone ? ` or call ${brand.businessName} on ${appointment.businessPhone}` : ""}.
    </Paragraph>
  );
}

export function CalendarNote() {
  return <Text style={styles.muted}>The attached calendar file adds this to your calendar and updates it if anything changes.</Text>;
}
