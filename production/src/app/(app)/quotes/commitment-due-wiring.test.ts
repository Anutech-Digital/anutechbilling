/**
 * R-2046 — one way per task: the Commitment due section opens the SAME Record payment sheet and
 * the SAME Customer stopped dialog + mutation as the quote page (no second copy to drift).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = join(process.cwd(), "src", "app", "(app)", "quotes");
const list = readFileSync(join(here, "page.tsx"), "utf8");
const detail = readFileSync(join(here, "[id]", "page.tsx"), "utf8");

describe("Commitment due wiring", () => {
  it("the list reads ?commitment= from the URL and renders the strip + section", () => {
    expect(list).toMatch(/useUrlChoice<[^>]*>\("commitment", COMMITMENT_CHOICES/);
    expect(list).toContain("<CommitmentDueStrip");
    expect(list).toContain("<CommitmentDueSection");
  });

  it("Record payment is the shared RecordQuotePaymentDialog (record_payment RPC)", () => {
    expect(list).toContain('import { RecordQuotePaymentDialog } from "../payments/record-quote-payment"');
    expect(list).toContain("<RecordQuotePaymentDialog");
  });

  it("Customer stopped is the quote page's dialog and the one shared mutation", () => {
    expect(list).toContain('import { CustomerStoppedDialog } from "./[id]/customer-stopped-dialog"');
    expect(list).toContain("useCustomerStopped(");
    expect(detail).toContain("useCustomerStopped(");
    /* the old inline copy on the quote page is gone */
    expect(detail).not.toMatch(/fetch\(`\/api\/quotes\/\$\{[^}]+\}\/customer-stopped`/);
  });
});
