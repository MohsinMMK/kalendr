import { z } from "zod";

import type { WeeklyHours } from "./availability-setup";
import { defaultBusinessType, type BusinessTypeId, type TermKey } from "./business-types";

/**
 * What a new business starts with (feature 11). Registration asks for a business type; the type picks one of these
 * templates, and the account is filled from it: typical services with durations and prices, opening hours, one booking
 * question, and the business's own words. The owner then edits rather than starts from blank. Reminder workflows come
 * from `workflowPresetsFor` (feature 5), keyed by the template's `businessType`.
 *
 * The broad `businessType` decides the product's words and features; the template only adds what is specific, such as
 * "stylist" for a salon or "student" for tutoring. Prices are rupees, the default currency of a new business.
 */

export const onboardingTemplateIds = [
  "general_practice", "dental", "physiotherapy", "salon", "spa", "barber", "tutoring", "consulting", "fitness", "other",
] as const;
export type OnboardingTemplateId = (typeof onboardingTemplateIds)[number];
export const onboardingTemplateSchema = z.enum(onboardingTemplateIds);

export interface TemplateService {
  name: string;
  description: string;
  durationMinutes: number;
  /** Whole rupees. 0 or absent means free to book, shown with no price. */
  priceRupees?: number;
  bookingMode: "instant" | "request";
}

export interface TemplateQuestion {
  label: string;
  type: "short_text" | "long_text" | "yes_no";
  required: boolean;
  help?: string;
}

export interface OnboardingTemplate {
  id: OnboardingTemplateId;
  label: string;
  /** One line on the registration card. */
  description: string;
  businessType: BusinessTypeId;
  /** Words the owner's own business uses, on top of the broad type's words. */
  words: Partial<Record<TermKey, { singular: string; plural: string }>>;
  /** The calendar profile the owner gets when they take bookings themselves. */
  owner: { title: string; specialty: string };
  services: TemplateService[];
  hours: WeeklyHours;
  /** One question on the booking form. Nothing is required that a first-time customer cannot answer. */
  question: TemplateQuestion;
}

const range = (start: string, end: string) => ({ start, end });
const week = (days: Array<1 | 2 | 3 | 4 | 5 | 6 | 7>, ranges: Array<{ start: string; end: string }>): WeeklyHours => {
  const hours: WeeklyHours = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
  for (const day of days) hours[String(day) as keyof WeeklyHours] = ranges;
  return hours;
};

const clinicHours = week([1, 2, 3, 4, 5], [range("09:00", "13:00"), range("14:00", "18:00")]);
const salonHours = week([2, 3, 4, 5, 6, 7], [range("10:00", "19:00")]);

