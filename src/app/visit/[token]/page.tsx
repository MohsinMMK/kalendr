import type { Metadata } from "next";

import { CustomerVisit } from "@/features/video/customer-visit";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your video visit",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** The customer's video visit page. The link is their private manage link; everything on it is fetched by the page itself. */
export default async function VisitPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ test?: string | string[] }>;
}) {
  const [{ token }, { test }] = await Promise.all([params, searchParams]);
  return <CustomerVisit token={token} testOnly={test === "1"} />;
}
