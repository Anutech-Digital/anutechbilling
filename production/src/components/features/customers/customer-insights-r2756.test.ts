/**
 * R-2756 (user audit 14 Nov, job 5): after "Won't renew" on SCN Kochi the customer page still said
 * "Next best action: Send renewal quote". A Won't renew subscription is not a renewal to send.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { deriveCustomerInsights } from "./customer-insights";

const customer = { name: "SCN Kochi", contact_name: "Anil", contact_phone: null, contact_email: "a@example.test" } as never;
const sub = (id: string, renewal_date: string, auto_renew: boolean) =>
  ({ id, status: "active", renewal_date, auto_renew, outstanding_amount: 0, mrr: 1000, seats: 1, used: 0 });

describe("R-2756: customer page next best action for a Won't renew subscription", () => {
  afterEach(() => { vi.useRealTimers(); });
  const at = () => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T06:30:00Z")); };

  it("its only near subscription is Won't renew → 'Won't renew · ends <date>', no Send renewal quote", () => {
    at();
    const ins = deriveCustomerInsights(customer, [sub("k", "2026-11-30", false)] as never, []);
    expect(ins.nba.title).toBe("Won't renew · ends 30 Nov 2026");
    expect(ins.nba.cta).toBeUndefined();
    expect(ins.nearestRenewal).toBeUndefined();
  });

  it("a renewing subscription due before the Won't renew one still gets Send renewal quote", () => {
    at();
    const ins = deriveCustomerInsights(customer, [sub("k", "2026-11-30", false), sub("r", "2026-11-20", true)] as never, []);
    expect(ins.nba.cta?.label).toBe("Send renewal quote");
    expect(ins.nearestRenewal).toBe("2026-11-20");
  });

  it("a renewal due this month is the action even when the Won't renew one ends first", () => {
    at();
    const ins = deriveCustomerInsights(customer, [sub("k", "2026-11-18", false), sub("r", "2026-12-05", true)] as never, []);
    expect(ins.nba.cta?.label).toBe("Send renewal quote");
    expect(ins.nearestRenewal).toBe("2026-12-05");
  });

  it("a later renewal (31+ days) → the Won't renew words", () => {
    at();
    const ins = deriveCustomerInsights(customer, [sub("k", "2026-11-18", false), sub("r", "2027-03-05", true)] as never, []);
    expect(ins.nba.title).toBe("Won't renew · ends 18 Nov 2026");
  });

  it("a Won't renew date already passed is not 'ends <past date>' and not Send renewal quote", () => {
    at();
    const ins = deriveCustomerInsights(customer, [sub("k", "2026-10-04", false)] as never, []);
    expect(ins.nba.title).not.toMatch(/Won't renew/);
    expect(ins.nba.cta?.label).not.toBe("Send renewal quote");
  });

  it("money owed still comes first", () => {
    at();
    const ins = deriveCustomerInsights(customer, [{ ...sub("k", "2026-11-30", false), outstanding_amount: 500 }] as never, []);
    expect(ins.nba.title).toMatch(/outstanding/);
  });
});
