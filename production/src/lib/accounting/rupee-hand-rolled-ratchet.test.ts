/**
 * R-1138 ratchet: a rupee amount is formatted by rupee() (lib/utils), not by hand.
 *
 * WHY: `"₹" + n.toLocaleString("en-IN")` picks its own decimals — a non-whole amount printed
 * "₹1,234.567" (up to 3 decimals) in a customer's WhatsApp text — and `Math.round(-0.3)` printed
 * "₹-0". rupee() is the one place that decides lakh grouping, sign and decimals. The R-274
 * ratchet covers the accounting SCREENS; this one walks all of src/.
 *
 * A hit = one source line holding both "₹" and `toLocaleString("en-IN"` / `('en-IN'`.
 * KNOWN is the measured remainder per file (23 Oct 2026) — it may only go DOWN: convert a line,
 * lower its number (delete the entry at 0). A new file, or a higher count, fails.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { rupee } from "@/lib/utils";

const ROOT = join(process.cwd(), "src");

const KNOWN: Record<string, number> = {
  "app/(app)/accounting/salary-register/page.tsx": 1,
  "app/(app)/payments/page.tsx": 1,
  "app/(app)/performance/page.tsx": 1,
  "app/(app)/vault/personal/banking/page.tsx": 1,
  "app/(app)/vault/personal/expenses/page.tsx": 2,
  "app/(app)/vault/personal/wealth/page.tsx": 1,
  "app/(public)/buy/workspace/buy-workspace-client.tsx": 22,
  "app/(public)/buy/workspace/thanks/thanks-client.tsx": 1,
  "app/api/ai/plan-project/route.ts": 1,
  "app/api/dms/upgrade-request/route.ts": 1,
  "app/api/public/checkout/workspace/route.ts": 4,
  "app/api/public/enquiry/workspace/route.ts": 2,
  "components/features/accounting/add-expense-dialog.tsx": 1,
  // stored FX note on a vendor bill — its words must not move (see the R-274 ratchet)
  "components/features/accounting/add-vendor-bill-dialog.tsx": 3,
  "components/features/leads/add-lead-form.tsx": 4,
  "components/features/margin-pill.tsx": 1,
  "components/features/payments/multi-invoice-allocation.ts": 1,
  "components/features/quotes/receipt-voucher-dialog.tsx": 2,
  "components/features/quotes/tax-invoice-dialog.tsx": 2,
  "components/features/referrals/pay-commission-dialog.tsx": 1,
  "components/features/site-promos/create-promo-dialog.tsx": 1,
  "lib/ai/audit.ts": 1,
  "lib/billing/instalments.ts": 1,
  "lib/catalog/billing-unit.ts": 1,
  "lib/catalog/catalog-prices.ts": 1,
  "lib/checkout/cart-checkout.ts": 3,
  "lib/digest/owner-digest.ts": 1,
  "lib/forms/poka-yoke.ts": 2,
  "lib/leads/deal-margin.ts": 2,
  "lib/leads/next-action.ts": 2,
  "lib/marketing/channel-economics.ts": 3,
  "lib/payments/mandate.ts": 4,
  "lib/payments/refund-cover.ts": 1,
  "lib/payroll/employee-assets.ts": 1,
  "lib/payroll/income-tax.ts": 1,
  "lib/payroll/pf.ts": 1,
  "lib/push/payload.ts": 1,
  "lib/queries/advances.ts": 2,
  "lib/queries/invoices.ts": 6,
  "lib/queries/marketing.ts": 2,
  "lib/queries/performance.ts": 1,
  "lib/queries/subscriptions.ts": 1,
  "lib/quotes/status-badge.ts": 1,
  "lib/razorpay/gateway-money.ts": 1,
  "lib/renewals/renewal-term.ts": 2,
  "lib/renewals/templates.ts": 1,
  "lib/subscriptions/amendments.ts": 1,
  "lib/subscriptions/catalog-options.ts": 2,
  "lib/subscriptions/proration.ts": 1,
  "lib/tax/itr.ts": 3,
  "lib/vendor/leakage.ts": 2,
  "site/components/cart/CartProvider.tsx": 1,
  "site/components/chrome/Header.tsx": 1,
  "site/components/domains/DomainLanding.tsx": 3,
  "site/components/email/WorkspacePricing.tsx": 2,
  "site/components/home/HomeCompany.tsx": 1,
  "site/components/home/HomeV2.tsx": 1,
  "site/components/lp/WorkspaceAdLanding.tsx": 1,
  "site/components/trial/TrialForm.tsx": 1,
  "site/lib/data/domain-teaser.ts": 1,
  "site/lib/live-catalog.ts": 1,
  "site/lib/money.ts": 1,
};

/** The files R-1138 moved to rupee() — they must stay at zero. */
const CONVERTED = [
  "lib/accounting/month-close.ts",
  "lib/accounting/tds-deductor.ts",
  "lib/accounting/tds-match.ts",
  "lib/accounting/tds-receipt.ts",
  "lib/accounting/depreciation.ts",
  "lib/accounting/mrr-waterfall.ts",
  "lib/accounting/prepaid-fifo.ts",
  "lib/compliance/entry-rules.ts",
  "app/(app)/quotes/page.tsx",
  "app/api/webhooks/razorpay/webhook.server.ts",
  "app/api/webhooks/razorpay/review.server.ts",
  "components/features/coupons/create-coupon-dialog.tsx",
];

