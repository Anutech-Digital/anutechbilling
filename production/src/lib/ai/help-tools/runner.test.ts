/**
 * R-2774 / H-01 — Help AI tool registry + runner contract.
 * Session: only openHelpSession() (cookie client), never a service-role key, never a forged object.
 * Reader: tenant filter on every query, allowlisted tables, no secret columns, no writes.
 * Runner: role fail-closed, tier, strict input, output shape, row cap, sources, timeout.
 * Parity: the 6 R-421 tools give the same text through the registry as through the old path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-07T04:30:00Z");

/** A JWT-shaped key with this role claim (not a real key). */
const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;

function fakeClient(tables: Record<string, Row[]>, key = jwt("anon")) {
  const log: { table: string; columns: string; filters: Filter[] }[] = [];
  const client = {
    supabaseKey: key,
    rpc: vi.fn(),
    from(table: string) {
      const filters: Filter[] = [];
      let head = false;
      let lim: number | null = null;
      let range: [number, number] | null = null;
      const entry = { table, columns: "", filters };
      log.push(entry);
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every(([op, c, v]) => {
          const x = r[c];
          if (op === "eq") return x === v;
          if (op === "in") return (v as unknown[]).includes(x);
          if (op === "is") return x == null;
          if (op === "lt") return x != null && (x as string) < (v as string);
          if (op === "notin") return !(v as unknown[]).includes(x);
          return true;
        }));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (lim != null) rows = rows.slice(0, lim);
        return { data: head ? null : rows, error: null, count: rows.length };
      };
      const q: Record<string, unknown> = {
        select(c: string, o?: { head?: boolean }) { entry.columns = c; head = !!o?.head; return q; },
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return q; },
        in(c: string, v: unknown[]) { filters.push(["in", c, v]); return q; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return q; },
        lt(c: string, v: unknown) { filters.push(["lt", c, v]); return q; },
        not(c: string, op: string, v: string) { if (op === "in") filters.push(["notin", c, v.replace(/[()]/g, "").split(",")]); return q; },
        order() { return q; },
        range(f: number, t: number) { range = [f, t]; return q; },
        limit(n: number) { lim = n; return q; },
        update: vi.fn(() => q), delete: vi.fn(() => q), insert: vi.fn(() => q),
        then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return q;
    },
  };
  return { client, log };
}

let current: ReturnType<typeof fakeClient>["client"] | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => current,
  createAdminClient: () => { throw new Error("admin client must never be called from help tools"); },
}));

const { openHelpSession, sessionClient, keyRole, HelpSessionRefused } = await import("./session");
const { runHelpTools, HELP_CALLS_MAX } = await import("./runner");
const { scopedReader, HelpReadRefused, HELP_READ_TABLES, HELP_NEVER_TABLES } = await import("./reader");
const { defineHelpTool } = await import("./types");
const { buildRegistry, HELP_TOOL_REGISTRY, helpToolsFor, helpAiV2Enabled } = await import("./registry");
const { runHelpDataTools, runHelpDataToolsV2, HELP_DATA_TOOL_NAMES } = await import("../help-data-tools");

function session(tables: Record<string, Row[]>, key?: string) {
  const f = fakeClient(tables, key);
  current = f.client;
  return { s: openHelpSession(), log: f.log, client: f.client };
}

beforeEach(() => { current = null; vi.unstubAllEnvs(); });

const subs: Row[] = [
  { id: "s1", tenant_id: A, customer_name: "Acme", plan: "P", status: "active", renewal_date: "2026-10-10", mrr: 100000 },
  { id: "s2", tenant_id: A, customer_name: "Bolt", plan: "Q", status: "active", renewal_date: "2027-03-01", mrr: 250000 },
  { id: "s9", tenant_id: B, customer_name: "OtherCo", plan: "X", status: "active", renewal_date: "2026-10-08", mrr: 9_999_999 },
];

