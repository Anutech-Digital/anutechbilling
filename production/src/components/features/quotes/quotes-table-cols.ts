/**
 * R-2264 (Design D4) — column budget of the /quotes desktop table.
 *
 * Measured 31 Oct at 1280×800 with the sidebar open: the table's card is ~944px wide.
 * The old auto layout gave the Quote chip 175px and pushed the Actions column
 * ("Generate invoice") behind a horizontal scroll. With `table-fixed` the columns
 * below keep their width; Customer and Plan (width: null) share what is left and
 * truncate to one line with the full text in a tooltip — on a wider screen they grow.
 */
export type QuotesColKey =
  | "quote"
  | "customer"
  | "plan"
  | "amount"
  | "margin"
  | "status"
  | "validity"
  | "actions";

export const QUOTES_TABLE_COLS: ReadonlyArray<{ key: QuotesColKey; width: number | null }> = [
  { key: "quote", width: 100 },
  { key: "customer", width: null },
  { key: "plan", width: null },
  { key: "amount", width: 112 },
  { key: "margin", width: 80 },
  { key: "status", width: 148 },
  { key: "validity", width: 96 },
  { key: "actions", width: 188 },
];

/** Content width of the table's card at a 1280px viewport with the sidebar open. */
export const QUOTES_TABLE_BUDGET_PX = 944;

/** The narrowest Customer / Plan may get at that width and still be readable. */
export const QUOTES_FLEX_MIN_PX = 100;
