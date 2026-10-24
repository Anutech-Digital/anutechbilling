// @vitest-environment jsdom
/* R-1536 + R-1537 — two lead reads that pulled far more than the screen needed.

   R-1536: the quote builder (/quotes/new?lead=…, edit, duplicate) ran useLeads() — select("*")
   of EVERY lead, in 1000-row pages — only to find the one lead the quote is for. It must ask
   for that one lead by id, with only the columns it reads.

   R-1537: /deals "Why deals are lost" read stage=lost with no range, so PostgREST stopped at
   1000 rows without saying so, and it counted junk leads that every other lead number drops.
   A fake client that caps every response at 1000 rows (as PostgREST's max_rows does) proves
   1,500 lost leads are all counted and junk ones are not. */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Call = { method: string; args: unknown[] };
type Chain = { table: string; calls: Call[] };

const h = vi.hoisted(() => ({
  mode: "never" as "never" | "rows",
  rows: [] as Record<string, unknown>[],
  chains: [] as { table: string; calls: { method: string; args: unknown[] }[] }[],
  search: "lead=L-1",
}));

/** PostgREST's max_rows: every response stops at this many rows, silently. */
const CAP = 1000;

function makeChain(table: string): unknown {
  const rec: Chain = { table, calls: [] };
  h.chains.push(rec);
  const resolve = () => {
    let rows = h.rows.slice();
    let range: [number, number] | null = null;
    for (const c of rec.calls) {
      if (c.method === "eq") rows = rows.filter((r) => r[c.args[0] as string] === c.args[1]);
      if (c.method === "neq") rows = rows.filter((r) => r[c.args[0] as string] !== c.args[1]);
      if (c.method === "range") range = [c.args[0] as number, c.args[1] as number];
    }
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return { data: rows.slice(0, CAP), error: null };
  };
  const never = new Promise(() => {});
  const proxy: unknown = new Proxy(function () {}, {
    get: (_t, p) => {
      if (p === "then") {
        if (h.mode === "never") return never.then.bind(never);
        const p2 = Promise.resolve(resolve());
        return p2.then.bind(p2);
      }
      return (...args: unknown[]) => { rec.calls.push({ method: String(p), args }); return proxy; };
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/client", () => {
  const anyChain = (): unknown => {
    const never = new Promise(() => {});
    const c: unknown = new Proxy(function () {}, {
      get: (_t, p) => (p === "then" ? never.then.bind(never) : c),
      apply: () => c,
    });
    return c;
  };
  const client = new Proxy({}, {
    get: (_t, p) => (p === "from" ? (table: string) => makeChain(table) : anyChain()),
  });
  return { createClient: () => client };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.search),
  usePathname: () => "/quotes/new",
}));
vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

import { useLostLeads } from "@/lib/queries/leads";
import { QuoteBuilder } from "@/components/features/quotes/quote-builder";

afterEach(() => { cleanup(); h.chains.length = 0; h.rows = []; h.mode = "never"; });

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

describe("R-1536 quote builder reads only the one lead the quote is for", () => {
  it("one leads query, by id, naming its columns — never select('*') of every lead", () => {
    h.search = "lead=L-1";
    const qc = client();
    render(<QueryClientProvider client={qc}><QuoteBuilder /></QueryClientProvider>);
    const leadReads = h.chains.filter((c) => c.table === "leads");
    expect(leadReads).toHaveLength(1);
    const calls = leadReads[0].calls;
    expect(calls).toContainEqual({ method: "eq", args: ["id", "L-1"] });
    const select = calls.find((c) => c.method === "select");
    expect(select?.args[0]).not.toBe("*");
    expect(String(select?.args[0])).toMatch(/\bbilling_cycle\b/);
    expect(calls.some((c) => c.method === "range")).toBe(false);
  });

  it("a quote with no lead reads no leads at all", () => {
    h.search = "";
    const qc = client();
    render(<QueryClientProvider client={qc}><QuoteBuilder /></QueryClientProvider>);
    expect(h.chains.filter((c) => c.table === "leads")).toHaveLength(0);
  });
});

describe("R-1537 'Why deals are lost' counts every lost lead, junk excluded", () => {
  it("1,500 lost leads all arrive past the 1000-row cap; junk ones do not", async () => {
    h.mode = "rows";
    h.rows = [
      ...Array.from({ length: 1500 }, (_, i) => ({
        id: `L-${String(i).padStart(5, "0")}`, stage: "lost", value: 100, lost_reason: "price",
        lost_at: "2026-10-01T00:00:00Z", is_junk: false,
      })),
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `J-${i}`, stage: "lost", value: 99_999, lost_reason: "price",
        lost_at: "2026-10-01T00:00:00Z", is_junk: true,
      })),
      { id: "W-1", stage: "won", value: 5, lost_reason: null, lost_at: null, is_junk: false },
    ];
    const qc = client();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useLostLeads(null), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const rows = result.current.data ?? [];
    expect(rows).toHaveLength(1500);
    expect(rows.reduce((s, r) => s + Number(r.value ?? 0), 0)).toBe(150_000);
    expect(rows.some((r) => String(r.id).startsWith("J-"))).toBe(false);
  });
});
