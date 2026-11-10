/* R-2637 — a USD price is converted to ₹ per unit WITHOUT rounding the unit to whole rupees;
   the ₹ line total is rounded once (round(qty × usd × fx)). Owner example (Sep reconcile):
   10 seats × $2 @ 95.10 = ₹1,902 — the app said ₹1,900 because each unit became ₹190. */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { readSource } from "@/lib/testing/source-cache";
import {
  inrRateFromForeign, lineInr, linesInrSubtotal,
  foreignQuoteFigures, foreignUnit, foreignDocConverter,
} from "./foreign-totals";
import { lineEconomics } from "./approval-economics";
import { catalogLineListRate } from "./catalog-line";
import { convertRateForCommitment } from "./commitment-rate";

describe("R-2637 USD → ₹: convert the line total, not a rounded unit", () => {
  it("owner example: 10 × $2 @ 95.10 → rate ₹190.2, line ₹1,902, customer still sees $20.00", () => {
    const rate = inrRateFromForeign(2, 95.1);
    expect(rate).toBe(190.2);
    const line = { qty: 10, rate };
    expect(lineInr(line)).toBe(1902);
    expect(linesInrSubtotal([line])).toBe(1902);
    const f = foreignQuoteFigures({ lines: [line], fx: 95.1, taxRate: 0 });
    expect(f.lines[0].unit).toBe(2);
    expect(f.total).toBe(20);
  });

  it("per-month input on an annual line ($2/seat/month shown, year stored) → 10 seats = ₹22,824", () => {
    /* the builder converts the whole per-invoice figure at once — no float noise (190.2 × 12 = 2282.3999…) */
    const rate = inrRateFromForeign(2 * 12, 95.1);
    expect(rate).toBe(2282.4);
    expect(lineInr({ qty: 10, rate })).toBe(22824);
  });

  it("rounds once at the line total: 3 × $1.99 @ 95.7485 → ₹572 (not 3 × ₹191 = ₹573)", () => {
    const rate = inrRateFromForeign(1.99, 95.7485);
    expect(rate).toBe(190.539515);
    expect(lineInr({ qty: 3, rate })).toBe(572);
    expect(3 * Math.round(1.99 * 95.7485)).toBe(573); // the old per-unit rounding
  });

  it("half a rupee rounds up like SQL round() (5 × ₹190.1 = ₹950.5 → ₹951), no float drift", () => {
    expect(lineInr({ qty: 5, rate: 190.1 })).toBe(951);
    expect(lineInr({ qty: -5, rate: 190.1 })).toBe(-951);
  });

  it("zero / free line → ₹0, no NaN", () => {
    expect(inrRateFromForeign(0, 95.1)).toBe(0);
    expect(lineInr({ qty: 10, rate: 0 })).toBe(0);
    expect(inrRateFromForeign(Number.NaN, 95.1)).toBe(0);
  });

  it("INR quote (whole-rupee rates) → subtotal exactly as before (Σ qty × rate − line discount)", () => {
    const lines = [{ qty: 25, rate: 2700 }, { qty: 3, rate: 999, discount_pct: 10 }];
    const before = lines.reduce((s, l) => s + l.qty * l.rate, 0)
      - lines.reduce((s, l) => s + Math.round(l.qty * l.rate * ((l.discount_pct ?? 0) / 100)), 0);
    expect(linesInrSubtotal(lines)).toBe(before);
  });

  it("round-trip: the $ rate box reads back the typed price (95.7485: $2.00, not $1.99)", () => {
    const rate = inrRateFromForeign(2, 95.7485);
    expect(foreignUnit(rate, 95.7485)).toBe(2);
    expect(foreignUnit(Math.round(2 * 95.7485), 95.7485)).toBe(1.99); // the old whole-₹ unit
  });

  it("approval maths stay unrounded like SQL quote_lines_approval_bps (one number client + server); within ₹1 a line of the saved subtotal", () => {
    const lines = [
      { id: "a", name: "x", qty: 10, rate: inrRateFromForeign(2, 95.1), cost: 150 },
      { id: "b", name: "y", qty: 3, rate: inrRateFromForeign(1.99, 95.7485), cost: 150 },
    ];
    const sub = lineEconomics(lines as never).subtotal;
    expect(sub).toBeCloseTo(1902 + 571.618545, 6);
    expect(Math.abs(sub - linesInrSubtotal(lines))).toBeLessThan(lines.length);
  });

  it("changing the commitment of a USD line keeps its paise (annual ₹2,282.4 ⇄ monthly ₹190.2); INR still rounds", () => {
    const toMonth = convertRateForCommitment({ rate: 2282.4, cost: 1700, from: "annual_yearly", to: "monthly", keepPaise: true });
    expect(toMonth.rate).toBe(190.2);
    expect(lineInr({ qty: 10, rate: toMonth.rate })).toBe(1902);
    const back = convertRateForCommitment({ rate: 190.2, cost: 142, from: "monthly", to: "annual_yearly", keepPaise: true });
    expect(back.rate).toBe(2282.4);
    /* a USD ₹ rate that happens to be whole ($2 @ 95.50 = ₹191) is not rounded to ₹16/month either */
    expect(convertRateForCommitment({ rate: 191 * 12, cost: 0, from: "annual_yearly", to: "monthly", keepPaise: true }).rate).toBe(191);
    expect(convertRateForCommitment({ rate: 191, cost: 0, from: "annual_yearly", to: "monthly", keepPaise: true }).rate).toBe(15.916667);
    /* INR (whole rupees) unchanged: ₹3,245/yr → ₹270/month */
    expect(convertRateForCommitment({ rate: 3245, cost: 0, from: "annual_yearly", to: "monthly" }).rate).toBe(270);
  });

  it("invoice / quote PDF converter maps the ₹ line amount back to the $ the customer saw", () => {
    const lines = [{ qty: 3, rate: inrRateFromForeign(1.99, 95.7485) }];
    const inr = linesInrSubtotal(lines);
    const toFx = foreignDocConverter({ lines, fx: 95.7485, taxRate: 0, inr: { subtotal: inr, taxable: inr, tax: 0, total: inr } });
    expect(toFx(inr)).toBe(5.97);
    expect(toFx(lines[0].rate)).toBe(1.99);
  });

  it("catalogue USD price → ₹ rate not rounded per unit (annual line = $/month × 12 × fx)", () => {
    const it0 = { msrp: 0, wholesale: 0, prices: { usd: { msrp: 2, wholesale: 1.5 } } } as never;
    const { rate } = catalogLineListRate(it0, "annual_yearly", { msrp: 2, wholesale: 1.5, fx: 95.1 });
    expect(rate).toBe(2282.4);
    const once = catalogLineListRate(it0, null, { msrp: 2, wholesale: 1.5, fx: 95.1 });
    expect(once.rate).toBe(190.2);
  });
});

