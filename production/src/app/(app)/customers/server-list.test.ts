/**
 * R-210 — the Customers list reads 50 rows at a time; chips and KPIs no longer need every row.
 *
 * The heart of these tests is EQUIVALENCE: the chip counts and money totals worked out from
 * the fact maps + a server total must equal what the page used to compute by walking every
 * customer row. If they ever disagree, a chip says 12 and opens a list of 11.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  customerViewCounts, customerMoneyTotals, contactMatchedCustomerIds, customerListMode,
  viewCtxFor, CONTACT_MATCH_ID_CAP, type CustomerFacts,
} from "./server-list";
import {
  customerSearchOr, fetchCustomersPage, nextCustomerPageFrom, fetchCustomerListCounts,
  CUSTOMERS_PAGE_SIZE, type CustomerPage,
} from "@/lib/queries/customers";
import { missingInvoiceState } from "@/lib/gst/gstin-state";
import { countsAsNoBusiness, type ProjectLike } from "@/lib/customers/portfolio-status";
import type { ViewCtx } from "./server-list";

/* A copy of page.tsx VIEW_DEFS (a page file cannot export it). The wiring test at the bottom
   checks the page passes its own list in. */
const VIEW_DEFS: { id: string; test: (x: ViewCtx) => boolean }[] = [
  { id: "all",        test: () => true },
  { id: "unpaid",     test: (x) => x.amount > 0 },
  { id: "subscribed", test: (x) => x.hasSub },
  { id: "projects",   test: (x) => x.projects.length > 0 },
  { id: "nosub",      test: (x) => countsAsNoBusiness({ hasActiveSub: x.hasSub, projects: x.projects }) },
  { id: "credit",     test: (x) => x.credit > 0 },
  { id: "received",   test: (x) => x.received > 0 },
  { id: "nostate",    test: (x) => x.noState },
];

type Row = { id: string; is_active: boolean; state_code: string | null; country: string | null };

const customers: Row[] = [
  { id: "c1", is_active: true,  state_code: "07", country: "India" },
  { id: "c2", is_active: true,  state_code: null, country: "India" },   // no state
  { id: "c3", is_active: false, state_code: "",   country: null },      // no state, archived
  { id: "c4", is_active: true,  state_code: null, country: "USA" },     // foreign — not "missing"
  { id: "c5", is_active: true,  state_code: "27", country: null },
  { id: "c6", is_active: true,  state_code: "29", country: "in" },
  { id: "c7", is_active: false, state_code: "09", country: null },
];

const wonProject = { customer_id: "c5", status: "active" } as unknown as ProjectLike;
const quoteProject = { customer_id: "c6", status: "quoted" } as unknown as ProjectLike;

function facts(): CustomerFacts {
  return {
    outstanding: new Map([["c1", { amount: 1180 }], ["c3", { amount: 500 }]]),
    credits: { c2: 200, c7: 0 },
    subs: new Map([["c1", { mrr: 999 }], ["c6", { mrr: 1500 }]]),
    projects: new Map([["c5", [wonProject]], ["c6", [quoteProject]]]),
    received: { c1: { total: 11800 }, c4: { total: 0 } },
    noState: new Set(customers.filter((c) => missingInvoiceState(c)).map((c) => c.id)),
  };
}

/** What the page computed before R-210: walk every row, test every view. */
function oldCounts(f: CustomerFacts): Record<string, number> {
  const m: Record<string, number> = Object.fromEntries(VIEW_DEFS.map((v) => [v.id, 0]));
  for (const c of customers) {
    const ctx = { ...viewCtxFor(c.id, f), noState: missingInvoiceState(c) };
    for (const v of VIEW_DEFS) if (v.test(ctx)) m[v.id]++;
  }
  return m;
}

