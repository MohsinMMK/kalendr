/**
 * The booking asks for one "Full name". It still carries first and last name, so the text is split here.
 * Spaces are collapsed, the last word is the last name and the rest the first. One word is a first name with an
 * empty last name.
 */
export function splitFullName(full: string): { firstName: string; lastName: string } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { firstName: words[0] ?? "", lastName: "" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] ?? "" };
}

/** The name as a person would read it back: `Priya`, or `Priya Nair`, never with a trailing space. */
export function joinFullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();
}

/** The message for a full name that is empty, under two characters, or has a part over 80 characters, or null when it is fine. */
export function fullNameProblem(firstName: string, lastName: string, whose = "your"): string | null {
  if (joinFullName(firstName, lastName).length < 2) return `Enter ${whose} full name`;
  if (firstName.trim().length > 80 || lastName.trim().length > 80) return "Shorten the name: the first part, or the last word, is over 80 characters";
  return null;
}