describe("R-2637 SQL readers of quote lines take a paise rate (no ::int cast)", () => {
  const dir = path.resolve(__dirname, "../../../supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const latest = new Map<string, string>();
  for (const f of files) {
    const s = readSource(path.join(dir, f));
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) latest.set(m[1].toLowerCase(), m[3]);
  }
  /* Functions that read quotes.line_items (the builder's lines). create_direct_invoice /
     create_project_direct_invoice cast their OWN p_lines and never see a quote line. */
  const readers = [
    "record_payment", "activate_quote_on_credit", "file_invoiced_quote_subscriptions",
    "subscription_term_amount_from_quote", "combine_quotes", "quote_one_time_lines",
    "bank_sale_lines_from_quote", "bank_sale_lines_total", "quote_lines_approval_bps", "generate_invoice",
  ];
  for (const fn of readers) {
    it(`${fn}: rate read as numeric`, () => {
      const body = latest.get(fn);
      expect(body, `${fn} not found`).toBeTruthy();
      expect(body).not.toMatch(/'rate'\)::int(eger)?\b/i);
    });
  }
});

describe("R-2637 wiring: the builder and the add-line dialog use the one rule", () => {
  const root = path.resolve(__dirname, "../../components/features/quotes");
  const builder = readSource(path.join(root, "quote-builder.tsx"));
  const dialog = readSource(path.join(root, "add-line-item-dialog.tsx"));
  it("builder subtotal = linesInrSubtotal(lineItems) (saved quote subtotal)", () => {
    expect(builder).toMatch(/const subtotal\s*=\s*linesInrSubtotal\(lineItems\)/);
  });
  it("no USD rate is rounded to whole rupees per unit any more", () => {
    expect(builder).not.toMatch(/updateRate\(line\.id, \(isUsdBill \? Math\.round\(v \* fxRate\)/);
    expect(builder).not.toMatch(/handleRateChange\(isUsdBill \? Math\.round\(v \* fxRate\)/);
    expect(dialog).not.toMatch(/usdEntry \? Math\.round\(data\.rate \* fx/);
    expect(dialog).not.toMatch(/msrpPerYear\s*=\s*Math\.round\(usdTier\.msrp/);
  });
});
