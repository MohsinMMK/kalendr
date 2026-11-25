import type { PublicReview } from "@/lib/reviews";

/**
 * Sample reviews for the preview. They speak about the visit in general words, so they read
 * the same whether the preview is shown as a clinic, a salon or a workshop.
 */
const day = 24 * 60 * 60 * 1000;
const base = Date.UTC(2026, 9, 30, 10, 0, 0);
const at = (daysAgo: number) => new Date(base - daysAgo * day).toISOString();

export const previewReviews: PublicReview[] = [
  { id: "preview_review_1", rating: 5, comment: "On time, friendly and clear about what happens next. Booking took a minute.", displayName: "Priya R.", practitionerId: "practitioner_asha", serviceId: "service_cleaning", createdAt: at(2) },
  { id: "preview_review_2", rating: 5, comment: "Explained everything before starting. I felt in good hands.", displayName: "Daniel M.", practitionerId: "practitioner_asha", serviceId: "service_consultation", createdAt: at(6) },
  { id: "preview_review_3", rating: 4, comment: "Great work. I waited about ten minutes past my time, but it was worth it.", displayName: "Kavya S.", practitionerId: "practitioner_rohan", serviceId: "service_consultation", createdAt: at(9) },
  { id: "preview_review_4", rating: 5, comment: null, displayName: "Arjun P.", practitionerId: "practitioner_mira", serviceId: "service_cleaning", createdAt: at(13) },
  { id: "preview_review_5", rating: 4, comment: "Easy to reschedule online when my plans changed.", displayName: "Leah T.", practitionerId: "practitioner_asha", serviceId: "service_cleaning", createdAt: at(18) },
  { id: "preview_review_6", rating: 5, comment: "Calm, careful and quick. Will book again.", displayName: "Nikhil V.", practitionerId: "practitioner_rohan", serviceId: "service_consultation", createdAt: at(24) },
  { id: "preview_review_7", rating: 5, comment: "Very gentle and took time to answer my questions.", displayName: "Fatima K.", practitionerId: "practitioner_mira", serviceId: "service_cleaning", createdAt: at(31) },
];
