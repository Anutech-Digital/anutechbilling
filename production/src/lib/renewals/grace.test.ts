/**
 * R-1621 — grace after the renewal date: trusted customer, "+N days", the stop date in the mail.
 */
import { describe, it, expect } from "vitest";
import { decideCadence, effectiveGraceDays, serviceStopDate } from "./cadence";
import { renderTemplate, type RenewalTemplateContext } from "./templates";
import { isMissingColumn } from "./grace-overrides";

describe("effectiveGraceDays", () => {
  it("uses the company grace when the customer has none", () => {
    expect(effectiveGraceDays({ tenantGraceDays: 7, renewalDate: "2026-10-01" })).toBe(7);
    expect(effectiveGraceDays({ tenantGraceDays: null, renewalDate: "2026-10-01" })).toBe(0);
  });
  it("a trusted customer's own grace wins over the company's — both ways", () => {
    expect(effectiveGraceDays({ tenantGraceDays: 7, trustedGraceDays: 30, renewalDate: "2026-10-01" })).toBe(30);
    expect(effectiveGraceDays({ tenantGraceDays: 7, trustedGraceDays: 3, renewalDate: "2026-10-01" })).toBe(3);
  });
  it("+N days for this term stretches grace to grace_until, never shortens it", () => {
    expect(effectiveGraceDays({ tenantGraceDays: 7, renewalDate: "2026-10-01", graceUntil: "2026-10-20" })).toBe(19);
    expect(effectiveGraceDays({ tenantGraceDays: 7, renewalDate: "2026-10-01", graceUntil: "2026-10-03" })).toBe(7);
  });
  it("a grace_until from an earlier term (on/before the renewal date) is ignored", () => {
    expect(effectiveGraceDays({ tenantGraceDays: 7, renewalDate: "2027-10-01", graceUntil: "2026-10-20" })).toBe(7);
    expect(effectiveGraceDays({ tenantGraceDays: 7, renewalDate: "2026-10-01", graceUntil: "2026-10-01" })).toBe(7);
  });
});

describe("cadence with the effective grace", () => {
  const today = new Date("2026-10-11T06:00:00Z"); // 11 Oct IST
  it("day 10 past renewal: company grace 7 → grace over; trusted 30 → still in grace", () => {
    const over = decideCadence({ renewalDate: "2026-10-01", graceDays: effectiveGraceDays({ tenantGraceDays: 7, renewalDate: "2026-10-01" }), currentState: "grace_period", today });
    expect(over.shouldSuspend).toBe(true);
    const trusted = decideCadence({ renewalDate: "2026-10-01", graceDays: effectiveGraceDays({ tenantGraceDays: 7, trustedGraceDays: 30, renewalDate: "2026-10-01" }), currentState: "grace_period", today });
    expect(trusted.targetState).toBe("grace_period");
    expect(trusted.shouldSuspend).toBe(false);
    expect(trusted.shouldSendEmail).toBe(false); // the grace mail went once already
  });
});

describe("serviceStopDate — the day after the last grace day", () => {
  it("matches the day the owner's task is raised", () => {
    expect(serviceStopDate("2026-10-01", 7)).toBe("2026-10-09");
    expect(serviceStopDate("2026-10-01", 0)).toBe("2026-10-02");
    expect(serviceStopDate("2026-12-28", 7)).toBe("2027-01-05");
    // decideCadence: day 8 is still grace, day 9 is over
    const d8 = decideCadence({ renewalDate: "2026-10-01", graceDays: 7, currentState: "grace_period", today: new Date("2026-10-08T06:00:00Z") });
    const d9 = decideCadence({ renewalDate: "2026-10-01", graceDays: 7, currentState: "grace_period", today: new Date("2026-10-09T06:00:00Z") });
    expect(d8.shouldSuspend).toBe(false);
    expect(d9.shouldSuspend).toBe(true);
  });
});

describe("mails name the exact stop date", () => {
  const ctx: RenewalTemplateContext = {
    customerName: "Asha", tenantName: "Anutech", planName: "Business Starter", seats: 5,
    amount: 23823, renewalDate: "1 Oct 2026", daysUntil: 2, graceDays: 7, stopDate: "9 Oct 2026",
  };
  it("final notice", () => {
    const t = renderTemplate("final", { ...ctx, daysUntil: 0 });
    expect(t.body).toContain("Service stops on: 9 Oct 2026 (IST)");
    expect(t.body).not.toMatch(/suspended automatically/);
  });
  it("grace mail: subject and body carry the date, not a day count", () => {
    const t = renderTemplate("grace", ctx);
    expect(t.subject).toContain("service stops on 9 Oct 2026");
    expect(t.body).toContain("on 9 Oct 2026 (IST)");
  });
  it("grace mail without a stop date counts the days left correctly (was grace + days past)", () => {
    const t = renderTemplate("grace", { ...ctx, stopDate: undefined });
    expect(t.subject).toContain("suspends in 6 days"); // day 2 of 7 → stops on day 8 → 6 days
  });
  it("urgent mail names the date", () => {
    expect(renderTemplate("urgent", { ...ctx, daysUntil: 3 }).body).toContain("suspended on 9 Oct 2026");
  });
  it("no late fee is mentioned anywhere", () => {
    for (const tone of ["urgent", "final", "grace"] as const) {
      expect(renderTemplate(tone, ctx).body.toLowerCase()).not.toMatch(/late fee|interest|penalty/);
    }
  });
});

describe("isMissingColumn — code ahead of the migration", () => {
  it("reads Postgres / PostgREST undefined-column errors", () => {
    expect(isMissingColumn({ code: "42703", message: "column customers.trusted_grace_days does not exist" })).toBe(true);
    expect(isMissingColumn({ message: "column subscriptions.grace_until does not exist" })).toBe(true);
    expect(isMissingColumn({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});