describe("session: own login only", () => {
  it("openHelpSession uses the cookie client; the runner reads through it", async () => {
    const { s, log } = session({ subscriptions: subs });
    const [r] = await runHelpTools(s, { tenantId: A, role: "owner", now: NOW }, [{ name: "active_subscriptions" }]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Active subscriptions: 2. MRR: ₹3,50,000 a month.");
    expect(log.length).toBeGreaterThan(0);
  });

  it("refuses a service-role or sb_secret key — the session is never made", () => {
    current = fakeClient({}, jwt("service_role")).client;
    expect(() => openHelpSession()).toThrow(HelpSessionRefused);
    current = fakeClient({}, "sb_secret_abc").client;
    expect(() => openHelpSession()).toThrow(HelpSessionRefused);
    expect(keyRole(jwt("authenticated"))).toBe("authenticated");
    expect(keyRole("garbage")).toBeNull();
  });

  it("a session object not made by openHelpSession is refused before any read", async () => {
    const forged = Object.freeze(Object.create(null)) as Parameters<typeof runHelpTools>[0];
    await expect(runHelpTools(forged, { tenantId: A, role: "owner" }, [{ name: "active_subscriptions" }])).rejects.toThrow(HelpSessionRefused);
    const client = fakeClient({}).client;
    await expect(runHelpTools(client as never, { tenantId: A, role: "owner" }, [{ name: "active_subscriptions" }])).rejects.toThrow(HelpSessionRefused);
    expect(() => sessionClient({} as never)).toThrow(HelpSessionRefused);
  });

  it("no tenant → nothing runs", async () => {
    const { s, log } = session({ subscriptions: subs });
    await expect(runHelpTools(s, { tenantId: "", role: "owner" }, [{ name: "active_subscriptions" }])).rejects.toThrow(HelpReadRefused);
    expect(log).toHaveLength(0);
  });
});

describe("reader: tenant, tables, secret columns, read-only", () => {
  const db = (tables: Record<string, Row[]> = {}) => { const f = fakeClient(tables); return { db: scopedReader(f.client as never, A), log: f.log }; };

  it("every query carries tenant_id = this company; another tenant's rows never come back", async () => {
    const { db: r, log } = db({ subscriptions: subs });
    const res = await r.read<{ customer_name: string }>("subscriptions", "customer_name");
    expect(res.data?.map((x) => x.customer_name)).toEqual(["Acme", "Bolt"]);
    expect(log[0].filters[0]).toEqual(["eq", "tenant_id", A]);
  });

  it("refuses tables outside the allowlist and credential tables", () => {
    const { db: r } = db();
    for (const t of ["tenant_secrets", "vault_passwords", "api_keys", "users", "employees"]) {
      expect(() => r.read(t as never, "id")).toThrow(HelpReadRefused);
    }
    for (const t of HELP_READ_TABLES) expect(HELP_NEVER_TABLES).not.toContain(t);
  });

  it("refuses *, joins, aliases, casts and secret-looking columns", () => {
    const { db: r } = db();
    for (const cols of ["*", "id, customers(*)", "x:id", "id::text", "public_token", "id, api_key", "", "id,,plan"]) {
      expect(() => r.read("quotes", cols), cols).toThrow(HelpReadRefused);
    }
    expect(() => r.read("invoices", "id, amount")).not.toThrow();
  });

  it("the query has no write / rpc / select methods at runtime", () => {
    const { db: r } = db();
    const q = r.read("leads", "id") as unknown as Record<string, unknown>;
    for (const m of ["update", "delete", "insert", "upsert", "select", "rpc", "csv"]) expect(q[m], m).toBeUndefined();
    expect(typeof q.eq).toBe("function");
    expect(typeof (q.eq as (c: string, v: unknown) => Record<string, unknown>)("x", 1).update).toBe("undefined");
  });
});

describe("runner rules", () => {
  it("role fail-closed: unknown/none/non-owner role → not allowed, nothing read", async () => {
    for (const role of [null, undefined, "hacker", "sales", "manager", "accountant"]) {
      const { s, log } = session({ subscriptions: subs });
      const [r] = await runHelpTools(s, { tenantId: A, role }, [{ name: "active_subscriptions" }]);
      expect(r.ok, String(role)).toBe(false);
      expect(r.refusal).toBe("not_allowed");
      expect(log).toHaveLength(0);
    }
    expect(helpToolsFor("owner").map((t) => t.name)).toEqual([...HELP_DATA_TOOL_NAMES]);
    expect(helpToolsFor("hacker")).toEqual([]);
  });

  it("unknown tool, extra input keys, wrong types → refused, nothing read", async () => {
    const { s, log } = session({ subscriptions: subs });
    const res = await runHelpTools(s, { tenantId: A, role: "owner" }, [
      { name: "drop_table" },
      { name: "active_subscriptions", input: { tenant_id: B } },
      { name: "active_subscriptions", input: "x" },
    ]);
    expect(res.map((r) => r.refusal)).toEqual(["unknown_tool", "bad_input", "bad_input"]);
    expect(log).toHaveLength(0);
  });

  const tool = (over: Record<string, unknown> = {}) => defineHelpTool({
    name: "test_rows", describe: "t", input: z.object({ n: z.number().int().max(1000) }).strict(),
    roles: ["owner"], tier: "read", page: "/invoices", label: "Open invoices",
    async run({ n }: { n: number }) {
      const rows = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, amount: i }));
      return { text: `${n} rows`, rows, total: n, sources: [] };
    },
    ...over,
  } as never);

  it("rows are cut to the cap with 'showing N of M'; a source ref is always there", async () => {
    const { s } = session({});
    const reg = buildRegistry([tool(), tool({ name: "test_rows_cap5", maxRows: 5 })]);
    const [a, b, c] = await runHelpTools(s, { tenantId: A, role: "owner" }, [
      { name: "test_rows", input: { n: 120 } }, { name: "test_rows_cap5", input: { n: 9 } }, { name: "test_rows", input: { n: 3 } },
    ], reg);
    expect(a.rows).toHaveLength(50);
    expect(a.shown).toEqual({ shown: 50, total: 120 });
    expect(a.text).toContain("(showing 50 of 120)");
    expect(b.rows).toHaveLength(5);
    expect(c.shown).toBeUndefined();
    for (const r of [a, b, c]) expect(r.sources).toEqual([{ table: null, ids: [], href: "/invoices", label: "Open invoices" }]);
  });

  it("registration refuses tier never, loose input, no/unknown roles, bad page, cap > 200", () => {
    expect(() => tool({ tier: "never" })).toThrow(/tier/);
    expect(() => tool({ input: z.object({ n: z.number() }) })).toThrow(/strict/);
    expect(() => tool({ roles: [] })).toThrow(/roles/);
    expect(() => tool({ roles: ["god"] })).toThrow(/roles/);
    expect(() => tool({ page: "https://evil.example" })).toThrow(/page/);
    expect(() => tool({ maxRows: 500 })).toThrow(/maxRows/);
    expect(() => buildRegistry([tool(), tool()])).toThrow(/twice/);
  });

  it("safe / confirm tiers do not run yet; a bad output shape, a throw and a timeout are refused results", async () => {
    const { s } = session({});
    const runSpy = vi.fn(async () => ({ text: "x", sources: [] }));
    const reg = buildRegistry([
      tool({ name: "t_confirm", tier: "confirm", run: runSpy }),
      tool({ name: "t_safe", tier: "safe", run: runSpy }),
      tool({ name: "t_bad", run: async () => ({ text: "x", sources: [], secret: "leak" }) }),
      tool({ name: "t_throw", run: async () => { throw new Error("db down"); } }),
      tool({ name: "t_slow", run: () => new Promise(() => {}) }),
    ]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runHelpTools(s, { tenantId: A, role: "owner" },
      ["t_confirm", "t_safe", "t_bad", "t_throw", "t_slow"].map((name) => ({ name, input: { n: 1 } })), reg, { timeoutMs: 20 });
    err.mockRestore();
    expect(res.map((r) => r.refusal)).toEqual(["tier_not_enabled", "tier_not_enabled", "bad_output", "failed", "timeout"]);
    expect(runSpy).not.toHaveBeenCalled();
    expect(res.every((r) => !r.ok && r.href === null && r.sources.length === 0)).toBe(true);
  });

  it(`more than ${HELP_CALLS_MAX} calls in one go → the extra ones are refused`, async () => {
    const { s } = session({ subscriptions: subs });
    const res = await runHelpTools(s, { tenantId: A, role: "owner" }, Array.from({ length: HELP_CALLS_MAX + 2 }, () => ({ name: "leads_by_stage" })));
    expect(res.slice(HELP_CALLS_MAX).map((r) => r.refusal)).toEqual(["too_many_calls", "too_many_calls"]);
  });
});

