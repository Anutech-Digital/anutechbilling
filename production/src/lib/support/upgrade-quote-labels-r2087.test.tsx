// @vitest-environment jsdom
/**
 * R-2087 (29 Oct localhost e2e) — the owner's real rows:
 *   · Q-1111-27-0014, the quote "Upgrade plan" made (R-2073): is_renewal = true,
 *     extension_months = 0, one SUP-ENTERPRISE-YR line — the page said "Renewal quote",
 *     chip "Renewal", "subscription is renewed".
 *   · INV-1111-27-0011, paid on /buy/support: status paid, net_payable 0, paid_amount 0,
 *     the ₹11,795 in adjusted_advances (an advance adjusted at issue — the desk-paid
 *     INV-1111-27-0012 has exactly the same shape). The invoice drawer said "Paid ₹0".
 *   · The support subscription's drawer led with "Manage seats".
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { isSupportUpgradeQuote } from "./upgrade-quote";
import { acceptHint } from "@/lib/quotes/quote-page-actions";
import { quoteDocumentLabel } from "@/lib/pdf/quote-document-kind";
import { recordPaymentConsequences, UPGRADE_PLAN_CONSEQUENCE } from "@/lib/payments/record-consequences";
import { invoiceMoneyIn, invoicePaymentState } from "@/lib/invoices/payment-state";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { SubDrawerActions } from "@/components/features/subscriptions/sub-drawer-actions";

afterEach(cleanup);

const T = "11111111111111111111111111111111";
const upgradeQuote = {
  id: "Q-1111-27-0014", is_renewal: true, is_extension: false, extension_months: 0,
  customer_id: "c1", lead_id: null,
  line_items: [{ id: "upgrade-1", item_id: `SUP-ENTERPRISE-YR-${T}`, name: "Enterprise Support (Yearly) · upgrade from Standard", qty: 1, rate: 39996 }],
};
const renewalQuote = {
  ...upgradeQuote, id: "Q-R", extension_months: 12,
  line_items: [{ item_id: `SUP-STANDARD-YR-${T}`, name: "Standard Support (Yearly)", qty: 1, rate: 9996 }],
};

describe("R-2087 (1) an upgrade quote is called an upgrade", () => {
  it("detects the R-2073 shape and nothing else", () => {
    expect(isSupportUpgradeQuote(upgradeQuote)).toBe(true);
    expect(isSupportUpgradeQuote(renewalQuote)).toBe(false);                     // a real renewal
    expect(isSupportUpgradeQuote({ ...upgradeQuote, is_extension: true })).toBe(false);
    expect(isSupportUpgradeQuote({ ...upgradeQuote, is_renewal: false })).toBe(false);
    expect(isSupportUpgradeQuote({ ...upgradeQuote, line_items: [{ item_id: "GWS-STARTER" }] })).toBe(false);
    expect(isSupportUpgradeQuote({ ...upgradeQuote, line_items: [] })).toBe(false);
    expect(isSupportUpgradeQuote({ ...upgradeQuote, line_items: null })).toBe(false);
  });

  it("accept hint says the plan is upgraded, not renewed", () => {
    expect(acceptHint(upgradeQuote)).toMatch(/support plan is upgraded/);
    expect(acceptHint(upgradeQuote)).not.toMatch(/renewed/);
    expect(acceptHint(renewalQuote)).toMatch(/subscription is renewed/);
  });

  it("the PDF heading says Upgrade, paid or not", () => {
    expect(quoteDocumentLabel({ paid: false, isRenewal: true, isUpgrade: true })).toBe("Upgrade Quotation");
    expect(quoteDocumentLabel({ paid: true, isRenewal: true, isUpgrade: true })).toBe("Upgrade order · Paid");
    expect(quoteDocumentLabel({ paid: false, isRenewal: true })).toBe("Renewal Quotation");
  });

  it("Record payment's sheet says upgrade, not renew", () => {
    const facts = recordPaymentConsequences({
      payment: {
        quoteId: "Q-1111-27-0014", customerName: "Acme Pvt Ltd", amount: 47195, quoteAmount: 47195, priorReceived: 0,
        createsCustomer: false, createsSubscription: true, planLabel: null,
        renewsSubscription: true, upgradesPlan: true,
      },
      receiptSeries: null,
    } as Parameters<typeof recordPaymentConsequences>[0]);
    const texts = facts.map((f) => f.text);
    expect(texts).toContain(UPGRADE_PLAN_CONSEQUENCE);
    expect(texts.join(" ")).not.toMatch(/Renews the existing subscription/);
  });

  it("the quote page and the quotes list use it for header, chip and the Renewals count", () => {
    const page = fs.readFileSync(path.resolve(__dirname, "../../app/(app)/quotes/[id]/page.tsx"), "utf8");
    expect(page).toContain('upgradeQuote ? "Upgrade Quote"');
    expect(page).toContain('{upgradeQuote ? "Upgrade" : "Renewal"}');
    expect(page).toContain("isUpgrade={upgradeQuote}");
    const list = fs.readFileSync(path.resolve(__dirname, "../../app/(app)/quotes/page.tsx"), "utf8");
    expect(list.match(/isSupportUpgradeQuote\(q\) \? "Upgrade" : "Renewal"/g)?.length).toBe(2);
    expect(list).toContain("!isSupportUpgradeQuote(q)).length");
    const props = fs.readFileSync(path.resolve(__dirname, "../pdf/build-props.ts"), "utf8");
    expect(props).toContain("isUpgrade:     isSupportUpgradeQuote(quote)");
  });
});

describe("R-2087 (2) a /buy invoice paid by an advance reads Paid in full", () => {
  // INV-1111-27-0011 as the local DB holds it after /buy/support.
  const inv = {
    status: "paid", amount: 11795, net_payable: 0, paid_amount: 0, written_off_at: null,
    adjusted_advances: [{ amount: 11795, method: "razorpay", payment_id: "8f91e748", voucher_no: "RV-1111-27-0012" }],
  };

  it("is paid, nothing due — dues / aging / collections never ask for it again", () => {
    expect(invoicePaymentState({ ...inv, credit_noted: 0 })).toBe("paid");
    expect(invoiceAmountDue(inv)).toBe(0);
  });

  it("money in is the whole ₹11,795 (the advance), not paid_amount's 0", () => {
    expect(invoiceMoneyIn({ ...inv, credit_noted: 0 })).toBe(11795);
  });

  it("a pending invoice with a part advance shows that advance as paid", () => {
    const part = { status: "pending", amount: 38232, net_payable: 18232, paid_amount: 0, adjusted_advances: [{ amount: 20000 }] };
    expect(invoiceMoneyIn(part)).toBe(20000);
    expect(invoiceAmountDue(part)).toBe(18232);
  });

  it("the invoice drawer's Paid tile reads money in, not net_payable − due", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../app/(app)/invoices/invoice-detail.tsx"), "utf8");
    expect(src).toContain('data-testid="invoice-paid">{rupee(invoiceMoneyIn({');
    expect(src).not.toContain("rupee(Math.max(0, (invoice.net_payable ?? total) - invoiceAmountDue(invoice)))");
  });
});

describe("R-2087 (4) a support plan's drawer leads with Upgrade plan", () => {
  const noop = () => {};
  const handlers = { onManageSeats: noop, onExtend: noop, onOpenCustomer: noop, onStatement: noop, onCorrect: noop };

  it("support plan: no Manage seats; Upgrade plan is the primary", () => {
    render(<SubDrawerActions hasCustomer primary supportPlan {...handlers} onUpgradePlan={noop} />);
    expect(screen.queryByRole("button", { name: /Manage seats/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Upgrade plan/ }).className).toMatch(/\bbg-amber\b/);
  });

  it("support plan with no higher tier: no seats button and no dead upgrade button", () => {
    render(<SubDrawerActions hasCustomer primary supportPlan {...handlers} />);
    expect(screen.queryByRole("button", { name: /Manage seats/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Upgrade plan/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Extend term/ })).toBeDefined();
  });

  it("the subscriptions page tells the drawer which plans are support", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../app/(app)/subscriptions/page.tsx"), "utf8");
    expect(src).toContain("supportPlan={isSupportSkuId(scheduleSub.item_id)}");
  });
});
