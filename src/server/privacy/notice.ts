/**
 * The privacy notice shown at booking and at sign-in. A business may store its own text in `privacy_notices`;
 * until it does, the built-in text below is used.
 *
 * The built-in wording is a starting point. It has not been reviewed by a lawyer yet (see docs/privacy-centre.md);
 * whoever launches this must have it reviewed first.
 */
import "server-only";

import { and, desc, eq, lte, sql } from "drizzle-orm";

import { requireDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { privacyNotices } from "@/db/schema";
import { consentPurposes, type ConsentPurpose } from "./rules";

export const NOTICE_VERSION = "2026-11";
export const noticeLanguages = ["en", "hi"] as const;
export type NoticeLanguage = (typeof noticeLanguages)[number];

export interface PrivacyNoticeText {
  version: string;
  language: string;
  title: string;
  /** One or two plain sentences shown beside each switch. */
  purposes: Record<ConsentPurpose, { label: string; text: string }>;
  /** The notice in full, as short paragraphs. */
  paragraphs: string[];
  /** True when this is the built-in text and the business has not written its own. */
  isDefault: boolean;
}

const defaultNotices: Record<NoticeLanguage, Omit<PrivacyNoticeText, "version" | "language" | "isDefault">> = {
  en: {
    title: "How we use your information",
    purposes: {
      appointment_messages: {
        label: "Appointment messages",
        text: "Confirmations, reminders and changes to your bookings, by email and, if you agree, by text or WhatsApp.",
      },
      marketing_messages: {
        label: "News and offers",
        text: "Offers and news from us. We only send these if you say yes, and you can stop at any time.",
      },
      reviews: {
        label: "Review requests",
        text: "A message after your visit asking how it went.",
      },
      records_sharing: {
        label: "Sharing records with you",
        text: "Letting you see documents such as notes and reports in your portal, and telling you when one is ready.",
      },
    },
    paragraphs: [
      "We collect your name, contact details and the details of your bookings so we can look after your appointments.",
      "Each choice above is separate. Saying no to one does not change the others, and you will still get messages about your own bookings if you say no to news and offers.",
      "You can change a choice at any time in your portal, or reply STOP to a text or WhatsApp message.",
      "You can ask for a copy of your information, ask us to correct it, or ask us to erase it. Some records, such as payments and health records, we must keep for a set time. If we keep something, we will tell you what and why.",
      "Your information is held by us and by the services that help us run bookings, such as email and message delivery. The privacy summary lists them.",
    ],
  },
  hi: {
    title: "हम आपकी जानकारी का उपयोग कैसे करते हैं",
    purposes: {
      appointment_messages: {
        label: "अपॉइंटमेंट संदेश",
        text: "आपकी बुकिंग की पुष्टि, याद दिलाने वाले संदेश और बदलाव, ईमेल से और आपकी सहमति हो तो टेक्स्ट या व्हाट्सऐप से।",
      },
      marketing_messages: {
        label: "ऑफ़र और समाचार",
        text: "हमारी ओर से ऑफ़र और समाचार। ये तभी भेजे जाते हैं जब आप हाँ कहें, और आप कभी भी रोक सकते हैं।",
      },
      reviews: {
        label: "समीक्षा का अनुरोध",
        text: "आपकी विज़िट के बाद एक संदेश कि अनुभव कैसा रहा।",
      },
      records_sharing: {
        label: "आपके साथ रिकॉर्ड साझा करना",
        text: "नोट और रिपोर्ट जैसे दस्तावेज़ आपके पोर्टल में दिखाना, और तैयार होने पर बताना।",
      },
    },
    paragraphs: [
      "आपकी अपॉइंटमेंट संभालने के लिए हम आपका नाम, संपर्क और बुकिंग का विवरण लेते हैं।",
      "ऊपर हर विकल्प अलग है। एक को मना करने से बाकी नहीं बदलते, और ऑफ़र को मना करने पर भी आपकी अपनी बुकिंग के संदेश मिलते रहेंगे।",
      "आप अपने पोर्टल में कभी भी विकल्प बदल सकते हैं, या किसी टेक्स्ट या व्हाट्सऐप संदेश का जवाब STOP लिखकर दे सकते हैं।",
      "आप अपनी जानकारी की प्रति माँग सकते हैं, उसे सही करवा सकते हैं, या मिटाने का अनुरोध कर सकते हैं। भुगतान और स्वास्थ्य रिकॉर्ड जैसे कुछ रिकॉर्ड हमें तय समय तक रखने होते हैं। कुछ रखा जाएगा तो हम बताएँगे कि क्या और क्यों।",
      "आपकी जानकारी हमारे पास और बुकिंग चलाने में मदद करने वाली सेवाओं के पास रहती है, जैसे ईमेल और संदेश भेजने वाली सेवाएँ।",
    ],
  },
};

export function noticeLanguageFor(value: string | null | undefined): NoticeLanguage {
  const base = (value ?? "").toLowerCase().split(/[-_]/, 1)[0];
  return (noticeLanguages as readonly string[]).includes(base ?? "") ? (base as NoticeLanguage) : "en";
}

export function defaultNotice(language: string | null | undefined): PrivacyNoticeText {
  const chosen = noticeLanguageFor(language);
  return { version: NOTICE_VERSION, language: chosen, isDefault: true, ...defaultNotices[chosen] };
}

function isPurposeText(value: unknown): value is { label: string; text: string } {
  return Boolean(value) && typeof value === "object"
    && typeof (value as { label?: unknown }).label === "string" && typeof (value as { text?: unknown }).text === "string";
}

/** Reads a stored row back into the notice shape, falling back to the built-in text for anything missing or malformed. */
export function noticeFromStored(row: { version: string; language: string; purposes: Record<string, unknown> }): PrivacyNoticeText {
  const base = defaultNotice(row.language);
  const stored = row.purposes;
  const purposes = { ...base.purposes };
  const storedPurposes = stored.purposes && typeof stored.purposes === "object" ? stored.purposes as Record<string, unknown> : {};
  for (const purpose of consentPurposes) {
    const entry = storedPurposes[purpose];
    if (isPurposeText(entry)) purposes[purpose] = { label: entry.label.slice(0, 80), text: entry.text.slice(0, 400) };
  }
  const paragraphs = Array.isArray(stored.paragraphs)
    ? stored.paragraphs.filter((line): line is string => typeof line === "string").slice(0, 30).map((line) => line.slice(0, 1_500))
    : [];
  return {
    version: row.version,
    language: row.language,
    title: typeof stored.title === "string" ? stored.title.slice(0, 120) : base.title,
    purposes,
    paragraphs: paragraphs.length > 0 ? paragraphs : base.paragraphs,
    isDefault: false,
  };
}

/**
 * The notice a customer should see now, in their language: the business's newest effective text for that language,
 * else the built-in text. Call inside the business's own transaction. Public booking and sign-in pages use this.
 */
export async function getPrivacyNoticeIn(transaction: KalendrTransaction, tenantId: string, language: string | null | undefined): Promise<PrivacyNoticeText> {
  const chosen = noticeLanguageFor(language);
  const [row] = await transaction
    .select({ version: privacyNotices.version, language: privacyNotices.language, purposes: privacyNotices.purposes })
    .from(privacyNotices)
    .where(and(eq(privacyNotices.tenantId, tenantId), eq(privacyNotices.language, chosen), lte(privacyNotices.effectiveFrom, new Date())))
    .orderBy(desc(privacyNotices.effectiveFrom))
    .limit(1);
  return row ? noticeFromStored(row) : defaultNotice(chosen);
}

/** The notice for one business and language, in a transaction of its own. */
export function getPrivacyNotice(tenantId: string, language: string | null | undefined): Promise<PrivacyNoticeText> {
  return withTenant(tenantId, (transaction) => getPrivacyNoticeIn(transaction, tenantId, language));
}

/**
 * The notice for a public page, found by the business's slug. An unknown slug gets the built-in text, so the answer
 * does not reveal which businesses exist. The booking page shows this beside its consent boxes.
 */
export async function getPublicPrivacyNotice(clinicSlug: string, language: string | null | undefined): Promise<PrivacyNoticeText> {
  const [tenant] = await requireDatabase().execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${clinicSlug}, null)`);
  return tenant ? getPrivacyNotice(tenant.tenant_id, language) : defaultNotice(language);
}
