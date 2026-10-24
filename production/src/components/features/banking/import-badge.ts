/**
 * R-1692 — the Parse summary's badge says what the Import button will do.
 *
 * It used to show every parsed line ("6 ready to import") while the warning under it said all
 * six were already in the books and the button said "All already imported". The count now
 * comes from the same plan the import runs (planBankImport, R-1691 / R-1644): lines that
 * will actually be added.
 */
export interface ImportBadge {
  text: string;
  kind: "success" | "muted" | "danger";
}

export function importBadge(a: { parsedCount: number; freshCount: number }): ImportBadge {
  if (a.parsedCount === 0) return { text: "Couldn't parse", kind: "danger" };
  if (a.freshCount === 0) return { text: "0 new to import", kind: "muted" };
  return { text: `${a.freshCount} new to import`, kind: "success" };
}

/** R-1692: "1 line", "2 lines" — the Imports card said "1 lines". */
export function linesLabel(n: number): string {
  return `${n} line${n === 1 ? "" : "s"}`;
}
