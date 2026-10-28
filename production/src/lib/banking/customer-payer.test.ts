/* R-2025 (1)(2)(4) — who REALLY paid a money-in bank line, and whether that is the customer.
   Real narration from Pardeep's staging (27 Oct, ₹16,709):
     NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759
   payer = SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED, beneficiary = our own company (Orbit Software). */
import { describe, expect, it } from "vitest";
import {
  knownPayerCustomer, onBehalfLine, payerFromNarration, payerKey, payerMatchesCustomer, type KnownPayer,
} from "./customer-payer";
import { guessCustomer } from "./credit-pay-for";

const OWN = ["Orbit Software Pvt Ltd"];
const SHREE = "NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759";

const known = (o: Partial<KnownPayer>): KnownPayer => ({
  id: "kp1", customer_id: "c-links", payer_name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED",
  payer_name_key: "shree nandik technologies private limited", relation: "group_company", note: null,
  ifsc: null, upi_id: null, account_tail: null, uses: 1, first_seen_txn: null, created_at: "2026-10-27T12:00:00Z", ...o,
});

describe("R-2025 (1) payerFromNarration", () => {
  it("the staging NEFT line: payer is Shree Nandik, never our own company; IFSC read", () => {
    const p = payerFromNarration(SHREE, OWN);
    expect(p?.name).toBe("SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED");
    expect(p?.key).toBe("shree nandik technologies private limited");
    expect(p?.ifsc).toBe("INDB0000006");
  });

  it("a bank that writes OUR name in the name slot: the next slot is the payer", () => {
    const p = payerFromNarration("NEFT CR-HDFC0000240-ORBIT SOFTWARE PVT LTD-RAJESH KUMAR-N123456789", OWN);
    expect(p?.name).toBe("RAJESH KUMAR");
  });

  it("RTGS and IMPS credits; masked account tail kept", () => {
    expect(payerFromNarration("RTGS CR-SBIN0001234-BHARAT STEEL LTD-ORBIT SOFTWARE-SBINR52026102700012", OWN)?.name).toBe("BHARAT STEEL LTD");
    const imps = payerFromNarration("IMPS-630012345678-ACME TRADERS-HDFC-XXXXXXX4521-INV 44", OWN);
    expect(imps?.name).toBe("ACME TRADERS");
    expect(imps?.accountTail).toBe("4521");
  });

  it("UPI credits: payer name and UPI id", () => {
    const u = payerFromNarration("UPI/630098765432/NEHA SHARMA/neha.s@okaxis/Payment", OWN);
    expect(u?.name).toBe("NEHA SHARMA");
    expect(u?.upi).toBe("neha.s@okaxis");
    expect(payerFromNarration("UPI-NEHA SHARMA-neha.s@okaxis-UTIB0000001-630098765432-PAY", OWN)?.name).toBe("NEHA SHARMA");
  });

  it("nothing readable, or only our own name → no payer", () => {
    expect(payerFromNarration("CASH DEPOSIT BY SELF", OWN)).toBeNull();
    expect(payerFromNarration("NEFT CR-INDB0000006-ORBIT SOFTWARE-ORBIT SOFTWARE PVT LTD-UTR1", OWN)).toBeNull();
    expect(payerFromNarration(null, OWN)).toBeNull();
  });

  it("payerKey: lower-case letters and single spaces", () => {
    expect(payerKey("  Shree  Nandik Tech. ")).toBe("shree nandik tech");
    expect(payerKey("A1")).toBeNull();
  });
});

describe("R-2025 (2) payerMatchesCustomer — when to warn", () => {
  const p = payerFromNarration(SHREE, OWN)!;
  it("a different company → no match (warn)", () => {
    expect(payerMatchesCustomer(p, "Links Infotech", [])).toBe(false);
  });
  it("the customer's own name, Pvt / Private written either way → match", () => {
    expect(payerMatchesCustomer(p, "Shree Nandik Technologies Pvt Ltd", [])).toBe(true);
  });
  it("a bank-truncated name still matches ('…PRI')", () => {
    const t = payerFromNarration("NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRI-ORBIT SOFTWARE-UTR9", OWN)!;
    expect(payerMatchesCustomer(t, "Shree Nandik Technologies Pvt Ltd", [])).toBe(true);
  });
  it("one shared word is not enough (director Rajesh Kumar paying for Kumar Traders → warn)", () => {
    const r = payerFromNarration("NEFT CR-HDFC0000240-RAJESH KUMAR-ORBIT SOFTWARE-N1", OWN)!;
    expect(payerMatchesCustomer(r, "Kumar Traders", [])).toBe(false);
  });
  it("a known payer of THIS customer → match (no warning next time)", () => {
    expect(payerMatchesCustomer(p, "Links Infotech", [known({})])).toBe(true);
  });
});

describe("R-2025 (4) learning — known payer guesses the customer", () => {
  const customers = [{ id: "c-links", name: "Links Infotech" }, { id: "c-acme", name: "Acme Traders" }];
  it("one customer knows this payer → guessed, 'known payer for Links Infotech'", () => {
    const g = guessCustomer({ description: SHREE }, customers, [], { payers: [known({})], ownNames: OWN });
    expect(g?.customerId).toBe("c-links");
    expect(g?.reason).toBe("known payer for Links Infotech");
    expect(g?.payer?.relation).toBe("group_company");
  });
  it("the same payer known for TWO customers → no guess at all, pick by hand", () => {
    const payers = [known({}), known({ id: "kp2", customer_id: "c-acme" })];
    expect(knownPayerCustomer("shree nandik technologies private limited", payers)).toEqual({ kind: "many" });
    expect(guessCustomer({ description: SHREE }, customers, [], { payers, ownNames: OWN })).toBeNull();
  });
  it("no known payers → the old name guess is unchanged", () => {
    expect(guessCustomer({ description: "NEFT CR-X-ACME TRADERS-ORBIT SOFTWARE-U1" }, customers, [], { payers: [], ownNames: OWN })?.customerId).toBe("c-acme");
  });
});

describe("R-2025 (3)(6) the receipt line", () => {
  it("on behalf of the customer — the customer stays the party", () => {
    expect(onBehalfLine("SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED", "group_company", "Links Infotech"))
      .toBe("Received from SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED (group company) on behalf of Links Infotech");
    expect(onBehalfLine("Rajesh Kumar", "director", "Kumar Traders")).toBe("Received from Rajesh Kumar (director) on behalf of Kumar Traders");
  });
  it("the customer's own other account → 'from their account in the name of …'", () => {
    expect(onBehalfLine("SNT PAYROLL AC", "own_account", "Links Infotech")).toBe("Received from Links Infotech's other account (SNT PAYROLL AC)");
  });
  it("no payer → nothing", () => {
    expect(onBehalfLine(null, null, "Links Infotech")).toBeNull();
  });
});
