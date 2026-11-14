/* R-2767 (R-2742: audit P4 / P10 / P11 + coordinator decision 14 Nov) — Renewals wording + noise + USD:
   one verb per intention, no every-row chips, foreign customers in their currency, Remind says the whole tab. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renewalAmount, EXPORT_GST } from "./queue";
import { quoteExpiryNote, EXPIRY_ROW_DAYS } from "./last-docs";
import { reminderButtonLabel, reminderScope } from "./reminders";
import {
  REVIEW_RENEWAL_QUOTE, CHANGE_RENEWAL_QUOTE, BILL_RENEWAL_YEAR, BILL_RENEWAL_TERM,
} from "@/components/features/renewals/renewal-actions-rules";
import { SEND_RENEWAL } from "@/lib/renewals/stage";

const sub = { mrr: 18000, term_months: 12, term_amount: 216000, renewal_quote_id: null as string | null };

describe("R-2767 one verb per intention", () => {
  it("Payment Follow-up's renewal rows say the Renewals words: Send renewal / Change renewal", () => {
    expect(REVIEW_RENEWAL_QUOTE).toBe(SEND_RENEWAL);
    expect(CHANGE_RENEWAL_QUOTE).toBe("Change renewal");
    expect(BILL_RENEWAL_YEAR).toBe("Send renewal · part 1 of next year");
    expect(BILL_RENEWAL_TERM).toBe("Send renewal · part 1 of next term");
  });
  it("the retired labels are gone from the app's own text (outside tests / history comments)", () => {
    const files = [
      "src/components/features/renewals/renewal-actions-rules.ts",
      "src/components/features/renewals/renewal-actions.tsx",
      "src/app/(app)/renewals/page.tsx",
      "src/lib/renewals/stage.ts",
    ];
    for (const f of files) {
      const code = readFileSync(f, "utf8").split(/\r?\n/).filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
      expect(code, f).not.toMatch(/"(Review renewal quote|Change renewal quote|Bill renewal · part 1 of next (year|term))"/);
    }
  });
});

describe("R-2767 noise off the row", () => {
  const today = "2026-11-14";
  it("a quote's validity shows only at 3 days or less, or expired; no expiry (part proforma) → nothing", () => {
    expect(EXPIRY_ROW_DAYS).toBe(3);
    expect(quoteExpiryNote(null, today)).toBeNull();
    expect(quoteExpiryNote("2026-11-30", today)).toBeNull();          // 16 days left
    expect(quoteExpiryNote("2026-11-17", today)).toBe("Expires in 3 days");
    expect(quoteExpiryNote("2026-11-14", today)).toBe("Expires today");
    expect(quoteExpiryNote("2026-11-10", today)).toMatch(/^Expired \d+ days? ago$/);
  });
  it("'No owner' / 'No owner yet' / 'No expiry set' are never rendered on a row", () => {
    const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
    const cell = readFileSync("src/app/(app)/renewals/last-docs-cell.tsx", "utf8");
    expect(page).not.toMatch(/"No owner yet"|\?\? "No owner"/);
    expect(cell).not.toMatch(/quoteExpiryText\(/);
  });
});

describe("R-2767 foreign customers in their own currency (audit P11)", () => {
  it("a USD sale quote → '$2,400.00/yr', no GST (LUT); value stays ₹ for sorting / tiles", () => {
    const a = renewalAmount(sub, null, { id: "Q1", amount: 254880, status: "paid", currency: "USD", exchange_rate: 90 });
    expect(a.text).toBe("$2,400.00/yr");
    expect(a.gst).toBe(EXPORT_GST);
    expect(a.value).toBe(216000);
  });
  it("a sent USD renewal quote → its note in $ too", () => {
    const a = renewalAmount({ ...sub, renewal_quote_id: "QR" }, { id: "QR", amount: 225000, status: "sent", currency: "USD", exchange_rate: 90 });
    expect(a.text).toBe("$2,400.00/yr");
    expect(a.quoteNote).toBe("Quote $2,500.00");
  });
  it("₹ customers (or a foreign quote with no rate) keep '₹… + GST'", () => {
    expect(renewalAmount(sub, null, { id: "Q1", amount: 1, status: "paid", currency: "INR", exchange_rate: 1 }).gst).toBe("+ GST");
    expect(renewalAmount(sub, null, { id: "Q1", amount: 1, status: "paid", currency: "USD", exchange_rate: null }).gst).toBe("+ GST");
    expect(renewalAmount(sub, null).text).toMatch(/^₹/);
  });
});

describe("R-2767 Remind says the whole open tab (coordinator decision 14 Nov)", () => {
  it("nothing ticked → 'Remind 62 in Later' — every row of the tab, also the ones behind Show more", () => {
    expect(reminderButtonLabel(reminderScope(0, "Later", 62))).toBe("Remind 62 in Later");
    const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
    /* the scope counts the tab's narrowed rows (shown[bucketTab]), never the 50 on screen */
    expect(page).toMatch(/const visibleRows = tile \? tileShown : shown\[bucketTab\];/);
    expect(page).toMatch(/reminderScope\(tickedShown\.length, tile \? TILE_LABEL\[tile\] : QUEUE_TAB_LABEL\[bucketTab\], visibleRows\.length\)/);
  });
});
