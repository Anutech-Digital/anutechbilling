/**
 * R-2758 (R-2739a): the row's ONE button + ⋯ from the stage, narrowed to what the person may open.
 */
import { describe, expect, it } from "vitest";
import { renewalStage, type PrimaryContext, type StageInput } from "@/lib/renewals/stage";
import { stageButtons } from "./stage-actions";

const TODAY = "2026-11-14";
const sub = { status: "active", renewal_date: "2026-12-01", term_months: 12, billing_cycle: "yearly", start_date: "2025-12-01", auto_renew: true, renewal_quote_id: null as string | null };
const ctx = (o: Partial<PrimaryContext> = {}): PrimaryContext => ({
  role: "owner", canEndSubscription: true, tenantGraceDays: 0, offers: { followup: true, messaging: true }, vendorHold: "none", ...o,
});
const all = { canQuotes: true, canPay: true, canInvoices: true };
const stageOf = (i: Partial<StageInput>) => renewalStage({ sub, todayIst: TODAY, ...i });

describe("R-2758 stageButtons", () => {
  it("due whole term → ONE Send renewal button; Send as is + Customer not renewing in ⋯", () => {
    const b = stageButtons(stageOf({}), sub, ctx(), all);
    expect(b.primary?.label).toBe("Send renewal");
    expect(b.menu).toContain("send-as-is");
    expect(b.menu).toContain("not-renewing");
    expect(b.menu).not.toContain("follow-up" === b.primary?.kind ? "follow-up" : "x");
  });

  it("invoiced → Record payment; without money rights it is Follow up, and Record payment leaves ⋯", () => {
    const s = stageOf({ invoice: { id: "INV-1", kind: "renewal", amountDue: 500 } });
    expect(stageButtons(s, sub, ctx(), all).primary?.label).toBe("Record payment");
    const b = stageButtons(s, sub, ctx({ role: "support" }), { ...all, canPay: false });
    expect(b.primary?.label).toBe("Follow up");
    expect(b.menu).not.toContain("record-payment");
    expect(b.menu).not.toContain("follow-up");
  });

  it("resend invoice only for people who can open invoices", () => {
    const s = stageOf({ invoice: { id: "INV-1", kind: "renewal", amountDue: 500 } });
    expect(stageButtons(s, sub, ctx(), all).menu).toContain("resend-invoice");
    expect(stageButtons(s, sub, ctx(), { ...all, canInvoices: false }).menu).not.toContain("resend-invoice");
  });

  it("quote-closed whole-term row: ⋯ Open the closed quote (no dead end), never a second Send renewal", () => {
    const s = stageOf({ sub: { ...sub, renewal_quote_id: "Q-9" }, doc: { kind: "renewal", quoteId: "Q-9", status: "expired" } });
    expect(s.key).toBe("quote-closed");
    const b = stageButtons(s, { ...sub, renewal_quote_id: "Q-9" }, ctx(), all);
    expect(b.menu[0]).toBe("open-quote");
    expect(b.primary?.kind).not.toBe("send-renewal");
    expect(stageButtons(s, sub, ctx(), { ...all, canQuotes: false }).menu).not.toContain("open-quote");
  });

  it("Won't renew → no button, ⋯ Undo Won't renew", () => {
    const s = stageOf({ sub: { ...sub, auto_renew: false } });
    const b = stageButtons(s, { ...sub, auto_renew: false }, ctx(), all);
    expect(b.primary).toBeNull();
    expect(b.menu).toEqual(["undo-wont-renew"]);
  });

  it("grace over + vendor hold (owner) → Renew anyway is in ⋯, not a second button", () => {
    const late = { ...sub, renewal_date: "2026-11-01" };
    const s = renewalStage({ sub: late, todayIst: TODAY });
    const b = stageButtons(s, late, ctx({ vendorHold: "hold" }), all);
    expect(b.graceOver).toBe(true);
    expect(b.menu).toContain("renew-anyway");
    expect(b.primary?.label).toBe("Send renewal");
  });
});
