/**
 * R-2422 — Pardeep, 3 Nov (staging Renewals): six stacked buttons (Send renewal quote, Create
 * quote, Customer not renewing, Follow-up, Nudge, Voice) made each row ~170px — ~4 rows a screen.
 * Now ONE next-step button (the R-2401 rule picks it; Follow-up when nothing is left to send) and
 * a ⋯ menu for the rest — the same pattern as Payment Follow-up's rows (R-2408).
 */
import { describe, it, expect } from "vitest";
import {
  renewalActionSet, renewalNextStep,
  SEND_RENEWAL_QUOTE, BILL_NEXT_PART, RESEND_RENEWAL_QUOTE, FOLLOW_UP,
  type RenewalActionSub,
} from "./renewal-actions-rules";

const sub = (p: Partial<RenewalActionSub> = {}): RenewalActionSub => ({
  id: "s1", renewal_state: "notice_sent", renewal_date: "2026-11-20", term_months: 12, status: "active",
  auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly", grace_until: null, ...p,
});
const OWNER = { tenantGraceDays: 15, canEndSubscription: true };
const RENEWALS = { followup: true, messaging: true };

describe("R-2422 renewalNextStep — one button + ⋯", () => {
  it("no quote yet: button Send renewal quote; ⋯ = Create quote (don't send), Follow-up, Nudge, Voice, Customer not renewing", () => {
    const s = renewalNextStep(renewalActionSet(sub(), null, { ...OWNER, daysUntil: 17 }), RENEWALS);
    expect(s.button).toEqual({ kind: "send-now", label: SEND_RENEWAL_QUOTE });
    expect(s.menu).toEqual(["create-quote", "followup", "nudge", "voice", "not-renewing"]);
  });

  it("billed in parts: button Bill next part; no Create quote in ⋯", () => {
    const s = renewalNextStep(renewalActionSet(sub({ billing_cycle: "quarterly" }), null, { ...OWNER, daysUntil: 5 }), RENEWALS);
    expect(s.button).toEqual({ kind: "generate", label: BILL_NEXT_PART });
    expect(s.menu).toEqual(["followup", "nudge", "voice", "not-renewing"]);
  });

  it("quote already sent: button Resend renewal quote", () => {
    const s = renewalNextStep(renewalActionSet(sub({ renewal_quote_id: "Q-1" }), "sent", { ...OWNER, daysUntil: 3 }), RENEWALS);
    expect(s.button?.label).toBe(RESEND_RENEWAL_QUOTE);
  });

  it("nothing left to send (Won't renew / renewed): the button is Follow-up, never an empty cell", () => {
    const set = renewalActionSet(sub({ auto_renew: false }), null, { ...OWNER, daysUntil: 17 });
    expect(set.primary).toBeNull();
    const s = renewalNextStep(set, RENEWALS);
    expect(s.button).toEqual({ kind: "followup", label: FOLLOW_UP });
    expect(s.menu).not.toContain("followup");
  });

  it("grace over: Customer not renewing stays OUT of ⋯ — Renew anyway + Cancel sit side by side (R-2401)", () => {
    const set = renewalActionSet(sub({ renewal_state: "grace_period", renewal_date: "2026-10-01" }), null, { ...OWNER, daysUntil: -33 });
    expect(set.graceOver).toBe(true);
    expect(renewalNextStep(set, RENEWALS).menu).not.toContain("not-renewing");
  });

  it("Payment Follow-up (no follow-up / messaging hooks): ⋯ only has the renewal's own actions", () => {
    const s = renewalNextStep(renewalActionSet(sub(), null, { ...OWNER, daysUntil: -3 }), { followup: false, messaging: false });
    expect(s.button?.label).toBe(SEND_RENEWAL_QUOTE);
    expect(s.menu).toEqual(["create-quote", "not-renewing"]);
  });

  it("monthly flex before its date: no Bill next part (the billing job raises that part on its date) — the button is Follow-up", () => {
    const flex = sub({ term_months: 1, billing_cycle: "monthly", renewal_date: "2026-11-08" });
    const set = renewalActionSet(flex, null, { ...OWNER, daysUntil: 5 });
    expect(set.primary).toBeNull();
    expect(renewalNextStep(set, RENEWALS).button).toEqual({ kind: "followup", label: FOLLOW_UP });
  });

  it("monthly flex whose date PASSED unbilled: Bill next part (R-2095 kept)", () => {
    const flex = sub({ term_months: 1, billing_cycle: "monthly", renewal_date: "2026-10-30", renewal_state: "grace_period" });
    expect(renewalActionSet(flex, null, { ...OWNER, daysUntil: -2 }).primary).toEqual({ kind: "generate", label: BILL_NEXT_PART });
  });

  it("a role that may not end subscriptions sees no Customer not renewing", () => {
    const s = renewalNextStep(renewalActionSet(sub(), null, { ...OWNER, canEndSubscription: false, daysUntil: 10 }), RENEWALS);
    expect(s.menu).not.toContain("not-renewing");
  });
});
