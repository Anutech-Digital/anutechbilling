/* R-404 — "Received in" on Record payment: this company's own accounts, never a hard-coded one. */
import { describe, it, expect } from "vitest";
import {
  PAYMENT_METHODS,
  defaultDepositAccountId,
  depositAccountLabel,
  depositAccounts,
  isBankAccountId,
  usualDepositAccountId,
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

/* R-1730 — the owner's examples (21 Oct audit): "Received in" defaulted to "Not sure yet" even
   where the usual account was obvious. Pre-select the only account, else the one this company
   usually receives into; "Not sure yet" only when there are 2+ and none is usual. */
describe("usualDepositAccountId (R-1730)", () => {
  const T1: DepositAccount = { id: "a1111111-1111-4111-8111-111111111111", name: "T-B1", bank_name: "HDFC Bank", account_number_last4: "0001", account_type: "current", is_active: true };
  const T2: DepositAccount = { id: "a2222222-2222-4222-8222-222222222222", name: "T-B2", bank_name: "HDFC Bank", account_number_last4: "0002", account_type: "current", is_active: true };
  const T3: DepositAccount = { id: "a3333333-3333-4333-8333-333333333333", name: "T-B3", bank_name: "HDFC Bank", account_number_last4: "0003", account_type: "current", is_active: true };
  const E2E: DepositAccount = { id: "a4444444-4444-4444-8444-444444444444", name: "E2E Bank Current A/c", bank_name: "E2E Test Bank", account_type: "current", is_active: true };

  it("owner example: the company's one bank account HDFC ••0003 → pre-selected", () => {
    expect(usualDepositAccountId([T3], "upi", [])).toBe(T3.id);
    expect(usualDepositAccountId([T3, CASH], "bank_transfer", [])).toBe(T3.id);
  });
  it("several banks, one of them gets the payments → that one (most used)", () => {
    const recent = [E2E.id, E2E.id, E2E.id, E2E.id];
    expect(usualDepositAccountId([E2E, T1, T2, T3], "upi", recent)).toBe(E2E.id);
    expect(usualDepositAccountId([E2E, T1, T2, T3], "upi", [T2.id, E2E.id, T2.id])).toBe(T2.id);
  });
  it("several banks and none usual (no history, or a tie) → '' = Not sure yet", () => {
    expect(usualDepositAccountId([T1, T2], "upi", [])).toBe("");
    expect(usualDepositAccountId([T1, T2], "upi", [T1.id, T2.id])).toBe("");
  });
  it("history pointing at a closed or cash account does not pick it for a bank method", () => {
    expect(usualDepositAccountId([T1, T2, OLD, CASH], "upi", [OLD.id, OLD.id, CASH.id])).toBe("");
  });
  it("cash → the one cash account; other → nothing", () => {
    expect(usualDepositAccountId([T1, T2, CASH], "cash", [T1.id])).toBe(CASH.id);
    expect(usualDepositAccountId([T1], "other", [T1.id])).toBe("");
  });
});
