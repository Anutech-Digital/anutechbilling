/**
 * R-2126 (GP-11) — the personal category list. Pure: no DB, no UI.
 *
 * Decision recorded on the card (owner delegated: "jo tumhe thik lage"): keep the existing
 * 14 household spending buckets (net-worth.ts PERSONAL_EXPENSE_CATEGORIES — imported, never
 * re-spelled, so the Expenses form and the importer cannot drift), add the two spending
 * buckets a bank statement is full of and the 14 have no home for (food delivery / eating
 * out, online shopping), and add income categories so money IN can be grouped too.
 * User-added categories are a DB matter (personal_categories, GP-12) — they extend this
 * list at runtime; nothing here needs to change for them.
 */
import { PERSONAL_EXPENSE_CATEGORIES } from "./net-worth";

/** Spending (money out). The 14 existing buckets first, in their order, then the additions. */
export const PERSONAL_SPEND_CATEGORIES = [
  ...PERSONAL_EXPENSE_CATEGORIES,
  "Food / Dining",
  "Shopping",
] as const;

/** Income (money in). Refund and Cashback are money back, not earnings — reports may net them off spend. */
export const PERSONAL_INCOME_CATEGORIES = [
  "Salary",
  "Business / Freelance",
  "Interest",
  "Dividend",
  "Rent Received",
  "Refund",
  "Cashback",
  "Other Income",
] as const;

export type PersonalSpendCategory = (typeof PERSONAL_SPEND_CATEGORIES)[number];
export type PersonalIncomeCategory = (typeof PERSONAL_INCOME_CATEGORIES)[number];
export type PersonalCategory = PersonalSpendCategory | PersonalIncomeCategory;

export const PERSONAL_CATEGORIES: readonly PersonalCategory[] = [
  ...PERSONAL_SPEND_CATEGORIES,
  ...PERSONAL_INCOME_CATEGORIES,
];

/** One spelling per category: lower case, single spaces (so "food / dining " groups with "Food / Dining"). */
export function categoryKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

const KNOWN = new Map(PERSONAL_CATEGORIES.map((c) => [categoryKey(c), c] as const));

/** The canonical spelling of a built-in category, or null when it is not one. */
export function canonicalCategory(name: string | null | undefined): PersonalCategory | null {
  return KNOWN.get(categoryKey(name ?? "")) ?? null;
}

export function isPersonalCategory(name: string | null | undefined): boolean {
  return canonicalCategory(name) !== null;
}
