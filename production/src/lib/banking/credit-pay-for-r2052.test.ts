/* R-2052 — Pardeep 28 Oct (localhost, Reconcile → "A new sale", Starter, Annual, Half-yearly):
   "Renews on" stays at the end of the 1-year commitment (a renewal quote on the 2nd part's day
   would bill twice — R-807/R-808). Next to it: "Paid up to <day before the next part> · next bill
   ₹X on <date>". Extra money (advance credit) that pays later parts in full moves "paid up to". */
import { describe, expect, it } from "vitest";
import { paidUpText, salePaidUp, saleLineFromItem, saleSchedule } from "./credit-pay-for";

const STARTER = {
  id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
  item_type: "subscription", prices: { annual: { msrp: 270, wholesale: 110 } },
} as never;
const lines = [saleLineFromItem(STARTER, "annual_yearly", 10)];   // ₹32,400 a year + GST
const START = "2026-10-23";
const RENEW = "2027-10-23";

describe("R-2052 paid up to — Annual commitment billed in parts", () => {
  it("Half-yearly from 23-10-2026 → paid up to 22-04-2027, next bill on 23 Apr 2027", () => {
    const s = saleSchedule(lines, 18, "half_yearly", START);
    const p = salePaidUp(s, 0, RENEW);
    expect(p).toMatchObject({ paidUpTo: "2027-04-22", next: { billOn: "2027-04-23", gross: 19116 }, rest: [] });
    expect(paidUpText(p!)).toBe("Paid up to 22-04-2027 · next bill ₹19,116 on 23 Apr 2027.");
  });
  it("Quarterly → paid up to 22-01-2027; the later bills are said once, after the next one", () => {
    const p = salePaidUp(saleSchedule(lines, 18, "quarterly", START), 0, RENEW)!;
    expect(p.paidUpTo).toBe("2027-01-22");
    expect(paidUpText(p)).toBe("Paid up to 22-01-2027 · next bill ₹9,558 on 23 Jan 2027, then 2 more ₹9,558 each, on 23 Apr 2027 and 23 Jul 2027.");
  });
  it("Annual — 1 payment a year → no paid-up line; Monthly flex → none", () => {
    expect(salePaidUp(saleSchedule(lines, 18, "yearly", START), 0, RENEW)).toBeNull();
    const flex = [saleLineFromItem(STARTER, "monthly", 10)];
    expect(salePaidUp(saleSchedule(flex, 18, "quarterly", START), 0, RENEW)).toBeNull();
  });
  it("extra money that pays the next part in full moves paid-up to the end of that part", () => {
    const s = saleSchedule(lines, 18, "quarterly", START);
    const p = salePaidUp(s, 9558, RENEW)!;
    expect(p).toMatchObject({ paidUpTo: "2027-04-22", next: { billOn: "2027-04-23" } });
    expect(paidUpText(p)).toBe("Paid up to 22-04-2027 · next bill ₹9,558 on 23 Apr 2027, then ₹9,558 on 23 Jul 2027.");
  });
  it("extra money short of a whole part → paid up to the first part only", () => {
    expect(salePaidUp(saleSchedule(lines, 18, "quarterly", START), 5000, RENEW)!.paidUpTo).toBe("2027-01-22");
  });
  it("extra money paying every later part → paid up to the day before Renews on, no next bill", () => {
    const p = salePaidUp(saleSchedule(lines, 18, "half_yearly", START), 19116, RENEW)!;
    expect(p).toMatchObject({ paidUpTo: "2027-10-22", next: null, rest: [] });
    expect(paidUpText(p)).toBe("The whole year is paid.");   // R-2053: the term line says when it ends
  });
});
