import { describe, expect, it } from "vitest";

import journal from "../../drizzle/meta/_journal.json";

// Drizzle's migrator applies only journal entries whose `when` is later than the newest
// migration a database already has. An entry with an earlier `when` than the one before it
// is skipped for good on any database that already ran the later one, so the order must hold.
describe("migration journal", () => {
  it("numbers entries in order, matching their file names", () => {
    // A lane's reserved numbers may leave a gap (0052 then 0063) until the lanes in between are merged, so the number in
    // the file name only has to rise and never fall behind the entry's position.
    let previousNumber = -1;
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      const number = Number(entry.tag.slice(0, 4));
      expect(entry.tag).toMatch(/^\d{4}_/);
      expect(number).toBeGreaterThanOrEqual(index);
      expect(number).toBeGreaterThan(previousNumber);
      previousNumber = number;
    });
  });

  it("gives every entry a later timestamp than the one before it", () => {
    for (let index = 1; index < journal.entries.length; index++) {
      const previous = journal.entries[index - 1]!;
      const entry = journal.entries[index]!;
      expect(entry.when, `${entry.tag} must be later than ${previous.tag}`).toBeGreaterThan(previous.when);
    }
  });
});
