/* R-1685 — a cancelled / ended subscription shows no renewal, no renewal amount, no renewal or
   payment clock; money is shown only when it is really still owed. One helper decides it:
   subscriptionEnded() in renewal-display.ts. */
import { describe, it, expect } from "vitest";
import { subscriptionEnded, renewalClock, liveTermAmount } from "./renewal-display";
import { subscriptionFacts } from "./facts";
import { subscriptionExceptions } from "./exceptions";
import { scheduleCountLabel } from "@/components/features/subscriptions/schedule-invoices";

describe("subscriptionEnded — the one status rule", () => {
  it("cancelled and expired are ended; active, paused, trial are not", () => {
    expect(subscriptionEnded("cancelled")).toBe(true);
    expect(subscriptionEnded("expired")).toBe(true);
    expect(subscriptionEnded("active")).toBe(false);
    expect(subscriptionEnded("paused")).toBe(false);
    expect(subscriptionEnded(null)).toBe(false);
  });
  it("renewalClock agrees with it", () => {
    expect(renewalClock({ status: "cancelled", renewal_date: "2026-10-19" }, 0)?.tone).toBe("ended");
  });
});

describe("T-19: cancelled quarterly ₹540/mo", () => {
  it("no 'Quarterly · ₹1,620' amount on the term badge", () => {
    expect(liveTermAmount("cancelled", "₹1,620")).toBeNull();
    expect(liveTermAmount("active", "₹1,620")).toBe("₹1,620");
  });

  it("drawer facts: MRR is not '₹540/mo' for an ended subscription", () => {
    const f = subscriptionFacts({ seats: 1, used: 0, mrr: 540, status: "cancelled", outstanding_amount: 0 });
    expect(f.find((x) => x.label === "MRR")?.value).toBe("— (ended)");
    expect(f.find((x) => x.label === "Owed")?.value).toBe("Nothing");
  });

  it("no 'Won't auto-renew', no renewal chase, no payment countdown on a cancelled row", () => {
    const flags = subscriptionExceptions({
      status: "cancelled", auto_renew: false, renewal_state: "early_notice", reminder_count: 2,
      outstanding_amount: 0, payment_due_date: "2026-10-24",
    });
    expect(flags).toEqual([]);
  });

  it("money still owed on a cancelled row stays visible — as owed, without the 'service is active' clock", () => {
    const flags = subscriptionExceptions({ status: "cancelled", auto_renew: false, outstanding_amount: 1180, payment_due_date: "2026-10-24" });
    expect(flags.map((f) => f.key)).toEqual(["outstanding"]);
    expect(flags[0].label).toBe("₹1,180 still owed");
  });

  it("an active row is unchanged", () => {
    const flags = subscriptionExceptions({ status: "active", auto_renew: false, outstanding_amount: 1180, payment_due_date: null });
    expect(flags.map((f) => f.key)).toEqual(["auto_renew_off", "outstanding", "payment-due"]);
  });
});

describe("T-16: the schedule counts invoices only when there is one", () => {
  it("two billing dates, none invoiced → no '2 invoices'", () => {
    expect(scheduleCountLabel(2, 0)).toBe("2 billing dates");
    expect(scheduleCountLabel(1, 0)).toBe("1 billing date");
    expect(scheduleCountLabel(4, 1)).toBe("4 billing dates · 1 invoiced");
  });
});
