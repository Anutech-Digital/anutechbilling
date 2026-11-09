/**
 * R-2540 (R-2536 leftover): a Zoho FY scan read BEFORE R-2536 kept no billing address (the
 * `billingAddress` key is missing from its facts; after R-2536 it is there, null when Zoho had
 * none). The import then has no Zoho address to store: a same-registration invoice still gets the
 * customer's (the snapshot trigger fills it), but a same-PAN branch invoice ("pan" / "chosen" match)
 * gets none. The preview counts the to-import rows like that so the owner reads from Zoho again.
 * Pure.
 */
import type { PlannedSale } from "./plan";

export interface StaleAddress {
  /** To-import invoices read before Zoho's address was kept. */
  count: number;
  /** Of those, another branch of the customer — they would come in with no address. */
  branch: number;
}

export function staleAddressCount(rows: readonly PlannedSale[]): StaleAddress {
  let count = 0;
  let branch = 0;
  for (const r of rows) {
    if (r.verdict !== "import") continue;
    if ("billingAddress" in (r.facts as object)) continue;
    count += 1;
    if (r.matchedBy === "pan" || r.matchedBy === "chosen") branch += 1;
  }
  return { count, branch };
}
