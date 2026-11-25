const reservedSlugs = new Set([
  "about",
  "access-denied",
  "account",
  "admin",
  "api",
  "appointments",
  "auth",
  "billing",
  "book",
  "clinic",
  "dashboard",
  "docs",
  "embed",
  "embed-demo",
  "classes",
  "follow-ups",
  "health",
  "help",
  "login",
  "manage",
  "kalendr",
  "null",
  "offers",
  "campaigns",
  "patients",
  "preview",
  "privacy",
  "register",
  "robots",
  "root",
  "schedule",
  "settings",
  "setup",
  "sign-in",
  "sign-up",
  "signin",
  "signup",
  "sitemap",
  "staff",
  "start",
  "status",
  "support",
  "terms",
  "undefined",
  "www",
]);

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isReservedClinicSlug(slug: string): boolean {
  return reservedSlugs.has(slug);
}

export function normalizeClinicSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function parseClinicSlug(slug: string): { ok: true; value: string } | { ok: false; message: string } {
  const normalized = normalizeClinicSlug(slug);
  if (normalized.length < 2 || normalized.length > 80 || !slugPattern.test(normalized)) {
    return { ok: false, message: "Use 2–80 lowercase letters, numbers, and hyphens." };
  }
  if (isReservedClinicSlug(normalized)) {
    return { ok: false, message: "That booking address is reserved. Choose another." };
  }
  return { ok: true, value: normalized };
}

export function practitionerInitials(name: string): string {
  const ignored = new Set(["dr", "dra", "prof", "professor", "mr", "mrs", "ms", "mx"]);
  const letters = name
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^A-Za-z]/g, ""))
    .filter((part) => part && !ignored.has(part.toLowerCase()))
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (letters || "DR").slice(0, 12);
}
