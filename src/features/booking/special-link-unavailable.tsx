import { LinkIcon, PhoneIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { BusinessProfile } from "@/lib/terminology";

import { BookingShell } from "./booking-shell";

/**
 * What a spent, expired or revoked special link shows (feature 45). The same page serves all three, so it does not
 * tell a stranger which one it was. A phone number is shown when the business has one.
 */
export function SpecialLinkUnavailable({ clinicName, phone, logoUrl, profile }: { clinicName?: string; phone?: string | null; logoUrl?: string | null; profile: BusinessProfile }) {
  return (
    <BookingShell {...(clinicName ? { clinicName } : {})} {...(phone ? { clinicPhone: phone } : {})} logoUrl={logoUrl ?? null} profile={profile}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><LinkIcon aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1>This link has already been used.</h1></EmptyTitle>
          <EmptyDescription>Contact the business to book.{phone ? ` You can call ${phone}.` : ""}</EmptyDescription>
        </EmptyHeader>
        {phone ? (
          <EmptyContent>
            <Button size="lg" render={<a href={`tel:${phone.replace(/[^+0-9]/g, "")}`} />}><PhoneIcon aria-hidden="true" /> Call {phone}</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </BookingShell>
  );
}
