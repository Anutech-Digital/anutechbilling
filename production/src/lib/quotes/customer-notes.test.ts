/**
 * R-813 — the customer never reads the staff-only part of a quote's notes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STAFF_NOTE_MARKER, addSeatsCustomerNote, composeQuoteNotes, customerQuoteNotes, staffQuoteNotes,
} from "./customer-notes";

/* The exact text staging showed the customer on Q-5F40-27-0012 (10 Oct 2026). */
const LEGACY =
  "Add-seats pro-rata for subscription c28000ac-1b2c-4d5e-8f90-123456789abc. Effective date 2026-10-09 " +
  "(backdated by Pardeep Sharma on 2026-10-10). 364 of 365 days remaining (factor 99.7260%). IGST 18%.";

function assertCustomerSafe(text: string | null) {
  expect(text ?? "").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text ?? "").not.toMatch(/backdated by/i);
  expect(text ?? "").not.toMatch(/factor/i);
  expect(text ?? "").not.toContain(STAFF_NOTE_MARKER);
}

describe("addSeatsCustomerNote", () => {
  it("names the period in words", () => {
    expect(addSeatsCustomerNote("2026-09-25", "2027-03-31")).toBe("Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata).");
  });
  it("copes with a timestamp end and with missing dates", () => {
    expect(addSeatsCustomerNote("2026-09-25", "2027-03-31T00:00:00Z")).toBe("Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata).");
    expect(addSeatsCustomerNote("2026-09-25", null)).toBe("Additional seats from 25 Sep 2026 (pro-rata).");
    expect(addSeatsCustomerNote(null, null)).toBe("Additional seats, charged pro-rata for the rest of the term.");
  });
});

describe("customerQuoteNotes — new quotes (customer line + staff part)", () => {
  const stored = composeQuoteNotes(addSeatsCustomerNote("2026-09-25", "2027-03-31"), LEGACY);

  it("shows only the customer line", () => {
    const out = customerQuoteNotes(stored);
    expect(out).toBe("Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata).");
    assertCustomerSafe(out);
  });

  it("staff keep the whole audit", () => {
    expect(stored).toContain("backdated by Pardeep Sharma");
    expect(staffQuoteNotes(stored)).toBe(LEGACY);
  });
});

describe("customerQuoteNotes — OLD add-seats quotes (stored data not rewritten)", () => {
  it("replaces the audit with the plain line, end date read from the quote line", () => {
    const out = customerQuoteNotes(LEGACY, [{ name: "Google Workspace Standard · +2 seats (pro-rata from 2026-10-09 to 2027-10-07)" }]);
    expect(out).toBe("Additional seats from 9 Oct 2026 to 7 Oct 2027 (pro-rata).");
    assertCustomerSafe(out);
  });

  it("previous-term quotes end at the LAST line's date", () => {
    const legacyPrev = "Add-seats pro-rata for subscription c28000ac-1b2c-4d5e-8f90-123456789abc. Effective date 2025-08-01 " +
      "(backdated by Abhishek on 2026-06-01). Crosses a term: 45 of 365 days of the previous term (to 2025-09-14) + current term " +
      "from 2025-09-15. 262 of 365 days of the current term (factor 71.7808%). GST 18%.";
    const out = customerQuoteNotes(legacyPrev, [
      { name: "Plan · +2 seats (previous term, pro-rata from 2025-08-01 to 2025-09-14)" },
      { name: "Plan · +2 seats (current term 2025-09-15 to 2026-09-14)" },
    ]);
    expect(out).toBe("Additional seats from 1 Aug 2025 to 14 Sep 2026 (pro-rata).");
    assertCustomerSafe(out);
  });

  it("the oldest format (May 2026: no effective date) still leaks nothing", () => {
    const oldest = "Add-seats pro-rata for subscription c28000ac-1b2c-4d5e-8f90-123456789abc. 200 days remaining (factor 0.548).";
    const out = customerQuoteNotes(oldest, [{ name: "Plan · +3 seats" }]);
    expect(out).toBe("Additional seats, charged pro-rata for the rest of the term.");
    assertCustomerSafe(out);
    expect(staffQuoteNotes(oldest)).toBe(oldest);
  });
});

describe("customerQuoteNotes — ordinary quotes are untouched", () => {
  it("passes a normal note through", () => {
    expect(customerQuoteNotes("Renewal quote. Reply or call us with any questions.")).toBe("Renewal quote. Reply or call us with any questions.");
    expect(staffQuoteNotes("Renewal quote.")).toBe("");
  });
  it("empty → null", () => {
    expect(customerQuoteNotes(null)).toBeNull();
    expect(customerQuoteNotes("   ")).toBeNull();
    expect(customerQuoteNotes(`${STAFF_NOTE_MARKER}\nonly staff`)).toBeNull();
  });
});

/* Every customer surface renders through customerQuoteNotes — a new one that reads
   quote.notes raw would put the audit back in front of the customer. */
describe("customer surfaces use customerQuoteNotes", () => {
  const root = join(__dirname, "..", "..");
  it.each([
    "lib/pdf/QuotePDF.tsx",                                  // PDF: email + WhatsApp + download
    "components/features/quotes/quote-preview-dialog.tsx",    // staff "preview as customer"
    "app/(public)/quote/[id]/accept/page.tsx",                // the customer link
  ])("%s", (rel) => {
    expect(readFileSync(join(root, rel), "utf8")).toContain("customerQuoteNotes(");
  });
});
