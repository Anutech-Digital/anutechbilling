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

describe("record-payment-dialog wiring (R-404, R-407, R-447, R-444)", () => {
  it("R-404: no hard-coded company name or made-up account ids; accounts come from useBankAccounts", () => {
    expect(src).not.toMatch(/Anutech/);
    expect(src).not.toMatch(/hdfc_primary|cash_box|icici_corp|razorpay_gateway|upi_hdfc|bank_hdfc/);
    expect(src).toMatch(/useBankAccounts\(\)/);
    expect(src).toMatch(/depositAccounts\(allBankAccounts\)/);
    expect(src).toMatch(/defaultDepositAccountId\(receiveAccounts, method\)/);
    expect(src).toMatch(/href="\/accounting\/banking"/);
  });
  it("R-407: no unconditional 1-year promise; the subscription line follows the quote's lines", () => {
    expect(src).not.toMatch(/1-year subscription/);
    expect(src).toMatch(/lineItems\.some\(\(l\) => isSubscriptionLine\(l\)\)/);
    expect(src).toMatch(/\{makesSubscription === true && <li>/);
  });
  it("R-407 / R-444 (1): domain is optional (no required star), shown only with a subscription, and saved", () => {
    expect(src).not.toMatch(/label="[^"]*[Dd]omain[^"]*" required/);
    expect(src).toMatch(/const showDomain = askDomain && makesSubscription !== false;/);
    expect(src).toMatch(/\{showDomain && \(/);
    expect(src).toMatch(/await saveDomainAfterPayment\(supabase, \{ quoteId, domain: domainVal \}\)/);
  });
  it("R-407: a saved payment clears its reference and always closes the sheet", () => {
    const save = src.indexOf('setValue("reference", "");');
    const fin = src.indexOf("} finally {", save);
    expect(save).toBeGreaterThan(src.indexOf("if (res.isReplay) {"));
    expect(fin).toBeGreaterThan(save);
    expect(src.slice(fin, fin + 600)).toMatch(/onRecorded\?\.\([\s\S]*onOpenChange\(false\);/);
  });
  it("R-447: invoice decision uses paymentBuyerPlace, and the quote state is filled before generate_invoice", () => {
    expect(src).toMatch(/paymentBuyerPlace\(\{ customer: c \?\? null, quote: q, lead: l \?\? null \}\)/);
    const fill = src.indexOf("await fillCustomerStateFromQuote(createClient(), quoteId);");
    expect(fill).toBeGreaterThan(0);
    expect(src.indexOf("generateInvoice.mutateAsync(quoteId)).invoiceId", fill)).toBeGreaterThan(fill);
  });
});
