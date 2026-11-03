import { describe, it, expect } from "vitest";
import { guessCustomer } from "./credit-pay-for";
import { isNoCustomerYet } from "./no-customer-yet";

/**
 * R-2371 — the payer guess must not pick a customer from OUR OWN company name in the bank text,
 * nor from a generic trade word alone. Real staging lines (2–3 Nov 2026).
 */
const OWN = { payers: [], ownNames: ["Zenova Technologies Private Limited"] };
const OWN_LINE = "NEFT CR-KKBK0000958-ORBITAL COMMUNICATIONS PRIVATE L-ZENOVA TECHNOLOGIES-KKBKH26268931236";
const PAYER_LINE = "UPI-NOVA PRINTERS-9811122233@YBL-HDFC0000123-412345678901-PAYMENT";

describe("R-2371 customer guess — our own name in the narration", () => {
  const customers = [
    { id: "zenova", name: "Zenova Skills Academy" },
    { id: "rks", name: "R K S PRINTERS" },
    { id: "acme", name: "Acme Traders" },
  ];

  it("'…-ZENOVA TECHNOLOGIES-…' (our own name) does not guess Zenova Skills Academy", () => {
    expect(guessCustomer({ description: OWN_LINE }, customers, [], OWN)).toBeNull();
  });

  it("the real payer still wins when it is a customer", () => {
    const withPayer = [...customers, { id: "orbital", name: "Orbital Communications Pvt Ltd" }];
    const g = guessCustomer({ description: OWN_LINE }, withPayer, [], OWN);
    expect(g?.customerId).toBe("orbital");
    expect(g?.reason).toBe("the bank line says “orbital communications”");
  });

  it("own name is stripped even with known payers in memory (no learned payer hit)", () => {
    const memory = {
      ownNames: OWN.ownNames,
      payers: [{
        id: "k1", customer_id: "acme", payer_name: "SOMEONE ELSE", payer_name_key: "someone else", relation: "third_party" as const,
        note: null, ifsc: null, upi_id: null, account_tail: null, uses: 1, first_seen_txn: null, created_at: "2026-11-01T00:00:00Z",
      }],
    };
    expect(guessCustomer({ description: OWN_LINE }, customers, [], memory)).toBeNull();
  });

  it("the trade (UPI payee) name is our name too", () => {
    const own = { payers: [], ownNames: ["Anutech Digital Pvt Ltd", "ZENOVA TECHNOLOGIES"] };
    expect(guessCustomer({ description: OWN_LINE }, customers, [], own)).toBeNull();
  });

  it("a customer's own word still guesses, with or without our names known", () => {
    expect(guessCustomer({ description: "NEFT CR-ACME TRADERS-UTR123" }, customers, [], OWN)?.customerId).toBe("acme");
    expect(guessCustomer({ description: "NEFT CR-ACME TRADERS-UTR123" }, customers)?.customerId).toBe("acme");
    expect(guessCustomer({ description: "NEFT CR-ACME TRADERS-UTR123" }, customers, [], { payers: [], ownNames: [] })?.customerId).toBe("acme");
  });

  it("only our WHOLE name is taken out: UPI payee 'RAVI SHARMA' does not hide 'Sharma Steel'", () => {
    const own = { payers: [], ownNames: ["Anutech Digital Pvt Ltd", "RAVI SHARMA"] };
    const cs = [{ id: "sh", name: "Sharma Steel" }, { id: "acme", name: "Acme Traders" }];
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-SHARMA STEEL-UTR5" }, cs, [], own)?.customerId).toBe("sh");
    expect(guessCustomer({ description: "UPI-RAVI SHARMA-RAVI@OKHDFC-HDFC0001-1234" }, cs, [], own)).toBeNull();
  });

  it("our name alone in a line where a customer's word also appears → still that customer", () => {
    const cs = [{ id: "zenova", name: "Zenova Infra Projects" }];
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-ZENOVA INFRA PROJECTS-ZENOVA TECHNOLOGIES-UTR1" }, cs, [], OWN)?.customerId).toBe("zenova");
  });

  it("a 'certain' invoice match that rests only on our own name is no guess", () => {
    const ms = [{ customerName: "Zenova Skills Academy", confidence: "certain", reasons: ["Exact amount due", "Narration says “zenova”"] }];
    expect(guessCustomer({ description: OWN_LINE }, customers, ms, OWN)).toBeNull();
  });

  it("a 'certain' invoice match by invoice number still guesses", () => {
    const ms = [{ customerName: "Zenova Skills Academy", confidence: "certain", reasons: ["Narration carries INV-12", "Exact amount due", "Narration says “zenova”"] }];
    expect(guessCustomer({ description: `${OWN_LINE} INV-12` }, customers, ms, OWN)?.customerId).toBe("zenova");
  });
});

describe("R-2371 customer guess — a generic trade word alone is not a match", () => {
  const customers = [{ id: "rks", name: "R K S PRINTERS" }, { id: "acme", name: "Acme Traders" }];

  it("'UPI-NOVA PRINTERS…' does not guess R K S PRINTERS (only 'printers' is shared)", () => {
    expect(guessCustomer({ description: PAYER_LINE }, customers, [], OWN)).toBeNull();
    expect(guessCustomer({ description: PAYER_LINE }, customers)).toBeNull();
  });

  it("the real Nova Printers is still found by its distinctive word", () => {
    const g = guessCustomer({ description: PAYER_LINE }, [...customers, { id: "nova", name: "Nova Printers" }]);
    expect(g?.customerId).toBe("nova");
    expect(g?.reason).toBe("the bank line says “nova”");
  });

  it("other generic trade words never pick a customer on their own", () => {
    const cs = [{ id: "a", name: "Mehta Traders" }, { id: "b", name: "Global Associates" }, { id: "c", name: "Infotech Consultants" }];
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-RAJ TRADERS-UTR9" }, cs)).toBeNull();
    expect(guessCustomer({ description: "IMPS-5190-KUMAR ASSOCIATES-HDFC" }, cs)).toBeNull();
    expect(guessCustomer({ description: "IMPS-5190-NOVA CONSULTANTS-HDFC" }, cs)).toBeNull();
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-MEHTA TRADERS-UTR9" }, cs)?.customerId).toBe("a");
  });

  it("a customer named only by trade words is found when the line says its whole name", () => {
    const cs = [{ id: "b", name: "Global Associates" }, { id: "a", name: "Mehta Traders" }];
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-GLOBAL ASSOCIATES-UTR9" }, cs)?.customerId).toBe("b");
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-KUMAR ASSOCIATES-UTR9" }, cs)).toBeNull();
  });

  it("a 'certain' invoice match on a trade word alone is no guess", () => {
    const ms = [{ customerName: "R K S PRINTERS", confidence: "certain", reasons: ["Exact amount due", "Narration says “printers”"] }];
    expect(guessCustomer({ description: PAYER_LINE }, customers, ms)).toBeNull();
  });
});

describe("R-2371 Money in · no customer yet", () => {
  it("the Zenova line has no customer yet when our own name is known", () => {
    const txn = { credit: 5000, matched_to_type: null, description: OWN_LINE };
    const customers = [{ id: "zenova", name: "Zenova Skills Academy" }];
    expect(isNoCustomerYet(txn, customers, [], OWN)).toBe(true);
  });
});