describe("the 6 R-421 tools on the registry", () => {
  const tables: Record<string, Row[]> = {
    subscriptions: subs,
    invoices: [
      { id: "i1", tenant_id: A, status: "pending", due_date: "2026-10-01", amount: 118000, net_payable: null, paid_amount: 18000 },
      { id: "i9", tenant_id: B, status: "pending", due_date: "2026-09-01", amount: 999999, net_payable: null, paid_amount: 0 },
    ],
    quotes: [{ id: "q1", tenant_id: A, status: "sent", amount: 250000, invoice_id: null }, { id: "q9", tenant_id: B, status: "sent", amount: 1, invoice_id: null }],
    leads: [
      { id: "l1", tenant_id: A, is_junk: false, stage: "contact", follow_up_date: "2026-10-07", company: "Today Co", value: 10 },
      { id: "l9", tenant_id: B, is_junk: false, stage: "new", follow_up_date: "2026-10-07", company: "Other", value: 1 },
    ],
  };

  it("same text as the old path for every tool, tenant-filtered, with sources", async () => {
    const legacy = fakeClient(tables);
    const old = await runHelpDataTools(legacy.client as never, { tenantId: A, role: "owner", now: NOW }, HELP_DATA_TOOL_NAMES.slice(0, 3));
    const old2 = await runHelpDataTools(legacy.client as never, { tenantId: A, role: "owner", now: NOW }, HELP_DATA_TOOL_NAMES.slice(3));
    const { s, log } = session(tables);
    const v2 = await runHelpTools(s, { tenantId: A, role: "owner", now: NOW }, HELP_DATA_TOOL_NAMES.map((name) => ({ name })));
    expect(v2.map((r) => r.text)).toEqual([...old, ...old2].map((r) => r.text));
    expect(v2.every((r) => r.ok && r.sources.length > 0)).toBe(true);
    expect(v2.map((r) => r.text).join("\n")).not.toMatch(/OtherCo|Other\b|9,99,999/);
    for (const q of log) expect(q.filters).toContainEqual(["eq", "tenant_id", A]);
    for (const q of legacy.log) expect(q.filters).toContainEqual(["eq", "tenant_id", A]);
    expect(v2.find((r) => r.name === "renewals_due")?.sources[0]).toMatchObject({ table: "subscriptions", ids: ["s1"] });
    expect(v2.find((r) => r.name === "todays_followups")?.sources[0]).toMatchObject({ table: "leads", ids: ["l1"] });
  });

  it("runHelpDataToolsV2 keeps the R-421 shape and the 'not allowed' wording", async () => {
    const { s } = session(tables);
    const [ok] = await runHelpDataToolsV2(s, { tenantId: A, role: "owner", now: NOW }, ["open_quotes"]);
    expect(ok).toMatchObject({ tool: "open_quotes", ok: true, href: "/quotes", label: "Open Quotes" });
    const [no] = await runHelpDataToolsV2(s, { tenantId: A, role: "sales", now: NOW }, ["todays_followups"]);
    expect(no).toMatchObject({ ok: false, text: "todays_followups: not allowed for your role.", href: null });
  });

  it("every registered tool is a read tool for the owner with a strict input", () => {
    for (const t of HELP_TOOL_REGISTRY.values()) {
      expect(t.tier).toBe("read");
      expect(t.roles).toEqual(["owner"]);
    }
  });
});

describe("HELP_AI_V2 flag", () => {
  it("on only for the owner, off by default", () => {
    expect(helpAiV2Enabled("owner")).toBe(false);
    vi.stubEnv("HELP_AI_V2", "1");
    expect(helpAiV2Enabled("owner")).toBe(true);
    expect(helpAiV2Enabled("manager")).toBe(false);
    expect(helpAiV2Enabled(null)).toBe(false);
    vi.stubEnv("HELP_AI_V2", "0");
    expect(helpAiV2Enabled("owner")).toBe(false);
  });
});
