// @vitest-environment jsdom
/**
 * R-2239 (Zoho Billing audit B1) — the owner's real path: open the Dashboard while the data is
 * still on its way (or failed). It used to say "No subs yet", "Customers 0", "Nothing to chase"
 * and "Add your first customer" while 61 subscriptions existed.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

type Q = { data?: unknown; isError?: boolean; isSuccess?: boolean; error?: unknown; refetch: () => void };
const pending = (): Q => ({ data: undefined, isError: false, isSuccess: false, refetch: vi.fn() });
const ok = (data: unknown): Q => ({ data, isError: false, isSuccess: true, refetch: vi.fn() });
const failed = (): Q => ({ data: undefined, isError: true, isSuccess: false, error: new Error("net"), refetch: vi.fn() });

const q: Record<string, Q> = {};
function setAll(make: () => Q) {
  for (const k of ["leads", "dashLeads", "customers", "quotes", "subs", "projRecv", "tasks", "items", "trials"]) q[k] = make();
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("framer-motion", () => ({
  Reorder: {
    Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
  useDragControls: () => ({ start: () => {} }),
}));
vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/leads", () => ({
  useLeadStageTotals: () => q.leads,
  useDashboardLeads: () => q.dashLeads,
}));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => q.customers }));
vi.mock("@/lib/queries/quotes", () => ({ useQuotes: () => q.quotes }));
vi.mock("@/lib/queries/subscriptions", () => ({ useSubscriptions: () => q.subs }));
vi.mock("@/lib/queries/projects", () => ({ useProjectReceivablesByCustomer: () => q.projRecv }));
vi.mock("@/lib/queries/tasks", () => ({ useTasks: () => q.tasks }));
vi.mock("@/lib/queries/items", () => ({ useItems: () => q.items }));
vi.mock("@/lib/queries/trials", () => ({ useTrialsExpiringSoon: () => q.trials }));
vi.mock("@/lib/queries/deals", () => ({ useDealRows: () => ({ data: undefined }) }));
vi.mock("@/lib/queries/sell-mode", () => ({
  useSellMode: () => ({ data: undefined }),
  useActiveProjectSales: () => ({ data: undefined }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: "billing", fullName: "Pardeep", tenantName: "Anutech" } }),
}));
vi.mock("@/lib/onboarding/use-setup-facts", () => ({ useSetupFacts: () => undefined }));
/* Cards with their own tests / own queries — not what this test is about. */
vi.mock("@/components/features/deals/deals-strip", () => ({ DealsStrip: () => null }));
vi.mock("@/components/features/dashboard/company-section", () => ({ CompanySection: () => null }));
vi.mock("@/components/features/dashboard/money-health-card", () => ({ MoneyHealthCard: () => null }));
vi.mock("@/components/features/dashboard/ai-performance-card", () => ({ AiPerformanceCard: () => null }));
vi.mock("@/components/features/team/pending-join-requests-card", () => ({ PendingJoinRequestsCard: () => null }));
vi.mock("@/components/features/dashboard/getting-started-card", () => ({ GettingStartedCard: () => null }));
vi.mock("@/components/features/dashboard/health-card", () => ({ HealthCard: () => null }));
vi.mock("@/components/shared/portal-dock", () => ({ PortalDock: () => null }));

import DashboardPage from "./page";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const EMPTY_TEXTS = [
  "No subs yet",
  "Nothing to chase",
  "Add your first customer",
  "No urgent renewals",
  "No draft quotes",
  "No subscriptions renewing in 30 days",
  "No follow-ups scheduled.",
  "No trials expiring in the next 7 days.",
  "0 new leads today",
  "No active deals yet",
];

function customersCount(): string {
  const label = screen.getByText("Customers");
  return (label.parentElement as HTMLElement).textContent ?? "";
}

describe("Dashboard while loading / failed / empty (R-2239)", () => {
  it("still loading → no empty text anywhere, no 'Customers 0'", () => {
    setAll(pending);
    render(<DashboardPage />);
    for (const t of EMPTY_TEXTS) expect(screen.queryByText(t, { exact: false }), t).toBeNull();
    expect(customersCount()).not.toMatch(/0$/);
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("still loading after 10 s → \"Still loading…\", still no empty text", () => {
    vi.useFakeTimers();
    setAll(pending);
    render(<DashboardPage />);
    expect(screen.queryAllByText("Still loading…")).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getAllByText("Still loading…").length).toBeGreaterThan(0);
    for (const t of EMPTY_TEXTS) expect(screen.queryByText(t, { exact: false }), t).toBeNull();
  });

  it("failed → error states, no empty text, no 'Customers 0'", () => {
    setAll(failed);
    render(<DashboardPage />);
    for (const t of EMPTY_TEXTS) expect(screen.queryByText(t, { exact: false }), t).toBeNull();
    expect(customersCount()).not.toMatch(/0$/);
    expect(screen.getAllByText(/didn.t load/i).length).toBeGreaterThan(0);
  });

  it("resolved empty → the honest empty texts and Customers 0", () => {
    setAll(() => ok([]));
    q.leads = ok([]);
    q.dashLeads = ok({ newToday: 0, overdueFollowups: 0, recent: [], upcoming: [] });
    q.projRecv = ok({});
    render(<DashboardPage />);
    expect(screen.getByText("No subs yet")).toBeTruthy();
    expect(screen.getByText("Nothing to chase")).toBeTruthy();
    expect(screen.getByText("Add your first customer")).toBeTruthy();
    expect(screen.getByText("No subscriptions renewing in 30 days")).toBeTruthy();
    expect(customersCount()).toMatch(/0$/);
  });

  it("resolved with data → the numbers, no empty text", () => {
    setAll(() => ok([]));
    q.leads = ok([]);
    q.dashLeads = ok({ newToday: 0, overdueFollowups: 0, recent: [], upcoming: [] });
    q.projRecv = ok({});
    q.customers = ok([{ id: "c1" }, { id: "c2" }]);
    const in10 = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    q.subs = ok([{ id: "s1", status: "active", mrr: 1000, renewal_date: in10, customer_name: "Acme", seats: 5, renewal_state: "pending" }]);
    render(<DashboardPage />);
    expect(customersCount()).toMatch(/2$/);
    expect(screen.getByText("1 active sub")).toBeTruthy();
    expect(screen.queryByText("No subs yet")).toBeNull();
    expect(screen.queryByText("Add your first customer")).toBeNull();

    expect(screen.getByText("Acme")).toBeTruthy();
  });
});
