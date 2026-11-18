/* R-2923 (18 Nov 2026, found by the R-2922 review): quote-peek's RANGE_IN_NAME had lost its backslashes (a
   literal backspace character and plain "d" / "s"), so it never matched — a line whose NAME already says its
   day range was only recognised when that range equalled the period worked out for it. With no period worked
   out (or a different one), the range in the name was not seen. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { peekLines, type PeekBilling, type PeekQuoteRow, type PeekSub } from "./quote-peek";

const pq = (over: Partial<PeekQuoteRow> = {}): PeekQuoteRow => ({
  id: "PI-R2923-0001", line_items: [], is_renewal: null, is_extension: null, is_add_seats: null, is_one_off: true, extension_months: null,
  renewal_term_date: null, created_date: "2026-10-30", domain: null, subscription_billing_id: null, renewal_subscription_id: null, ...over,
});
const none = new Map<string, PeekBilling>();
const subs = new Map<string, PeekSub>();
/** A part request whose part row is not readable: no period is worked out, so only the name can say it. */
const inName = (name: string) =>
  peekLines(pq({ subscription_billing_id: "B-GONE", line_items: [{ id: "part-1", name, qty: 3, rate: 100, one_time: true }] }), none, subs)[0];

describe("R-2923 — a day range written in a line's name is recognised", () => {
  it("'1 Oct–31 Oct 2026' in the name (en dash) → periodInName, though no period was worked out", () => {
    const l = inName("Google Workspace Business Starter · ravi.in · 3 seats · 1 Oct–31 Oct 2026 (part 1 of 12)");
    expect(l.period).toBeNull();
    expect(l.periodInName).toBe(true);
  });

  it("across a year end, with a hyphen, and with spaces round the dash", () => {
    expect(inName("Starter · 1 Nov 2026–31 Oct 2027").periodInName).toBe(true);
    expect(inName("Starter · 15 Oct-14 Nov 2026").periodInName).toBe(true);
    expect(inName("Starter · 1 Oct – 31 Oct 2026").periodInName).toBe(true);
  });

  it("a name with no day range is not one — a year, a seat count or half a range does not count", () => {
    expect(inName("Google Workspace Business Starter").periodInName).toBe(false);
    expect(inName("Plan 2026 · 12 seats").periodInName).toBe(false);
    expect(inName("Starter from 1 Oct 2026").periodInName).toBe(false);
    expect(inName("Payment for month 2").periodInName).toBe(false);
  });

  it("a range in the name that differs from the part's stored period is still seen (never printed a second time)", () => {
    const parts = new Map([["B1", { id: "B1", subscription_id: "S1", period_start: "2026-11-01", period_end: "2026-12-01" } satisfies PeekBilling]]);
    const [l] = peekLines(pq({ subscription_billing_id: "B1", line_items: [{ id: "part-1", name: "Starter · 1 Oct–31 Oct 2026", qty: 3, rate: 100, one_time: true }] }), parts, subs);
    expect(l.period).toBe("1 Nov–30 Nov 2026");
    expect(l.periodInName).toBe(true);
  });

  it("the source keeps its backslashes: no control character in quote-peek.ts", () => {
    const src = readFileSync(new URL("./quote-peek.ts", import.meta.url), "utf8");
    const control = [...src].filter((ch) => { const c = ch.charCodeAt(0); return c < 32 && c !== 9 && c !== 10 && c !== 13; });
    expect(control).toEqual([]);
  });
});
