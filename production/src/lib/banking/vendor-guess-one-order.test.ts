/**
 * R-1919 — ONE vendor guess for the Reconcile sheet and auto-reconcile.
 * Order: UPI id → account no → masked account tail → Category Rule → learned alias → name words. A tie names nobody.
 *
 * The SQL twin (bank_debit_vendor_guess + bank_narration_key, migration 20261026012857) is checked
 * on the SAME narrations, vendors, rules and aliases by supabase/tests/r1919_vendor_guess_one_order.test.sql
 * — the last test here fails if a case is missing there, so the two can never drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guessVendor, vendorsForRule, type VendorAlias } from "./debit-pay-for";
import { narrationKey } from "./narration-key";
import { bankDetailsFromNarration } from "./narration-bank-details";
import type { CategoryRule } from "./categorise";

/* ── The shared fixture (same names / numbers in the SQL test) ── */
const vendors = [
  { id: "v1", name: "Sharma Associates", upi_id: "sharma@okhdfcbank", bank_account_no: "50100123456789" },
  { id: "v2", name: "Sharma Traders" },
  { id: "v3", name: "Facebook India Online Services" },
  { id: "v4", name: "Kapoor Legal Associates", bank_account_no: "11112222334455" },
  { id: "v5", name: "Kapoor Stationers", bank_account_no: "99998888774455" },
  { id: "v6", name: "Gupta Cloud", bank_account_no: "50100999888777" },
  { id: "v7", name: "Gupta Telecom" },
];
const rules: CategoryRule[] = [
  { id: "00000000-0000-0000-0000-000000000001", pattern: "PAYUFACEBOOK", category: "Advertising", direction: "debit" },
  { id: "00000000-0000-0000-0000-000000000002", pattern: "GUPTA", category: "Internet", direction: "any" },
  /* A credit-only rule never decides a money-out line. */
  { id: "00000000-0000-0000-0000-000000000003", pattern: "TRADERS", category: "Sales", direction: "credit" },
];
const aliases: VendorAlias[] = [
  { narration_key: "payufacebook", vendor_id: "v2" },        // loses to the Category Rule (case 3)
  { narration_key: "sharma associates", vendor_id: "v2" },   // beats name words (case 4)
  { narration_key: "ms tiwari", vendor_id: "v4" },           // two vendors on one key → tie (case 7)
  { narration_key: "ms tiwari", vendor_id: "v5" },
];

/** id → narration → expected vendor (null = no guess) and step. */
export const R1919_CASES: Array<{ id: string; description: string; vendor: string | null; step?: string }> = [
  { id: "C1", description: "UPI/412345678/KAPOOR LEGAL/sharma@okhdfcbank/fees", vendor: "v1", step: "upi" },
  { id: "C2", description: "NEFT TO A/C 50100999888777 PAYUFACEBOOK", vendor: "v6", step: "account" },
  { id: "C3", description: "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK", vendor: "v3", step: "rule" },
  { id: "C4", description: "IMPS-612256087508-SHARMA ASSOCIATES-FINO-XXXX6722-RENT", vendor: "v2", step: "alias" },
  { id: "C5", description: "NEFT-KAPOOR LEGAL ASSOCIATES-KL201", vendor: "v4", step: "name" },
  { id: "C6", description: "NEFT GUPTA PAYMENT", vendor: null },
  { id: "C7", description: "IMPS-612256087509-MS TIWARI-SBIN-XXXX1234-RENT", vendor: null },
  { id: "C8", description: "Bank fee", vendor: null },
  { id: "C9", description: "SHARMA TRADERS REFUND", vendor: "v2", step: "name" },
  /* Masked account tail (R-1918 parser): below a full account no, above Category Rule / alias / name words. */
  { id: "C10", description: "IMPS-612256080000-KAPOOR LEGAL-HDFC-XXXXXX8777-HOSTING", vendor: "v6", step: "account_tail" },
  { id: "C11", description: "NEFT DR-HDFC0001234-KAPOOR-NETBANK, MUM-XXXXXXXX4455-FEES", vendor: null },
];

/** The masked account tail — bankDetailsFromNarration().accountTail and its SQL twin bank_narration_account_tail. */
export const R1919_TAILS: Array<{ id: string; description: string; tail: string | null }> = [
  { id: "T1", description: "IMPS-612256080000-KAPOOR LEGAL-HDFC-XXXXXX8777-HOSTING", tail: "8777" },
  { id: "T2", description: "IMPS-621856395591-RAVI KUMAR-ICIC-XX XXXXXX4658-SALARY", tail: "4658" },
  { id: "T3", description: "IMPS-612256080000-RAVI KUMAR-HDFC-50100123456789-RENT", tail: null },
  { id: "T4", description: "50100123456789-TPT-RENT-SHARMA ASSOCIATES", tail: null },
  { id: "T5", description: "NEFT DR-HDFC0001234-KAPOOR-NETBANK, MUM-****4455-FEES", tail: "4455" },
  { id: "T6", description: "Bank fee", tail: null },
];

