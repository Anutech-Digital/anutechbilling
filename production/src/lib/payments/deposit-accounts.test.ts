/* R-404 — "Received in" on Record payment: this company's own accounts, never a hard-coded one. */
import { describe, it, expect } from "vitest";
import {
  PAYMENT_METHODS,
  defaultDepositAccountId,
  depositAccountLabel,
  depositAccounts,
  isBankAccountId,
  type DepositAccount,
} from "./deposit-accounts";

const HDFC: DepositAccount = { id: "11111111-1111-4111-8111-111111111111", name: "Current A/c", bank_name: "HDFC", account_number_last4: "1234", account_type: "current", is_active: true };
const SBI: DepositAccount  = { id: "22222222-2222-4222-8222-222222222222", name: "Savings", bank_name: "SBI", account_number_last4: null, account_type: "savings", is_active: true };
const CASH: DepositAccount = { id: "33333333-3333-4333-8333-333333333333", name: "Cash in hand", bank_name: "Cash", account_type: "cash", is_active: true };
const OLD: DepositAccount  = { id: "44444444-4444-4444-8444-444444444444", name: "Closed", bank_name: "ICICI", account_type: "current", is_active: false };
const CARD: DepositAccount = { id: "55555555-5555-4555-8555-555555555555", name: "Card", bank_name: "Amex", account_type: "credit_card", is_active: true };

describe("PAYMENT_METHODS", () => {
  it("names no company — every reseller sees the same plain list", () => {
    for (const m of PAYMENT_METHODS) expect(m.label).not.toMatch(/anutech|hdfc|icici|petty/i);
    expect(PAYMENT_METHODS.map((m) => m.value)).toEqual(["upi", "bank_transfer", "razorpay", "cheque", "cash", "other"]);
  });
});

describe("depositAccounts", () => {
  it("keeps active accounts that can receive money (no closed account, no credit card)", () => {
    expect(depositAccounts([HDFC, OLD, CARD, CASH]).map((a) => a.id)).toEqual([HDFC.id, CASH.id]);
  });
  it("a company with no accounts gets an empty list (the sheet then links to Add a bank account)", () => {
    expect(depositAccounts([])).toEqual([]);
    expect(depositAccounts(undefined)).toEqual([]);
  });
});

describe("defaultDepositAccountId", () => {
  it("one bank account → pre-picked for UPI / bank / Razorpay / cheque", () => {
    for (const m of ["upi", "bank_transfer", "razorpay", "cheque"]) {
      expect(defaultDepositAccountId([HDFC, CASH], m)).toBe(HDFC.id);
    }
  });
  it("cash → the one cash account, never a bank account", () => {
    expect(defaultDepositAccountId([HDFC, CASH], "cash")).toBe(CASH.id);
    expect(defaultDepositAccountId([HDFC], "cash")).toBe("");
  });
  it("several bank accounts → nothing pre-picked (a wrong tag is worse than none)", () => {
    expect(defaultDepositAccountId([HDFC, SBI], "upi")).toBe("");
  });
  it("other, or no accounts → not tagged", () => {
    expect(defaultDepositAccountId([HDFC], "other")).toBe("");
    expect(defaultDepositAccountId([], "upi")).toBe("");
  });
  it("closed accounts are ignored", () => {
    expect(defaultDepositAccountId([OLD, SBI], "bank_transfer")).toBe(SBI.id);
  });
});

describe("depositAccountLabel", () => {
  it("name · bank ••last4, without a stray ••null", () => {
    expect(depositAccountLabel(HDFC)).toBe("Current A/c · HDFC ••1234");
    expect(depositAccountLabel(SBI)).toBe("Savings · SBI");
  });
});

describe("isBankAccountId", () => {
  it("only a uuid passes — the old hard-coded ids never reach payments.bank_account_id", () => {
    expect(isBankAccountId(HDFC.id)).toBe(true);
    for (const bad of ["hdfc_primary", "cash_box", "icici_corp", "razorpay_gateway", "", null, undefined]) {
      expect(isBankAccountId(bad)).toBe(false);
    }
  });
});