export const onboardingTemplates: Record<OnboardingTemplateId, OnboardingTemplate> = {
  general_practice: {
    id: "general_practice", label: "General practice", description: "Family doctors and general clinics.", businessType: "healthcare",
    words: {}, owner: { title: "Physician", specialty: "General medicine" },
    services: [
      { name: "Consultation", description: "Meet the doctor and plan next steps.", durationMinutes: 30, priceRupees: 500, bookingMode: "instant" },
      { name: "Follow-up", description: "A short review after an earlier visit.", durationMinutes: 20, priceRupees: 300, bookingMode: "instant" },
      { name: "Health check", description: "A longer preventive check-up.", durationMinutes: 45, priceRupees: 1200, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5, 6], [range("09:00", "13:00"), range("16:00", "19:00")]),
    question: { label: "What would you like to see the doctor about?", type: "long_text", required: false },
  },
  dental: {
    id: "dental", label: "Dental", description: "Dental clinics and orthodontists.", businessType: "dental",
    words: {}, owner: { title: "Dentist", specialty: "General dentistry" },
    services: [
      { name: "Consultation", description: "A first visit or a review of a dental concern.", durationMinutes: 30, priceRupees: 500, bookingMode: "instant" },
      { name: "Cleaning", description: "Scaling and polishing.", durationMinutes: 45, priceRupees: 1500, bookingMode: "instant" },
      { name: "Filling", description: "Treat a cavity.", durationMinutes: 60, priceRupees: 2000, bookingMode: "request" },
    ],
    hours: clinicHours,
    question: { label: "Are you in pain right now?", type: "yes_no", required: false },
  },
  physiotherapy: {
    id: "physiotherapy", label: "Physiotherapy", description: "Physiotherapists and rehab clinics.", businessType: "healthcare",
    words: { provider: { singular: "physiotherapist", plural: "physiotherapists" }, customer: { singular: "patient", plural: "patients" } },
    owner: { title: "Physiotherapist", specialty: "Physiotherapy" },
    services: [
      { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "First assessment", description: "We look at the problem and plan your sessions.", durationMinutes: 45, priceRupees: 800, bookingMode: "instant" },
      { name: "Treatment session", description: "A hands-on session and exercises.", durationMinutes: 45, priceRupees: 700, bookingMode: "instant" },
      { name: "Follow-up", description: "A short check of your progress.", durationMinutes: 30, priceRupees: 500, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5, 6], [range("08:00", "13:00"), range("16:00", "20:00")]),
    question: { label: "Where does it hurt?", type: "short_text", required: false },
  },
  salon: {
    id: "salon", label: "Salon", description: "Hair and beauty salons.", businessType: "wellness",
    words: { provider: { singular: "stylist", plural: "stylists" }, customer: { singular: "client", plural: "clients" } },
    owner: { title: "Stylist", specialty: "Hair" },
    services: [
      { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Haircut", description: "Wash, cut and blow-dry.", durationMinutes: 45, priceRupees: 600, bookingMode: "instant" },
      { name: "Hair colour", description: "Full colour with a consultation.", durationMinutes: 90, priceRupees: 2500, bookingMode: "instant" },
      { name: "Styling", description: "Party or event styling.", durationMinutes: 30, priceRupees: 500, bookingMode: "instant" },
      { name: "Hair spa", description: "A deep conditioning treatment.", durationMinutes: 60, priceRupees: 1200, bookingMode: "instant" },
    ],
    hours: salonHours,
    question: { label: "Anything we should know about your hair?", type: "long_text", required: false },
  },
  spa: {
    id: "spa", label: "Spa", description: "Spas and massage studios.", businessType: "wellness",
    words: { business: { singular: "spa", plural: "spas" }, provider: { singular: "therapist", plural: "therapists" }, customer: { singular: "guest", plural: "guests" } },
    owner: { title: "Therapist", specialty: "Massage" },
    services: [
      { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Full body massage", description: "A relaxing 60-minute massage.", durationMinutes: 60, priceRupees: 2000, bookingMode: "instant" },
      { name: "Facial", description: "Cleanse, exfoliate and hydrate.", durationMinutes: 45, priceRupees: 1500, bookingMode: "instant" },
      { name: "Body scrub", description: "Scrub and wrap.", durationMinutes: 60, priceRupees: 1800, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5, 6, 7], [range("10:00", "20:00")]),
    question: { label: "Any allergies or injuries we should know about?", type: "long_text", required: false },
  },
  barber: {
    id: "barber", label: "Barber", description: "Barber shops and grooming studios.", businessType: "wellness",
    words: { business: { singular: "barbershop", plural: "barbershops" }, provider: { singular: "barber", plural: "barbers" }, customer: { singular: "customer", plural: "customers" } },
    owner: { title: "Barber", specialty: "Haircuts and beards" },
    services: [
      { name: "General visit", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Haircut", description: "A cut and finish.", durationMinutes: 30, priceRupees: 300, bookingMode: "instant" },
      { name: "Beard trim", description: "Shape and trim.", durationMinutes: 20, priceRupees: 150, bookingMode: "instant" },
      { name: "Haircut and beard", description: "Both, in one visit.", durationMinutes: 45, priceRupees: 400, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5, 6, 7], [range("10:00", "21:00")]),
    question: { label: "Any style in mind?", type: "short_text", required: false },
  },
  tutoring: {
    id: "tutoring", label: "Tutoring", description: "Tutors, coaching classes and music teachers.", businessType: "education",
    words: { provider: { singular: "tutor", plural: "tutors" }, customer: { singular: "student", plural: "students" }, appointment: { singular: "lesson", plural: "lessons" }, service: { singular: "lesson type", plural: "lesson types" } },
    owner: { title: "Tutor", specialty: "Teaching" },
    services: [
      { name: "General session", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Trial lesson", description: "Meet the tutor and see if it fits.", durationMinutes: 30, bookingMode: "instant" },
      { name: "One-hour lesson", description: "A regular one-to-one lesson.", durationMinutes: 60, priceRupees: 800, bookingMode: "instant" },
      { name: "Doubt clearing", description: "A short session on specific questions.", durationMinutes: 30, priceRupees: 400, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5, 6], [range("16:00", "20:00")]),
    question: { label: "Which subject and class?", type: "short_text", required: false },
  },
  consulting: {
    id: "consulting", label: "Consulting", description: "Consultants, coaches, lawyers and accountants.", businessType: "professional_services",
    words: { provider: { singular: "consultant", plural: "consultants" }, customer: { singular: "client", plural: "clients" } },
    owner: { title: "Consultant", specialty: "Advisory" },
    services: [
      { name: "General meeting", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Intro call", description: "A short call to understand what you need.", durationMinutes: 20, bookingMode: "instant" },
      { name: "Strategy session", description: "A full working session.", durationMinutes: 60, priceRupees: 3000, bookingMode: "instant" },
      { name: "Follow-up", description: "A check-in after a session.", durationMinutes: 30, priceRupees: 1500, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5], [range("10:00", "13:00"), range("14:00", "18:00")]),
    question: { label: "What would you like to talk about?", type: "long_text", required: false },
  },
  fitness: {
    id: "fitness", label: "Fitness", description: "Personal trainers, gyms and studios.", businessType: "wellness",
    words: { business: { singular: "studio", plural: "studios" }, provider: { singular: "trainer", plural: "trainers" }, customer: { singular: "member", plural: "members" }, appointment: { singular: "session", plural: "sessions" } },
    owner: { title: "Trainer", specialty: "Personal training" },
    services: [
      { name: "General session", description: "Not sure what you need? Book a general visit and talk it through.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Trial session", description: "Try a session with no commitment.", durationMinutes: 30, bookingMode: "instant" },
      { name: "Personal training", description: "A one-to-one session.", durationMinutes: 60, priceRupees: 1000, bookingMode: "instant" },
      { name: "Fitness assessment", description: "Measurements, goals and a plan.", durationMinutes: 45, priceRupees: 600, bookingMode: "instant" },
    ],
    hours: week([1, 2, 3, 4, 5, 6], [range("06:00", "10:00"), range("17:00", "21:00")]),
    question: { label: "What is your main goal?", type: "short_text", required: false },
  },
  other: {
    id: "other", label: "Something else", description: "Any business that takes appointments.", businessType: "other",
    words: {}, owner: { title: "Owner", specialty: "Appointments" },
    services: [{ name: "Appointment", description: "Book a time with us.", durationMinutes: 30, bookingMode: "instant" }],
    hours: week([1, 2, 3, 4, 5], [range("09:00", "17:00")]),
    question: { label: "Anything we should know before you come?", type: "long_text", required: false },
  },
};

export function getOnboardingTemplate(id: unknown): OnboardingTemplate {
  const parsed = onboardingTemplateSchema.safeParse(id);
  return onboardingTemplates[parsed.success ? parsed.data : "other"];
}

/** The template a business of a broad type gets when the form sent none (older callers, the API). */
export function defaultTemplateFor(businessType: BusinessTypeId): OnboardingTemplateId {
  switch (businessType) {
    case "healthcare": return "general_practice";
    case "dental": return "dental";
    case "wellness": return "salon";
    case "professional_services": return "consulting";
    case "education": return "tutoring";
    default: return businessType === defaultBusinessType ? "general_practice" : "other";
  }
}

/** A booking form question's field, in the shape booking forms store. */
export function questionField(question: TemplateQuestion, id = "q_first"): Record<string, unknown> {
  return { id, type: question.type, label: question.label, required: question.required, ...(question.help ? { help: question.help } : {}) };
}
