/**
 * R-2852 — a renewal quote billed together is reminded about ONCE per step, from its lead member,
 * and the mail lists every plan · seats · period and the quote's own total (rev-r2849 A / M1).
 */
import { describe, it, expect, vi } from "vitest";
import { togetherLead, togetherRole, togetherPlanLines, togetherTemplateFields, togetherMemberPeriod, type TogetherQuote } from "./together-reminder";
import { readTogetherQuotes, type TogetherReadClient } from "./together-reminder.server";
import { renderTemplate } from "./templates";

const standard = { subscriptionId: "bbbb", renewalTermDate: "2027-01-01", extensionMonths: 12, lineNo: 1, seats: 20, plan: "Business Standard", startDate: "2026-01-01", termMonths: 12 };
const starter  = { subscriptionId: "aaaa", renewalTermDate: "2027-01-15", extensionMonths: 12, lineNo: 2, seats: 10, plan: "Business Starter",  startDate: "2026-01-15", termMonths: 12 };
const quote: TogetherQuote = { quoteId: "Q-T1", members: [standard, starter] };
const map = new Map([["Q-T1", quote]]);

describe("R-2852 lead member", () => {
  it("earliest renewal term leads; same term → lowest subscription id", () => {
    expect(togetherLead(quote)?.subscriptionId).toBe("bbbb");
    const same = { ...quote, members: [{ ...standard, renewalTermDate: "2027-01-15" }, starter] };
    expect(togetherLead(same)?.subscriptionId).toBe("aaaa");
  });

  it("a lead the run may not remind (Won't renew / not active) hands over to the next — never nobody", () => {
    expect(togetherLead(quote, (id) => id !== "bbbb")?.subscriptionId).toBe("aaaa");
    expect(togetherLead(quote, () => false)).toBeNull();
  });

  it("role: lead sends, other member skips with the quote and the lead named; single / stale link unchanged", () => {
    expect(togetherRole("bbbb", "Q-T1", map)).toMatchObject({ kind: "lead" });
    const m = togetherRole("aaaa", "Q-T1", map);
    expect(m).toMatchObject({ kind: "member", leadId: "bbbb" });
    expect(m.kind === "member" && m.reason).toMatch(/Billed together on renewal quote Q-T1 — its reminder goes once, with Business Standard/);
    expect(togetherRole("aaaa", "Q-SINGLE", map)).toEqual({ kind: "single" });
    expect(togetherRole("aaaa", null, map)).toEqual({ kind: "single" });
    expect(togetherRole("cccc", "Q-T1", map)).toEqual({ kind: "single" });   // not a member (stale link)
    // lead not eligible → the other member is the lead
    expect(togetherRole("aaaa", "Q-T1", map, (id) => id !== "bbbb")).toMatchObject({ kind: "lead" });
  });
});

describe("R-2852 plan list", () => {
  it("each member's own next term: anniversary rows start on renewal date, inclusive (last-day) rows the day after", () => {
    expect(togetherMemberPeriod(standard)).toEqual({ from: "2027-01-01", to: "2027-12-31" });
    const lastDay = { ...starter, startDate: "2026-01-16", renewalTermDate: "2027-01-15" };
    expect(togetherMemberPeriod(lastDay)).toEqual({ from: "2027-01-16", to: "2028-01-15" });
    expect(togetherMemberPeriod({ ...standard, renewalTermDate: "" })).toBeNull();
  });

  it("one line per plan in quote line order: plan · seats · period", () => {
    expect(togetherPlanLines({ ...quote, members: [starter, standard] })).toEqual([
      "Business Standard · 20 seats · 1 Jan 2027 to 31 Dec 2027",
      "Business Starter · 10 seats · 15 Jan 2027 to 14 Jan 2028",
    ]);
    expect(togetherTemplateFields(quote)).toMatchObject({ planName: "Business Standard + Business Starter", seats: 30 });
  });

  it("the mail lists every plan and the quote total — the total is never printed against one plan", () => {
    const f = togetherTemplateFields(quote);
    const base = { customerName: "Ravi", tenantName: "Anutech", planName: f.planName, seats: f.seats, amount: 410640,
      renewalDate: "1 Jan 2027", daysUntil: 15, graceDays: 7, planLines: f.planLines };
    for (const tone of ["soft", "friendly", "firm", "urgent", "final", "grace"] as const) {
      const t = renderTemplate(tone, base);
      expect(t.body).toContain("This renewal quote covers:\n  • Business Standard · 20 seats · 1 Jan 2027 to 31 Dec 2027\n  • Business Starter · 10 seats · 15 Jan 2027 to 14 Jan 2028");
      expect(t.body).toContain("Total for all of them: ₹4,10,640 (one quote, one payment)");
      expect(t.body).not.toMatch(/your Business Standard subscription/);
      // the list comes before the first amount line
      expect(t.body.indexOf("This renewal quote covers:")).toBeLessThan(t.body.indexOf("₹4,10,640"));
    }
    const early = renderTemplate("early", base);
    expect(early.body).toContain("This renewal quote covers:");
    expect(early.body).not.toContain("₹");
  });

  it("a single renewal quote's mail is exactly as before (no list)", () => {
    const ctx = { customerName: "Ravi", tenantName: "Anutech", planName: "Business Starter", seats: 10, amount: 1000,
      renewalDate: "1 Jan 2027", daysUntil: 15, graceDays: 7 };
    expect(renderTemplate("soft", { ...ctx, planLines: [] })).toEqual(renderTemplate("soft", ctx));
    expect(renderTemplate("soft", { ...ctx, planLines: ["one"] })).toEqual(renderTemplate("soft", ctx));
    expect(renderTemplate("soft", ctx).body).not.toContain("This renewal quote covers");
  });
});

