// @vitest-environment jsdom
/**
 * R-2461 (4 Nov 2026, Pardeep: "haan purchase accountant ko bhi dikhe") — the accountant opens
 * Purchases → Purchase Inbox. inbound_purchases RLS is tenant-wide (select + update by
 * current_tenant_id(), 20261019003408) and expenses are tenant-wide too, so the accountant gets BOTH
 * tabs and can work the email rows. Only the "Set up email forwarding" button points at /settings,
 * which the accountant cannot open — so for them the empty inbox says to ask the owner/manager
 * instead of offering a button that would bounce.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ role: "accountant" as string | null, emails: [] as Record<string, unknown>[] }));
const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/purchases/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => (state.role === null ? { data: undefined, isLoading: true } : { data: { role: state.role }, isLoading: false }),
}));
vi.mock("@/lib/queries/inbound-purchases", () => ({
  useInboundPurchases: () => ({ data: state.emails, isLoading: false, error: null, refetch: vi.fn() }),
  useImportPurchase: () => ({ mutateAsync: vi.fn() }),
  useIgnorePurchase: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/components/features/purchases/network-inbox-queries", () => ({
  useNetworkInbox: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/components/features/purchases/network-inbox-tab", () => ({
  NetworkInboxTab: () => <div>network tab body</div>,
}));

import PurchaseInboxPage from "./page";

const email = {
  id: 7, source: "amazon", order_id: "404-1", order_date: "2026-11-03", subject: "Your Amazon order",
  items: [{ qty: 1, name: "Keyboard" }], total: 1180, gst: 180, status: "pending",
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PurchaseInboxPage /></QueryClientProvider>);
}

beforeEach(() => {
  state.role = "accountant"; state.emails = []; push.mockReset();
  window.history.replaceState(null, "", "/purchases/inbox"); // the tab lives in ?tab= (useUrlChoice)
});
afterEach(cleanup);

describe("R-2461 the accountant's Purchase Inbox", () => {
  it("shows both tabs; the email row has Add to expenses and Ignore; From network opens", async () => {
    state.emails = [email];
    mount();
    expect(screen.getByRole("tab", { name: /From email/ })).toBeTruthy();
    expect(screen.getByText("Your Amazon order")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add to expenses/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ignore/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /From network/ }));
    await waitFor(() => expect(screen.getByText("network tab body")).toBeTruthy());
  });

  it("an empty email inbox does not offer the Settings button the accountant cannot open — it says who sets it up", () => {
    mount();
    expect(screen.getByText("Inbox is empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set up email forwarding/ })).toBeNull();
    expect(screen.getByText(/Ask your owner or manager to set up email forwarding/)).toBeTruthy();
  });

  it("while the role is still loading the owner's button stays (no flicker to the accountant's text)", () => {
    state.role = null;
    mount();
    expect(screen.getByRole("button", { name: /Set up email forwarding/ })).toBeTruthy();
    expect(screen.queryByText(/Ask your owner or manager/)).toBeNull();
  });

  it.each(["owner", "manager"])("%s still gets the Set up email forwarding button", (role) => {
    state.role = role;
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Set up email forwarding/ }));
    expect(push).toHaveBeenCalledWith("/settings?tab=integrations");
  });
});
