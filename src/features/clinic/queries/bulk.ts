interface BulkFailure {
  id: string;
  message: string;
}

export interface BulkOutcome {
  done: string[];
  failed: BulkFailure[];
}

/**
 * Runs one change over several appointments, one after another, so the version of each is current when it is
 * sent and a clash on one visit never stops the rest. Returns who was done and who was refused, with the reason.
 */
export async function runBulk(ids: readonly string[], perform: (id: string) => Promise<unknown>, describe: (error: unknown) => string): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { done: [], failed: [] };
  for (const id of ids) {
    try {
      await perform(id);
      outcome.done.push(id);
    } catch (error: unknown) {
      outcome.failed.push({ id, message: describe(error) });
    }
  }
  return outcome;
}

/** "Cancelled 4 appointments" or "Moved 3, and 2 could not be moved". */
export function bulkSummary(outcome: BulkOutcome, verb: { past: string; noun: string; nounPlural: string; couldNot: string }): string {
  const noun = (count: number) => count === 1 ? verb.noun : verb.nounPlural;
  if (outcome.failed.length === 0) return `${verb.past} ${outcome.done.length} ${noun(outcome.done.length)}`;
  if (outcome.done.length === 0) return `No ${verb.nounPlural} ${verb.past.toLowerCase()}. ${outcome.failed.length} ${verb.couldNot}`;
  return `${verb.past} ${outcome.done.length}. ${outcome.failed.length} ${verb.couldNot}`;
}
