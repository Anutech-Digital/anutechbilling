/**
 * R-2232 (Zoho Billing audit A8, 31 Oct 2026): Renewals = end of commitment only.
 *
 * Owner's path on localhost (E2E Test Co): a FLEX subscription (1-month term, billed monthly —
 * "SCN Ads Gamma Studio", renewal 4 Nov) sat under "Urgent · Next 7 days — Call within 24 hours".
 * Its next month is a billing-schedule part (the renewals cron rolls the term, the billing job
 * raises the payment request — R-808 / R-2044), not a renewal to chase. And a row whose renewal
 * quote was already generated still offered Send now next to "Open quote"; a Renewed row still
 * showed (disabled) Generate / Send now.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyRenewals, isFlexNextPart, type ClassifyRow } from "./classify";
import { bulkReminderTargets } from "./reminders";
import { renewalRowAction } from "./row-action";
import { renewalForecast } from "@/lib/renewals/forecast";
import type { Subscription } from "@/lib/supabase/database.types";

const TODAY = new Date("2026-11-01T06:30:00Z"); // 12:00 IST

type Sub = {
  id: string; customer_name: string; renewal_state: string | null; renewal_date: string | null;
  term_months: number; billing_cycle: string | null; status: string; mrr: number; auto_renew?: boolean | null;
};
const row = (id: string, daysUntil: number, over: Partial<Sub> = {}): ClassifyRow<Sub> => ({
  daysUntil,
  sub: {
    id, customer_name: id, renewal_state: "pending", renewal_date: "2026-11-04", term_months: 12,
    billing_cycle: null, status: "active", mrr: 1000, ...over,
  },
});

describe("R-2232: a flex sub's next month is a billing part, not a renewal row", () => {
  const flex = row("flex-gamma", 3, { term_months: 1, billing_cycle: "monthly", renewal_date: "2026-11-04" });
  const flexLater = row("flex-later", 20, { term_months: 1, billing_cycle: "monthly", renewal_date: "2026-11-21" });
  const annualPaidMonthly = row("annual-monthly", 3, { term_months: 12, billing_cycle: "monthly" });
  const annual = row("annual", 3, { term_months: 12, billing_cycle: "yearly" });
  const flexBehind = row("flex-behind", -2, { term_months: 1, billing_cycle: "monthly", renewal_date: "2026-10-30" });

  const g = classifyRenewals([flex, flexLater, annualPaidMonthly, annual, flexBehind], () => true, TODAY);

  it("not in Urgent / Next 7 days / Upcoming / At risk", () => {
    expect(g.due7.map((r) => r.sub.id)).toEqual(["annual-monthly", "annual"]);
    expect(g.upcoming).toEqual([]);
    expect(g.urgentTab.map((r) => r.sub.id)).not.toContain("flex-gamma");
    expect(g.atRisk.map((r) => r.sub.id)).not.toContain("flex-gamma");
    expect(g.atRisk.map((r) => r.sub.id)).not.toContain("flex-later");
  });

  it("counted apart as billing parts (so the page can say where they went)", () => {
    expect(g.flexParts.map((r) => r.sub.id)).toEqual(["flex-gamma", "flex-later"]);
  });

  it("a flex sub whose part date has PASSED unbilled stays visible (Generate bills it — R-2095)", () => {
    expect(g.expired.map((r) => r.sub.id)).toEqual(["flex-behind"]);
  });

  it("end of commitment still listed: annual term (paid monthly or yearly)", () => {
    expect(isFlexNextPart(annualPaidMonthly.sub, 3)).toBe(false);
    expect(isFlexNextPart(annual.sub, 3)).toBe(false);
    expect(isFlexNextPart(flex.sub, 3)).toBe(true);
    /* A 1-month term NOT billed in parts renews by a renewal quote — it stays a renewal row. */
    expect(isFlexNextPart({ term_months: 1, billing_cycle: null }, 3)).toBe(false);
  });

  it("Bulk reminder does not email a flex part", () => {
    const targets = bulkReminderTargets([flex, annual], TODAY);
    expect(targets.map((r) => r.sub.id)).toEqual(["annual"]);
  });

  it("forecast: flex is run-rate, never a renewal count", () => {
    const subs = [flex.sub, annual.sub].map((s) => ({ ...s, renewal_date: "2026-11-04" })) as unknown as Subscription[];
    const f = renewalForecast(subs, "2026-11-01");
    expect(f.totalCount).toBe(1);
    expect(f.flexCount).toBe(1);
  });
});

