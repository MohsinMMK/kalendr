import { notFound, permanentRedirect } from "next/navigation";

import { unavailablePage } from "@/features/booking/unavailable-page";

import { getBusinessCatalog } from "../catalog";

interface PersonRedirectProps {
  params: Promise<{ clinicSlug: string; person: string }>;
}

/**
 * `/b/[business]/[person]` is the short link to one person's page: their services and next openings. The page itself lives
 * at `/b/[business]/team/[personId]`, so this finds the person by id and moves there. Anything else is not found.
 */
export default async function PersonShortLink({ params }: PersonRedirectProps) {
  const { clinicSlug, person } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);
  const found = catalog.practitioners.find((entry) => entry.id === person);
  if (!found) notFound();
  permanentRedirect(`/b/${catalog.clinic.slug}/team/${found.id}`);
}
