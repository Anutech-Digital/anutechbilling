/**
 * R-2401 — the shared renewal actions (Renewals card + Payment Follow-up): labels that say what
 * happens, which existing dialog "Customer not renewing" opens, and R-2232's one action per row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renewalActionSet, isGraceOver,
  SEND_RENEWAL_QUOTE, CREATE_QUOTE_NO_SEND, BILL_NEXT_PART, CUSTOMER_NOT_RENEWING, CANCEL_LABEL, RESEND_RENEWAL_QUOTE,
  type RenewalActionSub,
} from "./renewal-actions-rules";

const sub = (p: Partial<RenewalActionSub> = {}): RenewalActionSub => ({
  id: "s1", renewal_state: "grace_period", renewal_date: "2026-10-28", term_months: 12, status: "active",
  auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly", grace_until: null, ...p,
});
const OWNER = { tenantGraceDays: 15, canEndSubscription: true };

describe("R-2401 labels", () => {
  it("no quote yet: primary 'Send renewal quote' (send-now), secondary 'Create quote (don't send)' (generate)", () => {
    const a = renewalActionSet(sub(), null, { ...OWNER, daysUntil: -6 });
    expect(a.primary).toEqual({ kind: "send-now", label: SEND_RENEWAL_QUOTE });
    expect(a.secondary).toEqual({ kind: "generate", label: CREATE_QUOTE_NO_SEND });
    expect(SEND_RENEWAL_QUOTE).toBe("Send renewal quote");
    expect(CREATE_QUOTE_NO_SEND).toBe("Create quote (don't send)");
  });

  it("billed in parts: only 'Bill next part' (send-now refuses a whole-term quote, R-808)", () => {
    const a = renewalActionSet(sub({ billing_cycle: "monthly" }), null, { ...OWNER, daysUntil: -3 });
    expect(a.primary).toEqual({ kind: "generate", label: BILL_NEXT_PART });
    expect(a.secondary).toBeNull();
  });

  it("R-2232 kept: a draft quote → Send renewal quote only; a sent one → Resend; never a second Create", () => {
    const draft = renewalActionSet(sub({ renewal_quote_id: "Q-1" }), "draft", { ...OWNER, daysUntil: 3 });
    expect(draft.primary).toEqual({ kind: "send-now", label: SEND_RENEWAL_QUOTE });
    expect(draft.secondary).toBeNull();
    const sent = renewalActionSet(sub({ renewal_quote_id: "Q-1" }), "sent", { ...OWNER, daysUntil: 3 });
    expect(sent.primary).toEqual({ kind: "send-now", label: RESEND_RENEWAL_QUOTE });
    expect(sent.secondary).toBeNull();
  });

  it("renewed / Won't renew: nothing to send and no Customer not renewing", () => {
    const r = renewalActionSet(sub({ renewal_state: "renewed", renewal_date: "2027-10-28" }), null, { ...OWNER, daysUntil: 359 });
    expect([r.primary, r.secondary, r.notRenewing]).toEqual([null, null, null]);
    const w = renewalActionSet(sub({ auto_renew: false }), null, { ...OWNER, daysUntil: 3 });
    expect([w.primary, w.secondary, w.notRenewing]).toEqual([null, null, null]);
  });
});

describe("R-2401 'Customer not renewing' opens the right existing dialog", () => {
  it("before the renewal date → Won't renew (NonRenewingDialog)", () => {
    expect(renewalActionSet(sub({ renewal_date: "2026-11-10" }), null, { ...OWNER, daysUntil: 7 }).notRenewing)
      .toEqual({ label: CUSTOMER_NOT_RENEWING, dialog: "non-renewing" });
    expect(renewalActionSet(sub({ renewal_date: "2026-11-03" }), null, { ...OWNER, daysUntil: 0 }).notRenewing?.dialog)
      .toBe("non-renewing");
  });

  it("after the renewal date (expired, in grace) → Cancel subscription (CancelSubscriptionDialog)", () => {
    expect(renewalActionSet(sub(), null, { ...OWNER, daysUntil: -6 }).notRenewing)
      .toEqual({ label: CUSTOMER_NOT_RENEWING, dialog: "cancel" });
  });

  it("grace over → 'Cancel' (next to Renew anyway)", () => {
    const a = renewalActionSet(sub({ renewal_date: "2026-10-01" }), null, { ...OWNER, daysUntil: -33 });
    expect(a.graceOver).toBe(true);
    expect(a.notRenewing).toEqual({ label: CANCEL_LABEL, dialog: "cancel" });
  });

  it("roles that cannot cancel see no Customer not renewing", () => {
    expect(renewalActionSet(sub(), null, { daysUntil: -6, tenantGraceDays: 15, canEndSubscription: false }).notRenewing).toBeNull();
  });

  it("isGraceOver follows the owner's +N days (grace_until)", () => {
    expect(isGraceOver({ renewal_date: "2026-10-01", grace_until: null }, -33, 15)).toBe(true);
    expect(isGraceOver({ renewal_date: "2026-10-01", grace_until: "2026-11-10" }, -33, 15)).toBe(false);
    expect(isGraceOver({ renewal_date: "2026-10-28", grace_until: null }, -6, 15)).toBe(false);
  });
});

describe("R-2401 one component on both pages", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("Renewals and Payment Follow-up both render RenewalActions; the old Generate / Send now labels are gone", () => {
    const renewals = read("src/app/(app)/renewals/page.tsx");
    const collections = read("src/app/(app)/collections/page.tsx");
    expect(renewals).toMatch(/<RenewalActions\b/);
    expect(collections).toMatch(/<RenewalActions\b/);
    expect(renewals).not.toMatch(/>\s*Generate( quote)?\s*</);
    expect(renewals).not.toMatch(/"Send now"/);
  });
  it("the component reuses the existing dialogs and routes (no new money RPC)", () => {
    const src = read("src/components/features/renewals/renewal-actions.tsx");
    expect(src).toMatch(/NonRenewingDialog/);
    expect(src).toMatch(/CancelSubscriptionDialog/);
    expect(src).toMatch(/\/api\/renewals\/send-now/);
    expect(src).toMatch(/generate-renewal-quote/);
    expect(src).not.toMatch(/\.rpc\(/);
  });
});
