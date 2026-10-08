/* R-379 (j, k) — wiring in the Record payment sheet (source scan; the rules are unit-tested in
   lib/payments/record-payment-toast.test.ts and lib/quotes/payment-domain.test.ts). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8",
);

describe("record-payment-dialog wiring (R-379)", () => {
  it("(k) the no-subscription note counts the quote's subscriptions and reads credit activation", () => {
    expect(src).toMatch(/from\("subscriptions"\)\.select\("id", \{ count: "exact", head: true \}\)\.eq\("quote_id", quoteId\)/);
    expect(src).toMatch(/subscriptionNote = subscriptionNoteFor\(\{/);
    expect(src).toMatch(/creditActivatedAt:\s+qRow\?\.credit_activated_at/);
    expect(src).toMatch(/existingSubs:\s+subCount \?\? 0/);
  });
  it("(j) the domain default is applied after the open-reset, without overwriting typed input", () => {
    const i = src.indexOf("if (!open || !defaultDomain) return;");
    expect(i).toBeGreaterThan(src.indexOf("}, [open, reset, remaining, customerTdsDefaults]);"));
    expect(src.slice(i, i + 200)).toMatch(/if \(!\(getValues\("domain"\) \?\? ""\)\.trim\(\)\) setValue\("domain", defaultDomain\)/);
  });
});
