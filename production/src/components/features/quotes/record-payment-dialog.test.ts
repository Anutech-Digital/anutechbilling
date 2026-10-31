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
  it("R-404 / R-1730: no hard-coded company name or made-up account ids; accounts + default come from the shared Received in", () => {
    expect(src).not.toMatch(/Anutech/);
    expect(src).not.toMatch(/hdfc_primary|cash_box|icici_corp|razorpay_gateway|upi_hdfc|bank_hdfc/);
    expect(src).toMatch(/useReceivedInDefault\(open, method\)/);
    expect(src).toMatch(/setBankAccountId\(tdsOnly \? "" : usualAccountId\)/);
    expect(src).toMatch(/<ReceivedInField/);
    const shared = fs.readFileSync(path.join(process.cwd(), "src/components/features/payments/payment-entry-fields.tsx"), "utf8");
    expect(shared).toMatch(/useBankAccounts\(\)/);
    expect(shared).toMatch(/depositAccounts\(allBankAccounts\)/);
    expect(shared).toMatch(/href="\/accounting\/banking"/);
  });
  it("R-407: no unconditional 1-year promise; the subscription line follows the quote's lines", () => {
    expect(src).not.toMatch(/1-year subscription/);
    expect(src).toMatch(/lineItems\.some\(\(l\) => isSubscriptionLine\(l\)\)/);
    expect(src).toMatch(/\{makesSubscription === true && <li>/);
  });
  it("R-1730 (was R-407 / R-444): no domain field; the known domain is still saved; none known → Set up pointer", () => {
    expect(src).not.toMatch(/label="[^"]*[Dd]omain/);
    expect(src).not.toMatch(/register\("domain"\)/);
    expect(src).toMatch(/const showDomain = askDomain && makesSubscription !== false;/);
    /* nothing silently stops being saved: the domain the page knew still goes to the
       subscription, the customer and the provisioning task after the payment… */
    expect(src).toMatch(/if \(domainVal\) await stampPaymentDomain\(supabase, \{ quoteId, domain: domainVal \}\)/);
    /* …and with none known the result toast says where to add it. */
    expect(src).toMatch(/domainToSetUp:\s+showDomain && !domainVal/);
    expect(src).toMatch(/domainSetupLine\(\{ domainToSetUp: res\.domainToSetUp, isFullyPaid: res\.isFullyPaid \}\)/);
  });
  it("R-407: a saved payment clears its reference and always closes the sheet", () => {
    const save = src.indexOf('setValue("reference", "");');
    const fin = src.indexOf("} finally {", save);
    expect(save).toBeGreaterThan(src.indexOf("if (res.isReplay) {"));
    expect(fin).toBeGreaterThan(save);
    /* R-2184: the sheet closes right at the save (before the after-save steps can throw or
       stall), so it is closed whatever they do — stronger than closing in `finally`. */
    expect(src.slice(save, save + 80)).toMatch(/setValue\("reference", ""\);\s*onOpenChange\(false\);/);
    expect(src.slice(fin, fin + 600)).toMatch(/onRecorded\?\.\(/);
  });
  it("R-447: invoice decision uses paymentBuyerPlace, and the quote state is filled before generate_invoice", () => {
    expect(src).toMatch(/paymentBuyerPlace\(\{ customer: c \?\? null, quote: q, lead: l \?\? null \}\)/);
    const fill = src.indexOf("await fillCustomerStateFromQuote(createClient(), quoteId);");
    expect(fill).toBeGreaterThan(0);
    expect(src.indexOf("generateInvoice.mutateAsync(quoteId)).invoiceId", fill)).toBeGreaterThan(fill);
  });
});

/* R-2101 (29 Oct 2026, localhost): after Confirm, the payments refresh, remaining drops to ₹0 and
   the amount effect sets the field to 0 while the sheet closes — "Amount must be more than ₹0"
   flashed red on a payment that had just been saved. */
describe("no red ₹0 flash after Confirm (R-2101)", () => {
  it("the ₹0 pill shows only for a 0 the operator typed", () => {
    expect(src).toMatch(/<FieldPill check=\{amountEdited && watch\("amount"\) === 0 && !tdsDeducted/);
  });
});
