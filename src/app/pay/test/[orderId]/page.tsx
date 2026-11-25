import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookingShell } from "@/features/booking/booking-shell";
import { TestCheckout } from "@/features/booking/test-checkout";
import { safeReturnPath, testCheckoutEnabled } from "@/lib/test-checkout";

export const metadata: Metadata = {
  title: "Test checkout",
  description: "A stand-in payment page for testing. No real money moves.",
  robots: { index: false, follow: false },
};

interface TestCheckoutPageProps {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The test checkout. It is a page of the app, so it answers 404 in production. */
export default async function TestCheckoutPage({ params, searchParams }: TestCheckoutPageProps) {
  if (!testCheckoutEnabled()) notFound();
  const { orderId } = await params;
  const query = await searchParams;
  // Only a page under /manage/ on this site. A missing or foreign address is a dead page, not a redirect.
  const returnTo = safeReturnPath(first(query.returnTo));
  if (!returnTo || !/^[A-Za-z0-9_.-]{1,120}$/.test(orderId)) notFound();
  // Shown for orientation only. The server works out the real amount from its own order.
  const amount = Number(first(query.amount));
  const currency = /^[A-Z]{3}$/.test(first(query.currency) ?? "") ? (first(query.currency) as string) : "INR";
  const business = first(query.business)?.slice(0, 120) || null;

  return (
    <BookingShell clinicName={business ?? undefined}>
      <TestCheckout orderId={orderId} returnTo={returnTo} amountMinor={Number.isInteger(amount) && amount > 0 ? amount : null} currency={currency} businessName={business} />
    </BookingShell>
  );
}