describe("customerViewCounts — chip counts without the rows", () => {
  it("equals the old row-by-row count for every view", () => {
    const f = facts();
    expect(customerViewCounts(customers.length, f, VIEW_DEFS)).toEqual(oldCounts(f));
  });

  it("counts customers outside every map for No business (from the total)", () => {
    const f = facts();
    const counts = customerViewCounts(customers.length, f, VIEW_DEFS);
    // c5 has a won project, c1/c6 an active subscription → 4 of 7 have no business.
    expect(counts.nosub).toBe(4);
    expect(counts.all).toBe(7);
    expect(counts.nostate).toBe(2);
  });

  it("an empty workspace counts zero everywhere", () => {
    const empty: CustomerFacts = {
      outstanding: new Map(), credits: {}, subs: new Map(), projects: new Map(), received: {}, noState: new Set(),
    };
    expect(Object.values(customerViewCounts(0, empty, VIEW_DEFS)).every((n) => n === 0)).toBe(true);
  });
});

describe("customerMoneyTotals — KPI strip without the rows", () => {
  it("equals the old sum over every customer row", () => {
    const f = facts();
    const old = {
      mrr: customers.reduce((s, c) => s + (f.subs.get(c.id)?.mrr ?? 0), 0),
      receivables: customers.reduce((s, c) => s + (f.outstanding.get(c.id)?.amount ?? 0), 0),
      received: customers.reduce((s, c) => s + (f.received[c.id]?.total ?? 0), 0),
    };
    expect(customerMoneyTotals(f)).toEqual({ ...old, arr: old.mrr * 12 });
    expect(customerMoneyTotals(f)).toEqual({ mrr: 2499, arr: 29988, receivables: 1680, received: 11800 });
  });
});

describe("customerListMode — server paging only where it gives the same rows", () => {
  it("default screen (All, newest first) is server", () => {
    expect(customerListMode({ view: "all", sortKey: "recent", sortDir: "desc", contactIds: null })).toBe("server");
    expect(customerListMode({ view: "all", sortKey: "recent", sortDir: "desc", contactIds: ["a"] })).toBe("server");
  });
  it("other views, other sorts, oldest-first and huge person matches read the full list", () => {
    expect(customerListMode({ view: "unpaid", sortKey: "recent", sortDir: "desc", contactIds: null })).toBe("full");
    expect(customerListMode({ view: "all", sortKey: "mrr", sortDir: "desc", contactIds: null })).toBe("full");
    expect(customerListMode({ view: "all", sortKey: "recent", sortDir: "asc", contactIds: null })).toBe("full");
    const many = Array.from({ length: CONTACT_MATCH_ID_CAP + 1 }, (_, i) => `id${i}`);
    expect(customerListMode({ view: "all", sortKey: "recent", sortDir: "desc", contactIds: many })).toBe("full");
  });
});

describe("contactMatchedCustomerIds", () => {
  const index = {
    textByCustomer: new Map([["c1", "anjali anjali@x.in 98100"], ["c2", "ravi"], ["c3", "anjali sharma"]]),
    customerCountByContact: new Map<string, number>(),
    customerIdsByContact: new Map<string, string[]>(),
  };
  it("finds every customer a matching person is on, same test as the row search", () => {
    expect(contactMatchedCustomerIds(index, "  Anjali ")).toEqual(["c1", "c3"]);
  });
  it("null with no search or no index yet", () => {
    expect(contactMatchedCustomerIds(index, "  ")).toBeNull();
    expect(contactMatchedCustomerIds(undefined, "anjali")).toBeNull();
  });
});

describe("customerSearchOr — the search box as one PostgREST or=()", () => {
  it("null when there is nothing to search", () => {
    expect(customerSearchOr("   ")).toBeNull();
    expect(customerSearchOr("%*")).toBeNull();
  });
  it("every searched column, quoted, case-insensitive, plus person-matched ids", () => {
    expect(customerSearchOr(" Doodh, Sang ", ["c2", "c1", "c2"])).toBe(
      'name.ilike."%doodh, sang%",display_name.ilike."%doodh, sang%",domain.ilike."%doodh, sang%",'
      + 'contact_name.ilike."%doodh, sang%",contact_email.ilike."%doodh, sang%",id.in.(c2,c1)',
    );
  });
  it("drops wildcard and quote characters instead of passing them through", () => {
    expect(customerSearchOr('a"b%c*d\\e')).toContain('name.ilike."%abcde%"');
  });
});