const EN_IN = /toLocaleString\(\s*["']en-IN/;
function isHandRolledRupee(line: string): boolean {
  return line.includes("₹") && EN_IN.test(line);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of walk(ROOT)) {
    const n = readFileSync(p, "utf8").split(/\r?\n/).filter(isHandRolledRupee).length;
    if (n > 0) out[relative(ROOT, p).replace(/\\/g, "/")] = n;
  }
  return out;
}

describe("R-1138 — rupee amounts use rupee(), not a hand-rolled toLocaleString", () => {
  const actual = counts();

  it("no file has more hand-rolled ₹ lines than KNOWN (new code: use rupee())", () => {
    const over = Object.entries(actual)
      .filter(([f, n]) => n > (KNOWN[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (allowed ${KNOWN[f] ?? 0})`);
    expect(over, "Format with rupee() from @/lib/utils instead").toEqual([]);
  });

  it("KNOWN only shrinks — lower a number when its file gets better", () => {
    const stale = Object.entries(KNOWN)
      .filter(([f, n]) => (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: KNOWN ${n}, now ${actual[f] ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("the files R-1138 converted stay at zero and use rupee()", () => {
    for (const f of CONVERTED) {
      expect(actual[f] ?? 0, f).toBe(0);
      expect(KNOWN[f], f).toBeUndefined();
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/\brupee\(/);
    }
  });

  it("the matcher is not dead", () => {
    expect(isHandRolledRupee('const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");')).toBe(true);
    expect(isHandRolledRupee("`for ₹${(q.amount ?? 0).toLocaleString('en-IN')}`")).toBe(true);
    expect(isHandRolledRupee("`for ${rupee(q.amount)}`")).toBe(false);
    expect(isHandRolledRupee('d.toLocaleString("en-IN", { month: "short" })')).toBe(false);
  });

  it("whole rupees print exactly as before; only the bug cases change", () => {
    const old = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
    for (const n of [0, 1, 99, 999, 1000, 4370, 12345, 99999, 100000, 490644, 1234567, 98765432, 1000000000, -5, -999, -1000, -123456]) {
      expect(rupee(n), String(n)).toBe(old(n));
    }
    // Bug cases — the visible differences:
    expect(rupee(1234.567)).toBe("₹1,235");                         // was "₹1,234.567" (unrounded toLocaleString)
    expect("₹" + (1234.567).toLocaleString("en-IN")).toBe("₹1,234.567");
    expect(rupee(-0.3)).toBe("₹0");                                 // was "₹-0"
    expect(old(-0.3)).toBe("₹-0");
  });
});
