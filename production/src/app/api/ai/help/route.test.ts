/**
 * /api/ai/help — R-421: "kitne subscription chal rahe hai" gets the real number.
 * The model (mocked) first asks for active_subscriptions; the route reads them with the
 * person's own client and asks again with the results; the answer has the number and a link.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";

const db = vi.hoisted(() => ({
  role: "owner" as string,
  reads: [] as { table: string; filters: [string, unknown][] }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: `u-${Math.random()}` } } }) },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      db.reads.push({ table, filters });
      const rows = (): Record<string, unknown>[] => {
        if (table !== "subscriptions") return [];
        return [
          { tenant_id: TENANT, status: "active", renewal_date: "2027-05-01", mrr: 150000 },
          { tenant_id: TENANT, status: "active", renewal_date: "2027-06-01", mrr: 50000 },
          { tenant_id: TENANT, status: "expired", renewal_date: "2026-01-01", mrr: 9000 },
          { tenant_id: OTHER, status: "active", renewal_date: "2027-06-01", mrr: 7_777_777 },
        ].filter((r) => filters.every(([c, v]) => r[c as keyof typeof r] === v));
      };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
        in: () => q, is: () => q, not: () => q, lt: () => q, order: () => q, limit: () => q,
        range: () => q,
        maybeSingle: async () => ({ data: table === "users" ? { tenant_id: TENANT, full_name: "Pardeep", role: db.role } : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null, count: rows().length }).then(resolve),
      };
      return q;
    },
  }),
}));

const gem = vi.hoisted(() => ({ calls: [] as { system?: string; user: string }[], answers: [] as unknown[] }));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: "test-key-not-real", model: "m" }),
  geminiJson: async (args: { system?: string; user: string }) => {
    gem.calls.push({ system: args.system, user: args.user });
    return gem.answers.shift() ?? null;
  },
}));
vi.mock("@/lib/ai/help-facts", () => ({ helpFacts: async () => ({ text: "", customerIds: new Set() }) }));
vi.mock("@/lib/ai/page-test-runs", () => ({ loadLastPageTestRun: async () => null, testHistoryForPrompt: () => null }));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const ask = (text: string, mode = "chat") =>
  POST(new Request("https://example.invalid/api/ai/help", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: text ? [{ role: "user", text }] : [], pagePath: "/leads", mode }),
  }) as unknown as NextRequest);

beforeEach(() => {
  db.role = "owner";
  db.reads = [];
  gem.calls = [];
  gem.answers = [];
});

describe("POST /api/ai/help — data tools (R-421)", () => {
  it("model asks for active_subscriptions → route reads them (own tenant) → number + link", async () => {
    gem.answers = [
      { tools: ["active_subscriptions"] },
      { reply: "2 subscription chal rahe hain — MRR ₹2,00,000 mahina.", actions: [], checklist: [], followUps: [] },
    ];
    const res = await ask("kitne subscription chal rahe hai");
    const body = await res.json();
    expect(gem.calls).toHaveLength(2);
    expect(gem.calls[0].system).toContain("DATA TOOLS");
    expect(gem.calls[1].user).toContain("Active subscriptions: 2. MRR: ₹2,00,000 a month.");
    expect(gem.calls[1].user).not.toContain("77,77,777");
    expect(body.reply).toBe("2 subscription chal rahe hain — MRR ₹2,00,000 mahina.");
    expect(body.actions).toContainEqual({ kind: "open", label: "Open active subscriptions", href: "/subscriptions?focus=active" });
    const subReads = db.reads.filter((r) => r.table === "subscriptions");
    expect(subReads.length).toBeGreaterThan(0);
    for (const r of subReads) expect(r.filters).toContainEqual(["tenant_id", TENANT]);
  });

  it("second call fails → the numbers still come back, with the link", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    gem.answers = [{ tools: ["active_subscriptions"] }, null];
    const body = await (await ask("kitne subscription chal rahe hai")).json();
    expect(body.reply).toBe("Active subscriptions: 2. MRR: ₹2,00,000 a month.");
    expect(body.actions[0].href).toBe("/subscriptions?focus=active");
  });

  it("a role that cannot see subscriptions gets 'not allowed' and no subscription read", async () => {
    db.role = "sales";
    gem.answers = [{ tools: ["active_subscriptions"] }, { reply: "Aapke role ko ye number dekhne ki anumati nahi hai." }];
    const body = await (await ask("kitne subscription chal rahe hai")).json();
    expect(gem.calls[1].user).toContain("not allowed for your role");
    expect(db.reads.some((r) => r.table === "subscriptions")).toBe(false);
    expect(body.actions ?? []).toEqual([]);
  });

  it("how-to questions keep the old one-call behaviour", async () => {
    gem.answers = [{ reply: "'New Quote' dabaiye.", actions: [] }];
    const body = await (await ask("quote kaise banau")).json();
    expect(gem.calls).toHaveLength(1);
    expect(body.reply).toBe("'New Quote' dabaiye.");
  });

  it("scan mode does not offer tools", async () => {
    gem.answers = [{ reply: "Page theek hai.", checklist: ["a"] }];
    expect((await ask("", "scan")).status).toBe(200);
    expect(gem.calls[0]?.system ?? "").not.toContain("DATA TOOLS");
  });
});