/** A fake PostgREST builder that records every call and answers with `answer`. */
function fakeClient(answer: { data: unknown; error: unknown; count?: number | null }) {
  const calls: [string, ...unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "not", "or", "order", "range"]) {
    builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder; };
  }
  builder.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
  return { client: builder as never, calls };
}

describe("fetchCustomersPage — 50 rows, filters on the server, exact total", () => {
  it("first page: rows 0–49, count exact, active only, newest first ending on id", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` }));
    const { client, calls } = fakeClient({ data: rows, error: null, count: 1234 });
    const page = await fetchCustomersPage(client, { search: "", archived: false }, 0);
    expect(page.total).toBe(1234);
    expect(page.rows).toHaveLength(50);
    expect(calls).toContainEqual(["select", "*", { count: "exact" }]);
    expect(calls).toContainEqual(["not", "is_active", "is", false]);
    expect(calls).toContainEqual(["range", 0, CUSTOMERS_PAGE_SIZE - 1]);
    expect(calls.filter((c) => c[0] === "order")).toEqual([
      ["order", "created_at", { ascending: false, nullsFirst: false }],
      ["order", "name", { ascending: true }],
      ["order", "id", { ascending: true }],
    ]);
    expect(calls.some((c) => c[0] === "or")).toBe(false);
  });

  it("archived + search go into the query, next page starts where the last ended", async () => {
    const { client, calls } = fakeClient({ data: [], error: null, count: 0 });
    await fetchCustomersPage(client, { search: "ff", archived: true, contactIds: ["x"] }, 50);
    expect(calls).toContainEqual(["eq", "is_active", false]);
    expect(calls).toContainEqual(["or", customerSearchOr("ff", ["x"])]);
    expect(calls).toContainEqual(["range", 50, 99]);
  });

  it("a failed read throws — never an empty page that looks like 'no customers'", async () => {
    const { client } = fakeClient({ data: null, error: new Error("JWT expired"), count: null });
    await expect(fetchCustomersPage(client, { search: "", archived: false }, 0)).rejects.toThrow("JWT expired");
  });
});

describe("nextCustomerPageFrom", () => {
  const page = (n: number, total: number): CustomerPage => ({ rows: Array.from({ length: n }, (_, i) => ({ id: `${total}-${i}` })) as never, total });
  it("asks for the next 50 while rows remain", () => {
    const a = page(50, 120);
    expect(nextCustomerPageFrom(a, [a])).toBe(50);
    const b = page(50, 120);
    expect(nextCustomerPageFrom(b, [a, b])).toBe(100);
  });
  it("stops on a short page or when the total is reached", () => {
    const a = page(50, 120), b = page(50, 120), c = page(20, 120);
    expect(nextCustomerPageFrom(c, [a, b, c])).toBeUndefined();
    const only = page(50, 50);
    expect(nextCustomerPageFrom(only, [only])).toBeUndefined();
  });
});

describe("fetchCustomerListCounts", () => {
  it("server totals + no-state customers judged by missingInvoiceState", async () => {
    let n = 0;
    const answers = [
      { data: null, error: null, count: 7 },
      { data: null, error: null, count: 2 },
      { data: customers.filter((c) => !c.state_code).map(({ id, state_code, country }) => ({ id, state_code, country })), error: null },
    ];
    const builder: Record<string, unknown> = {};
    const make = () => {
      const idx = n++;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "or", "order", "range"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(answers[idx]).then(res);
      return b;
    };
    builder.from = () => make();
    const counts = await fetchCustomerListCounts(builder as never);
    expect(counts).toEqual({ all: 7, archived: 2, noStateIds: ["c2", "c3"] });
  });
});

describe("the Customers page wiring (R-210)", () => {
  it("default screen reads server pages; the whole list only when the mode says full", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/useCustomersPaged\(/);
    expect(src).toMatch(/useCustomers\(\{ enabled: mode === "full" \}\)/);
    expect(src).not.toMatch(/useCustomers\(\)/);
    // chip counts and KPIs come from server counts + fact maps, not from walking the rows
    expect(src).toMatch(/customerViewCounts\(/);
    expect(src).toMatch(/customerMoneyTotals\(/);
  });
});
