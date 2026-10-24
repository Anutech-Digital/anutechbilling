// @vitest-environment jsdom
/**
 * R-1807 (24 Oct 2026) — R-1806's follow-ups: more places where a failed read was shown as
 * ₹0, "No team members yet" or "Send quote".
 *
 *  1. fetchAdSpend() dropped a failed ad_accounts read: every spend row then had no platform
 *     and was filtered out, so Marketing → Ads said ₹0 spend with no error.
 *  2. usePerformance(): a failed team-members read left the query disabled (not an error),
 *     and the pages never looked at isError — Scorecard said "No team members yet" and a
 *     failed payments read never reached the screen.
 *  3. Scorecard + Performance pages show the §24 error with Try again.
 *  4. The lead drawer footer does not offer "Send quote" while the lead's quotes are unknown.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, renderHook, waitFor, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const h = vi.hoisted(() => ({
  failTable: "payments" as string | null,
  members: { data: [{ id: "u1", full_name: "Asha", role: "sales" }] as unknown[] | undefined, isError: false, error: null as unknown },
  refetchMembers: () => {},
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "order", "eq", "neq", "gte", "lt", "in", "range", "not", "limit"]) chain[m] = () => chain;
  chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(table === h.failTable
      ? { data: null, error: { message: `permission denied for table ${table}`, code: "42501" } }
      : { data: [], error: null }).then(ok, bad);
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: (t: string) => chainFor(t) }) }));
vi.mock("@/lib/queries/team", () => ({
  useTeamMembers: () => ({ ...h.members, refetch: h.refetchMembers }),
  memberLabel: (m: { full_name?: string }) => m.full_name ?? "",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/cold-calling", () => ({ useBolnaAgents: () => ({ data: { agents: [] } }) }));

afterEach(() => {
  cleanup();
  h.failTable = "payments";
  h.members = { data: [{ id: "u1", full_name: "Asha", role: "sales" }], isError: false, error: null };
});

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
};

describe("fetchAdSpend — a failed ad_accounts read is an error (R-1807)", () => {
  it("rejects instead of returning no rows", async () => {
    const { fetchAdSpend } = await import("./ads");
    h.failTable = "ad_accounts";
    const supabase = { from: (t: string) => chainFor(t) } as unknown as SupabaseClient<Database>;
    await expect(fetchAdSpend(supabase, "2026-10-01")).rejects.toBeTruthy();
  });
});

describe("usePerformance — a failed read is an error (R-1807)", () => {
  it("a failed payments read ends in isError (Revenue is not ₹0)", async () => {
    const { usePerformance } = await import("./performance");
    const { result } = renderHook(() => usePerformance("2026-10"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("a failed team-members read is an error too, not 'no team members'", async () => {
    h.members = { data: undefined, isError: true, error: { message: "network" } };
    const { usePerformance } = await import("./performance");
    const { result } = renderHook(() => usePerformance("2026-10"), { wrapper: wrap() });
    expect(result.current.isError).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });
});

describe("Scorecard + Performance pages show the error (R-1807)", () => {
  it.each([
    ["scorecard", () => import("@/app/(app)/scorecard/page")],
    ["performance", () => import("@/app/(app)/performance/page")],
  ])("%s: 'didn't load' + Try again, never 'No team members yet'", async (_n, load) => {
    const Page = (await load()).default;
    render(React.createElement(Page), { wrapper: wrap() });
    await waitFor(() => expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy());
    expect(document.body.textContent).toMatch(/didn.t load/);
    expect(document.body.textContent).not.toMatch(/No team members yet/);
    expect(document.body.textContent).not.toMatch(/₹0/);
  });
});

describe("lead drawer footer while the quotes are unknown (R-1807)", () => {
  it("does not offer Send quote / New quote / Revise", async () => {
    const { LeadDetailFooter } = await import("@/components/features/leads/lead-detail-footer");
    const lead = { id: "L-1", stage: "contact", contact_phone: null, customer_id: null } as unknown as
      React.ComponentProps<typeof LeadDetailFooter>["lead"];
    const noop = () => {};
    render(React.createElement(LeadDetailFooter, {
      lead, onEdit: noop, handleArchive: noop, handleDelete: noop, deletePending: false, handleEmail: noop,
      setWhatsOpen: noop, latestQuote: undefined, hasQuotes: false, quotesUnknown: true,
      nextAction: null, handleSendQuote: noop, handleReviseQuote: noop,
    }), { wrapper: wrap() });
    expect(screen.queryByRole("button", { name: /send quote|new quote|revise/i })).toBeNull();
  });

  it("loaded with no quotes still offers Send quote (as before)", async () => {
    const { LeadDetailFooter } = await import("@/components/features/leads/lead-detail-footer");
    const lead = { id: "L-1", stage: "contact", contact_phone: null, customer_id: null } as unknown as
      React.ComponentProps<typeof LeadDetailFooter>["lead"];
    const noop = () => {};
    render(React.createElement(LeadDetailFooter, {
      lead, onEdit: noop, handleArchive: noop, handleDelete: noop, deletePending: false, handleEmail: noop,
      setWhatsOpen: noop, latestQuote: undefined, hasQuotes: false,
      nextAction: null, handleSendQuote: noop, handleReviseQuote: noop,
    }), { wrapper: wrap() });
    fireEvent.click(screen.getByRole("button", { name: /send quote/i }));
  });
});
