/**
 * R-012 — the renewal quote sends the subscription's OWN term and the catalogue's
 * own cost.
 *
 * A source scan, because both bugs were single literals sitting beside code that
 * already had the right answer. `term.termMonths` and `term.commitment` were both in
 * scope; `extension_months: 12` sat two lines below them. No unit test of either helper
 * could see that the caller ignored one of them — the same shape as L75 and L98.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/lib/renewals/create-renewal-quote.ts";

/** Comments stripped: prose explaining a deleted literal must not satisfy a scan for it (L46). */
const code = readFileSync(FILE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the renewal extends by the subscription's own term", () => {
  it("sends term.termMonths, not a hardcoded 12", () => {
    /* THE BUG THAT TOOK MONEY. record_payment rolls the dates forward from this field,
       so a monthly renewal priced for one month extended the subscription by a year. */
    expect(code).toContain("extension_months: term.termMonths");
    expect(code).not.toMatch(/extension_months:\s*12\b/);
  });

  it("still takes the price and the commitment from the same term", () => {
    // These were already right. The defect was one field of three disagreeing.
    expect(code).toContain("term.subtotal");
    expect(code).toContain("term.perSeatRate");
    expect(code).toContain("commitment: term.commitment");
  });
});

describe("the cost comes from the catalogue", () => {
  it("has no 0.83 guess left anywhere", () => {
    /* A hardcoded 17% margin: every renewal quote reported 17% because it was defined
       to be 17%. AGENTS.md §2 lists this exact constant. */
    expect(code).not.toContain("0.83");
  });

  it("reads the wholesale column, not only the msrp", () => {
    expect(code).toContain('.select("msrp, wholesale")');
  });

  it("prices through the tested helper", () => {
    expect(code).toContain("renewalCost({");
    expect(code).toContain("wholesalePerSeatMonth:");
    // The term, so a monthly renewal is not costed for twelve months.
    expect(code).toMatch(/termMonths:\s*term\.termMonths/);
  });

  it("writes the same figure to the line and to total_cost", () => {
    // Two derivations of one number is how they drift.
    expect(code).toContain("const perSeatCost = cost.perSeat;");
    expect(code).toContain("total_cost:     cost.total,");
  });

  it("says out loud when it could not price the cost", () => {
    /* Silence here would put an unknown cost on a quote and let the margin read as
       100%. The warning names the plan so the cron log is actionable. */
    expect(code).toMatch(/if \(!cost\.known\)/);
    expect(code).toMatch(/console\.warn/);
  });
});

describe("what R-012 said NOT to touch", () => {
  it("leaves createExtensionQuote's own 24/36 alone", () => {
    /* Pawan's request is explicit: extensions choose 24 or 36 on purpose, and that file
       is not part of this fix. */
    const ext = readFileSync("src/lib/renewals/create-extension-quote.ts", "utf8");
    expect(ext).toMatch(/extension_months/);
  });
});

describe("R-012 follow-ups from Pawan's brief", () => {
  it("dates come from IST, never from a UTC slice", () => {
    /* `new Date().toISOString().slice(0, 10)` is UTC, so between midnight and 05:30
       IST every renewal quote was stamped with YESTERDAY's date (AGENTS.md §6). The
       cron runs at 09:00 so it never saw this; the operator's "Generate renewal quote"
       button does, and reps here work early. */
    expect(code).toContain("created_date:   istToday()");
    expect(code).toContain("expires_date:   toIstDate(validUntil)");
    expect(code).not.toContain("toISOString().slice(0, 10)");
  });

  it("returns an existing quote untouched — no re-pricing, no new cost", () => {
    /* Path 1 must hand back what is stored. Re-deriving it here would change a quote
       the customer may already be looking at, and the accept link is live. */
    /* Anchor on CODE, not on the "Path 2" comment — `code` has comments stripped, so
       indexOf on a comment returns -1 and the slice silently runs to end of file. It
       did exactly that on the first run and the test failed for the wrong reason. */
    const path1 = code.slice(
      code.indexOf("if (existingQuoteId)"),
      code.indexOf('next_document_number'),
    );
    expect(path1).toContain("created:     false");
    expect(path1).not.toContain("renewalCost(");
    expect(path1).not.toContain("extension_months");
  });

  it("leaves createExtensionQuote's deliberate 24/36 alone", () => {
    const ext = readFileSync("src/lib/renewals/create-extension-quote.ts", "utf8");
    expect(ext).toContain("extension_months");
  });
});

describe("a zero cost reaches readers that already call it unknown", () => {
  /* The brief asks which readers a 0 touches. Measured: every margin reader in the
     Billing screens uses the same `cost <= 0 && rate > 0` rule, so an unpriced renewal
     shows "unknown" rather than 100% margin. Pinned here because if any of them ever
     starts trusting `quotes.total_cost` again, this fix quietly becomes a lie. */
  it.each([
    ["src/lib/quotes/approval-economics.ts", "approval matrix"],
    ["src/app/(app)/quotes/page.tsx",        "quotes list"],
    ["src/lib/quotes/configure.ts",          "quote configurator"],
    ["src/app/(app)/quotes/[id]/page.tsx",   "quote detail"],
  ])("%s (%s) treats a zero cost as unknown", (file) => {
    /* R-388: the rule now lives in ONE place, lib/quotes/line-cost.ts — a reader either
       inlines it or calls the shared helper. */
    expect(readFileSync(file, "utf8")).toMatch(/cost <= 0 && l?\w*\.?rate > 0|\b(lineCostUnknown|anyCostUnknown)\(/);
  });

  it("the shared rule (lib/quotes/line-cost.ts) still reads a zero vendor cost as unknown", () => {
    expect(readFileSync("src/lib/quotes/line-cost.ts", "utf8")).toMatch(/return line\.cost <= 0;/);
  });
});
