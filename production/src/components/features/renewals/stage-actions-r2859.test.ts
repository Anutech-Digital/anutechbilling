/**
 * R-2859 — a row the Bill together box suggests with others: its ONE button is Bill together, never its own
 * Bill next part / Send renewal next to the box (two ways, two proformas). withTogether decides which rows.
 */
import { describe, expect, it } from "vitest";
import { renewalStage, type PrimaryContext, type StageInput, type StageSub } from "@/lib/renewals/stage";
import { stageButtons, withTogether, STAGE_MENU_LABEL } from "./stage-actions";

const TODAY = "2026-11-14";
const yearly: StageSub = { status: "active", renewal_date: "2026-12-01", term_months: 12, billing_cycle: "yearly", start_date: "2025-12-01", auto_renew: true, renewal_quote_id: null };
/** Annual commitment billed quarterly; the part that started 12 Nov is not billed. */
const split: StageSub = { ...yearly, billing_cycle: "quarterly", renewal_date: "2026-11-12" };
const ctx: PrimaryContext = { role: "owner", canEndSubscription: true, tenantGraceDays: 0, offers: { followup: true, messaging: true }, vendorHold: "none" };
const all = { canQuotes: true, canPay: true, canInvoices: true };
const buttons = (sub: StageSub, rest: Partial<StageInput> = {}) => stageButtons(renewalStage({ sub, todayIst: TODAY, ...rest }), sub, ctx, all);

describe("R-2859 withTogether", () => {
  it("parts group, row's button is Bill next part → Bill together takes its place; Bill next part moves to ⋯ (first)", () => {
    const b = buttons(split);
    expect(b.primary?.kind).toBe("bill-part");
    expect(b.menu).not.toContain("bill-part");
    const t = withTogether(b, { kind: "parts" });
    expect(t.together).toEqual({ kind: "parts" });
    expect(t.menu[0]).toBe("bill-part");
    expect(t.menu.filter((m) => m === "bill-part")).toHaveLength(1);
    expect(t.menu.slice(1)).toEqual(b.menu);
  });

  it("yearly group, row's button is Send renewal → Bill together takes its place; Send renewal moves to ⋯ (first)", () => {
    const b = buttons(yearly);
    expect(b.primary?.kind).toBe("send-renewal");
    const t = withTogether(b, { kind: "renewal" });
    expect(t.together).toEqual({ kind: "renewal" });
    expect(t.menu).toEqual(["send-renewal", ...b.menu]);
    expect(STAGE_MENU_LABEL["send-renewal"]).toBe("Send renewal");
  });

  it("no suggestion for the row → nothing changes", () => {
    const b = buttons(split);
    expect(withTogether(b, null)).toEqual({ ...b, together: null });
    expect(withTogether(b, undefined).together).toBeNull();
  });

  it("only the button that bills THIS row alone is replaced — a sent part (Follow up / Record payment) and a draft (Continue) keep theirs", () => {
    const sent = buttons(split, { doc: { kind: "part", quoteId: "PI-1", status: "sent", dueDate: "2026-11-12", period: "12 Nov – 11 Feb" } });
    expect(sent.primary?.kind).not.toBe("bill-part");
    expect(withTogether(sent, { kind: "parts" })).toEqual({ ...sent, together: null });
    const draft = buttons(split, { doc: { kind: "part", quoteId: "Q-D", status: "draft", dueDate: "2026-11-12", period: "12 Nov – 11 Feb" } });
    expect(draft.primary?.kind).toBe("continue");
    expect(withTogether(draft, { kind: "parts" }).together).toBeNull();
    const invoiced = buttons(yearly, { invoice: { id: "INV-1", kind: "renewal", amountDue: 500 } });
    expect(withTogether(invoiced, { kind: "renewal" }).together).toBeNull();
  });

  it("the group's kind must match the row's own button — never a parts dialog from a Send renewal row or the other way", () => {
    expect(withTogether(buttons(split), { kind: "renewal" }).together).toBeNull();
    expect(withTogether(buttons(yearly), { kind: "parts" }).together).toBeNull();
  });

  it("a row with no button (Won't renew) never gets Bill together", () => {
    const off = { ...split, auto_renew: false };
    const b = buttons(off);
    expect(b.primary).toBeNull();
    expect(withTogether(b, { kind: "parts" }).together).toBeNull();
  });
});
