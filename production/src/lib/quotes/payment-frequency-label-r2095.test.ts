/* R-2095 follow-up (Pardeep: one fact, one label). How often the customer pays is "Payment frequency"
   on every screen — the quote builder said "Billing cycle", the Leads form "Billing cycle" / "Billing",
   the support-plan picker "Billing cycle", the quotes CSV "Billing cycle". The commitment is "Annual
   commitment" / "Flexible (monthly)" everywhere — the New sale line said "Annual (1-yr)" / "Monthly
   flex" while Correct details said the new words. The list chip reads "Annual · paid monthly".
   Database / API keys (billing_cycle, commitment) are unchanged. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMIT_CHOICES } from "./line-commit-choice";
import { commitmentOptions, paymentChoice } from "@/lib/banking/credit-pay-for";
import { COMMITMENT_OPTIONS } from "@/lib/subscriptions/commitment-change";
import { subscriptionCycle, CYCLE_LABEL } from "@/lib/subscriptions/billing-cycle";
import { QUOTES_CSV_HEADERS } from "@/lib/export/crm-csv";

const src = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");

describe("R-2095: commitment words are the same everywhere", () => {
  it("the line's commitment choices use Correct details' own labels", () => {
    const label = (v: string) => COMMIT_CHOICES.find((c) => c.value === v)!.label;
    expect(label("annual")).toBe(COMMITMENT_OPTIONS.find((o) => o.value === "annual")!.label);
    expect(label("monthly")).toBe(COMMITMENT_OPTIONS.find((o) => o.value === "flex")!.label);
    expect(label("annual")).toBe("Annual commitment");
    expect(label("monthly")).toBe("Flexible (monthly)");
    expect(label("one_time")).toBe("One-time");
  });

  it("New sale offers the same words", () => {
    expect(commitmentOptions(false).map((o) => o.label)).toEqual(["Annual commitment", "Flexible (monthly)", "One-time"]);
    const why = paymentChoice([{ cycle: "monthly" }]).why ?? "";
    expect(why).not.toMatch(/Monthly flex|Annual \(1-yr\)/);
    expect(why).toMatch(/Flexible \(monthly\)/);
  });
});

describe("R-2095: the list chip says 'paid'", () => {
  it("Annual · paid monthly / yearly; Flexible (monthly)", () => {
    const base = { start_date: "2026-01-01", renewal_date: "2026-12-31" };
    expect(subscriptionCycle({ ...base, billing_cycle: "monthly", term_months: 12 }).label).toBe("Annual · paid monthly");
    expect(subscriptionCycle({ ...base, billing_cycle: "quarterly", term_months: 12 }).label).toBe("Annual · paid quarterly");
    expect(subscriptionCycle({ ...base, billing_cycle: "yearly", term_months: 12 }).label).toBe("Annual · paid yearly");
    expect(subscriptionCycle({ ...base, billing_cycle: "monthly", term_months: 1, renewal_date: null }).label).toBe("Flexible (monthly)");
    expect(CYCLE_LABEL.annual_split).toBe("Annual · paid monthly/quarterly");
  });
});

describe("R-2095: 'Payment frequency' is the field's one name", () => {
  it("quotes CSV header (export only — no importer reads it)", () => {
    expect(QUOTES_CSV_HEADERS).toContain("Payment frequency");
    expect(QUOTES_CSV_HEADERS).not.toContain("Billing cycle");
  });

  it.each([
    ["components/features/quotes/quote-builder.tsx", /htmlFor="qb-billing-cycle"[^>]*>Payment frequency</],
    ["components/features/quotes/support-plan-picker.tsx", /aria-label="Payment frequency"/],
    ["components/features/leads/add-lead-form.tsx", /label="Payment frequency" htmlFor="billing_cycle"/],
    ["components/features/leads/add-lead-form.tsx", /<Review label="Payment frequency"/],
    ["components/features/leads/billing-cycle-fields.tsx", />\s*Payment frequency\s*</],
  ])("%s", (file, re) => {
    expect(src(file)).toMatch(re);
  });

  it("no screen labels it 'Billing cycle' any more (the subscriptions filter chips stay — commitment + frequency mixed)", () => {
    for (const f of [
      "components/features/quotes/quote-builder.tsx", "components/features/quotes/support-plan-picker.tsx",
      "components/features/leads/add-lead-form.tsx", "components/features/leads/billing-cycle-fields.tsx",
    ]) {
      expect(src(f)).not.toMatch(/>\s*Billing cycle\s*<|label="Billing cycle"|aria-label="Billing cycle"/);
    }
  });
});
