import { isFilterRule } from "@/components/reui/filters/filters-query";
import type { FilterNode, FilterOperator, FilterQuery, FilterRule } from "@/components/reui/filters/filters-types";

/**
 * Applies a ReUI filter query to rows held in memory. `read` returns the value
 * a field id stands for on one row. A rule with no value yet matches everything,
 * so the grid does not empty out while someone is still picking.
 */
export function matchesFilterQuery<T>(row: T, query: FilterQuery, read: (row: T, fieldId: string) => unknown): boolean {
  return matchesNode(row, query, read);
}

function matchesNode<T>(row: T, node: FilterNode, read: (row: T, fieldId: string) => unknown): boolean {
  if (isFilterRule(node)) return isIncomplete(node) || matchesRule(row, node, read);
  if (node.rules.length === 0) return true;
  return node.combinator === "and"
    ? node.rules.every((child) => matchesNode(row, child, read))
    : node.rules.some((child) => matchesNode(row, child, read));
}

function isIncomplete(rule: FilterRule): boolean {
  if (rule.operator === "empty" || rule.operator === "not_empty") return false;
  return rule.value === undefined || (Array.isArray(rule.value) && rule.value.length === 0);
}

function matchesRule<T>(row: T, rule: FilterRule, read: (row: T, fieldId: string) => unknown): boolean {
  const actual = read(row, rule.path[0] ?? "");
  // A field holding several picks (a multiple choice) reads as a list: "any of" means at least one of them.
  const picks = Array.isArray(actual) ? actual.map(String) : null;
  const text = (picks ? picks.join(", ") : String(actual ?? "")).toLowerCase();
  const wanted = String(rule.value ?? "").toLowerCase();
  const list = Array.isArray(rule.value) ? rule.value.map(String) : [];
  const result = (() => {
    switch (rule.operator) {
      case "contains": return text.includes(wanted);
      case "not_contains": return !text.includes(wanted);
      case "starts_with": return text.startsWith(wanted);
      case "ends_with": return text.endsWith(wanted);
      case "is": return String(actual ?? "") === String(rule.value ?? "");
      case "is_not": return String(actual ?? "") !== String(rule.value ?? "");
      // Numbers compare as numbers, so "12.50" finds a stored 12.5. A row with no number matches none of these.
      case "eq": return numbersOf(actual, rule.value, (a, b) => a === b) ?? String(actual ?? "") === String(rule.value ?? "");
      case "neq": return numbersOf(actual, rule.value, (a, b) => a !== b) ?? String(actual ?? "") !== String(rule.value ?? "");
      case "gt": return numbersOf(actual, rule.value, (a, b) => a > b) ?? false;
      case "gte": return numbersOf(actual, rule.value, (a, b) => a >= b) ?? false;
      case "lt": return numbersOf(actual, rule.value, (a, b) => a < b) ?? false;
      case "lte": return numbersOf(actual, rule.value, (a, b) => a <= b) ?? false;
      case "between": return withinRange(actual, rule.value);
      case "not_between": return !withinRange(actual, rule.value) && Boolean(actual !== "" && actual !== undefined && actual !== null);
      case "is_any_of": return picks ? picks.some((pick) => list.includes(pick)) : list.includes(String(actual ?? ""));
      case "is_none_of": return picks ? !picks.some((pick) => list.includes(pick)) : !list.includes(String(actual ?? ""));
      case "empty": return picks ? picks.length === 0 : actual === undefined || actual === null || actual === "";
      case "not_empty": return !(picks ? picks.length === 0 : actual === undefined || actual === null || actual === "");
      default: return true;
    }
  })();
  return rule.negated ? !result : result;
}

const asNumber = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Compares two values as numbers; `null` when either is not one, so the caller can fall back. */
function numbersOf(actual: unknown, wanted: unknown, compare: (a: number, b: number) => boolean): boolean | null {
  const a = asNumber(actual);
  const b = asNumber(wanted);
  return a === null || b === null ? null : compare(a, b);
}

function withinRange(actual: unknown, range: unknown): boolean {
  const value = asNumber(actual);
  const [low, high] = Array.isArray(range) ? [asNumber(range[0]), asNumber(range[1])] : [null, null];
  if (value === null) return false;
  return (low === null || value >= low) && (high === null || value <= high);
}

/** The operators a pick-from-a-list field offers: no "is empty", since every row has a value. */
export const pickOperators: FilterOperator[] = [
  { value: "is_any_of", label: "is any of", arity: "many", inverse: "is_none_of" },
  { value: "is_none_of", label: "is none of", arity: "many", inverse: "is_any_of" },
];
