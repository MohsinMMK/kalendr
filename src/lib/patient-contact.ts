export type PatientContactKind = "email" | "phone";

/** Mirrors the database's kalendr_normalize_phone(). India is the default country for a bare ten-digit number. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

/** The canonical form used to match clinic records, or null when it can't be a real contact. */
export function normalizeContact(kind: PatientContactKind, raw: string): string | null {
  if (kind === "email") {
    const email = raw.trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }
  const phone = normalizePhone(raw);
  return phone.length >= 11 && phone.length <= 15 ? phone : null;
}

/** Enough for someone to recognise their own contact, not enough to learn someone else's. */
export function maskContact(kind: PatientContactKind, value: string): string {
  if (kind === "phone") return `•••• ${value.slice(-4)}`;
  const [name = "", domain = ""] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}
