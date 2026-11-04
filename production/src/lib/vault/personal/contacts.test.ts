/**
 * R-2392 — Private Vault → People: per-person position, search, form checks.
 * Owner's case (3 Nov): Ramesh lent me ₹2,00,000 (paid back ₹50,000), I lent him ₹30,000,
 * and he paid me a ₹1,00,000 byana for the plot → I owe him ₹2,20,000 net.
 */
import { describe, expect, test } from "vitest";
import {
  contactIssue,
  contactPosition,
  contactPositions,
  contactTxTotals,
  findByName,
  netSide,
  NET_SIDE_LABEL,
  normalisePan,
  pastLenders,
  searchContacts,
  type ContactLike,
} from "./contacts";

const c = (id: string, name: string, extra: Partial<ContactLike> = {}): ContactLike => ({
  id, name, relation: "family", phone: null, email: null, pan: null, archived: false, ...extra,
});

const loans = [
  { id: "L1", direction: "taken" as const, principal: 200000, status: "open" as const, contact_id: "ramesh" },
  { id: "L2", direction: "given" as const, principal: 30000, status: "open" as const, contact_id: "ramesh" },
  { id: "L3", direction: "given" as const, principal: 99999, status: "closed" as const, contact_id: "ramesh" },
  { id: "L4", direction: "taken" as const, principal: 500000, status: "open" as const, contact_id: null },
  { id: "L5", direction: "given" as const, principal: 10000, status: "open" as const, contact_id: "suresh" },
];
const payments = [
  { loan_id: "L1", kind: "prepayment" as const, paid_on: "2026-11-02", principal_part: 50000, interest_part: 0 },
  { loan_id: "L4", kind: "emi" as const, paid_on: "2026-11-02", principal_part: 1000, interest_part: 3000 },
];
const oweHold = [
  { amount: 100000, status: "open" as const, contact_id: "ramesh" },
  { amount: 40000, status: "settled" as const, contact_id: "ramesh" },
  { amount: 7000, status: "open" as const, contact_id: null },
];

describe("R-2392 contactPosition — everything with one person", () => {
  test("owner's case: borrowed 1.5L left, lent 30k, byana 1L open → I owe them 2.2L", () => {
    const p = contactPosition("ramesh", loans, payments, oweHold);
    expect(p).toEqual({ lent: 30000, borrowed: 150000, oweHold: 100000, net: -220000, openLoans: 2, openOweHold: 1 });
    expect(NET_SIDE_LABEL[netSide(p.net)]).toBe("I owe them");
  });
  test("a closed loan and a settled entry no longer count; unlinked rows never count", () => {
    const p = contactPosition("ramesh", loans, payments, oweHold);
    expect(p.lent).toBe(30000); // L3 (closed) left out
    expect(p.oweHold).toBe(100000); // the settled 40k left out
  });
  test("money lent out → They owe me", () => {
    const p = contactPosition("suresh", loans, payments, oweHold);
    expect(p.net).toBe(10000);
    expect(NET_SIDE_LABEL[netSide(p.net)]).toBe("They owe me");
  });
  test("a person with nothing open → Nothing owed", () => {
    const p = contactPosition("nobody", loans, payments, oweHold);
    expect(p.net).toBe(0);
    expect(NET_SIDE_LABEL[netSide(0)]).toBe("Nothing owed");
  });
  test("contactPositions gives every contact at once", () => {
    const m = contactPositions(["ramesh", "suresh"], loans, payments, oweHold);
    expect(m.get("ramesh")?.net).toBe(-220000);
    expect(m.get("suresh")?.net).toBe(10000);
  });
});

describe("R-2392 contactTxTotals — income from / paid to", () => {
  test("income kinds are received, expense is paid, transfers are neither", () => {
    expect(contactTxTotals([
      { kind: "other_income", amount: 1000 },
      { kind: "interest", amount: 500 },
      { kind: "expense", amount: 700 },
      { kind: "transfer_in", amount: 9999 },
    ])).toEqual({ received: 1500, paid: 700 });
  });
});

describe("R-2392 search + duplicates", () => {
  const list = [c("1", "Ramesh", { phone: "98100 00000" }), c("2", "anita", { email: "anita@example.com" }), c("3", "Old Friend", { archived: true })];
  test("search by name, phone (spaces ignored) or email, A→Z, archived hidden", () => {
    expect(searchContacts(list, "").map((x) => x.name)).toEqual(["anita", "Ramesh"]);
    expect(searchContacts(list, "ram").map((x) => x.id)).toEqual(["1"]);
    expect(searchContacts(list, "9810000").map((x) => x.id)).toEqual(["1"]);
    expect(searchContacts(list, "example").map((x) => x.id)).toEqual(["2"]);
    expect(searchContacts(list, "old")).toEqual([]);
    expect(searchContacts(list, "old", true).map((x) => x.id)).toEqual(["3"]);
  });
  test("findByName ignores case and spaces, skips archived and the row being edited", () => {
    expect(findByName(list, " ramesh ")?.id).toBe("1");
    expect(findByName(list, "Ramesh", "1")).toBeNull();
    expect(findByName(list, "old friend")).toBeNull();
  });
  test("contactIssue: name needed, no duplicate, email / PAN shape", () => {
    const f = { name: "", phone: "", email: "", pan: "" };
    expect(contactIssue(f, list)).toMatch(/name/);
    expect(contactIssue({ ...f, name: "RAMESH" }, list)).toMatch(/already in your people/);
    expect(contactIssue({ ...f, name: "Ramesh" }, list, "1")).toBeNull();
    expect(contactIssue({ ...f, name: "Suresh", email: "nope" }, list)).toMatch(/Email/);
    expect(contactIssue({ ...f, name: "Suresh", pan: "abc" }, list)).toMatch(/PAN/);
    expect(contactIssue({ ...f, name: "Suresh", pan: "abcde 1234 f" }, list)).toBeNull();
    expect(normalisePan("abcde 1234 f")).toBe("ABCDE1234F");
    expect(normalisePan("  ")).toBeNull();
  });
});

describe("R-2392 pastLenders — suggestions for bank / NBFC loans", () => {
  test("distinct non-person lenders, A→Z; person loans are not suggested", () => {
    expect(pastLenders([
      { loan_kind: "home", party: "SBI Home Loan" },
      { loan_kind: "car", party: "HDFC Bank" },
      { loan_kind: "home", party: "sbi home loan " },
      { loan_kind: "person", party: "Ramesh" },
    ])).toEqual(["HDFC Bank", "SBI Home Loan"]);
  });
});