describe("R-2232: one action per row — no second Generate, nothing on a Renewed row", () => {
  const base = {
    renewal_state: "notice_sent", renewal_date: "2026-11-20", term_months: 12, auto_renew: true, status: "active",
  };

  it("renewal quote sent → 'Renewal sent Q-x · due <date>' and only Resend", () => {
    const a = renewalRowAction({ ...base, renewal_quote_id: "Q-F588-27-0013" }, "sent");
    expect(a).toEqual({ kind: "resend", label: "Resend", text: "Renewal sent Q-F588-27-0013 · due 20 Nov 2026", quoteId: "Q-F588-27-0013" });
  });

  it("viewed / accepted-awaiting-payment are sent too", () => {
    expect(renewalRowAction({ ...base, renewal_quote_id: "Q-1" }, "viewed").kind).toBe("resend");
    expect(renewalRowAction({ ...base, renewal_quote_id: "Q-1" }, "accepted").kind).toBe("resend");
  });

  it("generated but never sent (draft) → 'not sent yet' and only Send — never Generate", () => {
    const a = renewalRowAction({ ...base, renewal_quote_id: "Q-2" }, "draft");
    expect(a).toEqual({ kind: "send", label: "Send", text: "Renewal quote Q-2 not sent yet · due 20 Nov 2026", quoteId: "Q-2" });
  });

  it("linked quote whose status is not loaded yet still never offers Generate", () => {
    expect(renewalRowAction({ ...base, renewal_quote_id: "Q-3" }, null).kind).toBe("resend");
  });

  it("no quote yet → Generate (and Send now)", () => {
    expect(renewalRowAction({ ...base, renewal_quote_id: null }, null).kind).toBe("generate");
  });

  it("Renewed (paid, next term not open yet) → no Generate, no Send now", () => {
    const a = renewalRowAction({ ...base, renewal_state: "renewed", renewal_date: "2027-10-31", renewal_quote_id: null }, null);
    expect(a).toEqual({ kind: "none", label: null, text: "Renewed — nothing to send", quoteId: null });
  });

  it("Won't renew → nothing to send (R-2225 kept)", () => {
    expect(renewalRowAction({ ...base, auto_renew: false, renewal_quote_id: null }, null).kind).toBe("none");
  });
});

describe("R-2232: the page wires the one rule", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/renewals/page.tsx"), "utf8");
  it("both layouts read renewalRowAction; no disabled Generate/Send now on a settled row", () => {
    expect(src.match(/renewalRowAction\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/disabled=\{isNonRenewing\(sub\) \|\| isTerminalRenewal/);
  });
  it("the sidebar badge leaves out a flex part (nav_badges SQL)", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".sql")).sort();
    const hit = files.filter((f: string) => /function\s+public\.nav_badges\s*\(/i.test(readFileSync(join(dir, f), "utf8"))).pop()!;
    const sql = readFileSync(join(dir, hit), "utf8");
    const line = sql.match(/^\s*'renewals',\s*(.*)$/m)?.[1] ?? "";
    expect(line).toMatch(/not \(coalesce\(s\.term_months, 12\) <= 1 and s\.billing_cycle in \('monthly', 'quarterly', 'half_yearly'\) and s\.renewal_date >= v_today\)/);
  });
});
