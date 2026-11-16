// @vitest-environment jsdom
/* R-2835 — drawer cost lines on a scheduled seat cut, and on a term outside 1–60 months. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

const useCurrentUser = vi.fn(() => ({ data: { role: "owner" } as { role: string } }));
const useSeatCuts = vi.fn((): { data: unknown; isError: boolean } => ({ data: [], isError: false }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => useCurrentUser() }));
vi.mock("./drawer-data", () => ({
  useRenewalDrawerData: () => ({ data: { docs: undefined, paid: undefined }, isLoading: false, isError: false }),
}));
vi.mock("./drawer-cost-data", () => ({
  useRenewalDrawerCatalog: () => ({
    data: [{ id: "E2E-GW-STD", name: "E2E Google Workspace Business Standard", vendor: "google", msrp: 736, wholesale: 620, prices: {}, is_active: true }],
    isError: false,
  }),
}));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => useSeatCuts() }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";

const SUB = {
  id: "sub-1", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2835", plan: "Google Workspace Business Standard",
  seats: 20, vendor: "google", item_id: null, term_months: 12, mrr: 17000, term_amount: null, renewal_date: "2026-12-01",
  start_date: "2025-12-01", status: "active", renewal_quote_id: null, quote_id: null, reminder_count: 0,
};
const item = (sub = SUB): DrawerItem => ({
  sub: sub as never, daysUntil: 17, stage: null, amount: renewalAmount(sub, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const show = (it: DrawerItem) => render(<RenewalDrawer item={it} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const CUT = { id: "c1", timing: "end_of_term", status: "scheduled", seats_before: 20, seats_after: 15, effective_date: "2026-12-01" };

beforeEach(() => { useCurrentUser.mockReturnValue({ data: { role: "owner" } }); useSeatCuts.mockReturnValue({ data: [], isError: false }); });
afterEach(() => cleanup());

describe("R-2835 scheduled seat cut", () => {
  it("20 → 15 scheduled: cost and margin are for 15 seats, with 'on 20 seats, cut to 15 scheduled'", () => {
    useSeatCuts.mockReturnValue({ data: [CUT], isError: false });
    show(item());
    expect(screen.getByTestId("renewal-drawer-cost").textContent).toBe("₹1,11,600/yr");
    expect(screen.getByTestId("renewal-drawer-seat-note").textContent).toBe("On 20 seats, cut to 15 scheduled");
    expect(screen.getByTestId("renewal-drawer-margin").textContent).toBe("₹41,400/yr · 27%");
  });
  it("no cut: R-2819's numbers and no note", () => {
    show(item());
    expect(screen.getByTestId("renewal-drawer-cost").textContent).toBe("₹1,48,800/yr");
    expect(screen.queryByTestId("renewal-drawer-seat-note")).toBeNull();
  });
  it("cuts still loading → the cost shows its loading state, not the old-seats number", () => {
    useSeatCuts.mockReturnValue({ data: undefined, isError: false });
    show(item());
    expect(screen.getByLabelText("Loading our cost")).toBeTruthy();
    expect(screen.queryByTestId("renewal-drawer-cost")).toBeNull();
  });
  it("cuts read failed → current seats, with a note saying so", () => {
    useSeatCuts.mockReturnValue({ data: undefined, isError: true });
    show(item());
    expect(screen.getByTestId("renewal-drawer-cost").textContent).toBe("₹1,48,800/yr");
    expect(screen.getByTestId("renewal-drawer-seat-note").textContent).toMatch(/could not be read/);
  });
});

describe("R-2835 term outside 1–60", () => {
  it.each([0, 61, 120])("term_months %s → 'Cost unknown — check term', margin unknown, no ₹ figure", (t) => {
    show(item({ ...SUB, term_months: t }));
    expect(screen.getByTestId("renewal-drawer-cost").textContent).toBe("Cost unknown — check term");
    expect(screen.getByTestId("renewal-drawer-margin").textContent).toBe("Unknown — no cost");
    expect(screen.queryByText(/Cost missing/)).toBeNull();
  });
});