export const R1919_KEYS: Array<{ id: string; description: string; key: string | null }> = [
  { id: "K1", description: "IMPS-612256087508-PRASHANT BHAIYA-FINO-XXXX6722-SALARY", key: "prashant bhaiya" },
  { id: "K2", description: "NEFT DR-BKID0006087-PRATIK-NETBANK, MUM-N283-INV", key: "pratik" },
  { id: "K3", description: "UPI/412345678/SHARMA ASSOC/sharma@okhdfcbank/fees", key: "sharma assoc" },
  { id: "K4", description: "UPI-RAVI KUMAR-ravi@ybl-SBIN0001234-412345-rent", key: "ravi kumar" },
  { id: "K5", description: "50100123456789-TPT-RENT OCT-SHARMA ASSOCIATES", key: "sharma associates" },
  { id: "K6", description: "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK", key: "payufacebook" },
  { id: "K7", description: "POS 416021XXXXXX1234 FACEBK ADS", key: "pos facebk ads" },
  { id: "K8", description: "12345 678", key: null },
  { id: "K9", description: "", key: null },
];

describe("R-1919 narrationKey — the part of the narration that names the payee", () => {
  for (const c of R1919_KEYS) {
    it(`${c.id}: ${c.description || "(empty)"} → ${c.key}`, () => {
      expect(narrationKey(c.description)).toBe(c.key);
    });
  }
  it("two lines to the same payee give the same key (different reference, remark)", () => {
    expect(narrationKey("IMPS-612256087508-MS TIWARI-SBIN-XXXX1234-RENT SEP"))
      .toBe(narrationKey("IMPS-998877665544-MS TIWARI-SBIN-XXXX1234-RENT OCT"));
    expect(narrationKey("DHDF23P1QTMPV7/PAYUFACEBOOK")).toBe(narrationKey("K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK"));
  });
});

describe("R-1919 account tail — the masked account digits R-1918 reads", () => {
  for (const c of R1919_TAILS) {
    it(`${c.id}: ${c.description} → ${c.tail}`, () => {
      expect(bankDetailsFromNarration(c.description).accountTail).toBe(c.tail);
    });
  }
  it("a 3-digit tail is too short to name a vendor", () => {
    expect(guessVendor({ description: "IMPS-1-NOBODY-HDFC-XXXX777-X" }, [{ id: "z", name: "Zed", bank_account_no: "123456777" }])).toBeNull();
  });
});

describe("R-1919 guessVendor — one order: UPI → account no → account tail → Category Rule → learned alias → name words", () => {
  for (const c of R1919_CASES) {
    it(`${c.id}: ${c.description} → ${c.vendor ?? "no guess"}${c.step ? ` (${c.step})` : ""}`, () => {
      const g = guessVendor({ description: c.description, debit: 1000 }, vendors, { rules, aliases });
      expect(g?.vendorId ?? null).toBe(c.vendor);
      if (c.step) expect(g?.step).toBe(c.step);
    });
  }

  it("without rules and aliases the same line falls to the next step (order, not luck)", () => {
    expect(guessVendor({ description: "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK" }, vendors)).toBeNull();
    expect(guessVendor({ description: "IMPS-612256087508-SHARMA ASSOCIATES-FINO-XXXX6722-RENT" }, vendors)?.vendorId).toBe("v1");
  });

  it("a learned alias says so — 'your last payment to this vendor'", () => {
    const g = guessVendor({ description: "IMPS-1-SHARMA ASSOCIATES-FINO-X-RENT" }, vendors, { aliases });
    expect(g).toEqual({ vendorId: "v2", reason: "your last payment to this vendor", step: "alias" });
  });

  it("an alias to a vendor that no longer exists is ignored", () => {
    expect(guessVendor({ description: "IMPS-1-RK INFRA-FINO-X-RENT" }, vendors, { aliases: [{ narration_key: "rk infra", vendor_id: "gone" }] })).toBeNull();
  });

  it("Category Rule → vendor: first five letters, or the vendor's first word inside the pattern", () => {
    expect(vendorsForRule("FACEBK", vendors).map((v) => v.id)).toEqual(["v3"]);
    expect(vendorsForRule("PAYUFACEBOOK", vendors).map((v) => v.id)).toEqual(["v3"]);
    expect(vendorsForRule("GUPTA", vendors).map((v) => v.id)).toEqual(["v6", "v7"]);
    expect(vendorsForRule("ABC", vendors)).toEqual([]);
  });

  it("every case is also in the SQL test, with the same expectation", () => {
    const sql = readFileSync(join(__dirname, "../../../supabase/tests/r1919_vendor_guess_one_order.test.sql"), "utf8");
    for (const c of R1919_CASES) {
      expect(sql, `${c.id} missing in the SQL test`).toContain(`('${c.id}', '${c.description.replace(/'/g, "''")}', ${c.vendor ? `'${c.vendor}'` : "null"})`);
    }
    for (const t of R1919_TAILS) {
      expect(sql, `${t.id} missing in the SQL test`).toContain(`('${t.id}', '${t.description}', ${t.tail ? `'${t.tail}'` : "null"})`);
    }
    for (const k of R1919_KEYS) {
      expect(sql, `${k.id} missing in the SQL test`).toContain(`('${k.id}', '${k.description}', ${k.key ? `'${k.key}'` : "null"})`);
    }
  });
});