function fakeClient(tables: { links?: unknown[]; linkError?: { code?: string; message: string }; subs?: unknown[] }) {
  const calls: { table: string; filters: unknown[] }[] = [];
  const from = vi.fn((table: string) => ({
    select: () => ({
      in: (col: string, vals: string[]) => {
        const call = { table, filters: [["in", col, vals]] as unknown[] };
        calls.push(call);
        const res = () => table === "renewal_quote_subscriptions"
          ? { data: tables.linkError ? null : tables.links ?? [], error: tables.linkError ?? null }
          : { data: tables.subs ?? [], error: null };
        const p = Promise.resolve().then(res);
        return Object.assign(p, { is: (c: string, v: null) => { call.filters.push(["is", c, v]); return Promise.resolve().then(res); } });
      },
    }),
  }));
  return { client: { from } as unknown as TogetherReadClient, calls };
}

describe("R-2852 readTogetherQuotes", () => {
  const link = (q: string, s: string, n: number) => ({ quote_id: q, subscription_id: s, renewal_term_date: "2027-01-01", extension_months: 12, line_no: n, seats: 5 });

  it("only live rows (released_at null) and only quotes with 2+ members are together", async () => {
    const { client, calls } = fakeClient({
      links: [link("Q-T1", "s1", 1), link("Q-T1", "s2", 2), link("Q-ONE", "s3", 1)],
      subs: [{ id: "s1", plan: "Standard", seats: 9, start_date: null, term_months: 12 }, { id: "s2", plan: "Starter", seats: 4, start_date: null, term_months: 12 }],
    });
    const m = await readTogetherQuotes(client, ["Q-T1", "Q-ONE", null, "Q-T1"]);
    expect([...m.keys()]).toEqual(["Q-T1"]);
    expect(m.get("Q-T1")!.members.map((x) => [x.subscriptionId, x.plan, x.seats])).toEqual([["s1", "Standard", 5], ["s2", "Starter", 5]]);
    expect(calls[0].filters).toContainEqual(["is", "released_at", null]);
    expect(calls[0].filters).toContainEqual(["in", "quote_id", ["Q-T1", "Q-ONE"]]);
  });

  it("no quote ids → no read; table missing on an older database → no together quotes, no error", async () => {
    const none = fakeClient({});
    expect((await readTogetherQuotes(none.client, [])).size).toBe(0);
    expect(none.calls).toHaveLength(0);
    for (const code of ["42P01", "PGRST205"]) {
      const { client } = fakeClient({ linkError: { code, message: "missing" } });
      expect((await readTogetherQuotes(client, ["Q-T1"])).size).toBe(0);
    }
  });

  it("any other read failure is thrown — never guessed as single (that would email the quote once per member)", async () => {
    const { client } = fakeClient({ linkError: { code: "57014", message: "timeout" } });
    await expect(readTogetherQuotes(client, ["Q-T1"])).rejects.toThrow(/renewal_quote_subscriptions: timeout/);
  });
});
