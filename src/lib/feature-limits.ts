import type { FeatureKey, Features } from "@/lib/business-types";

const credentialFields = ["qualifications", "registrationNumber"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies a business's switched-off features to a request body. Fields a switched-off feature owns are dropped
 * (date of birth, qualifications); a request that only makes sense with the feature on (booking for a dependant)
 * is refused by naming the feature.
 */
export function limitToFeatures<T>(input: T, features: Features): { value: T; refused: FeatureKey | null } {
  if (!isRecord(input)) return { value: input, refused: null };
  if (!features.dependents) {
    const nested = isRecord(input.newPatient) ? input.newPatient : null;
    if (input.bookingFor === "dependent" || input.isDependent === true || nested?.isDependent === true) {
      return { value: input, refused: "dependents" };
    }
  }
  const strip = (record: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...record };
    if (!features.dateOfBirth) delete copy.dateOfBirth;
    if (!features.providerCredentials) for (const field of credentialFields) delete copy[field];
    return copy;
  };
  const value = strip(input);
  if (isRecord(value.newPatient)) value.newPatient = strip(value.newPatient);
  return { value: value as T, refused: null };
}
