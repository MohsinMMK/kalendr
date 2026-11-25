import { businessTypeIds, businessTypes, type BusinessTypeId, type Term } from "@/lib/business-types";

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Healthcare reads "visit"; every other type reads its one word for a booking. */
function bookingTerm(id: BusinessTypeId): Term {
  const { terms, aliases } = businessTypes[id];
  return aliases?.visit ?? terms.appointment;
}

type Words = { customer: Term; provider: Term; booking: Term };

/** Who books, who serves them and what a booking is called, in a business type's own words. */
export function wordsFor(id: BusinessTypeId): Words {
  const { terms } = businessTypes[id];
  return { customer: terms.customer, provider: terms.provider, booking: bookingTerm(id) };
}

/** The three plural words, as shown on a card. */
function pluralWords(id: BusinessTypeId): string[] {
  const words = wordsFor(id);
  return [words.customer, words.provider, words.booking].map((term) => capitalize(term.plural));
}

export { capitalize };

/** Every business type, in setup order, with its words. */
export const allTypes = businessTypeIds.map((id) => ({ ...businessTypes[id], words: pluralWords(id) }));
