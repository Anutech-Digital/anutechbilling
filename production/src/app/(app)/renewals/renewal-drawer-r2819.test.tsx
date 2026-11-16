// @vitest-environment jsdom
/* R-2819 — the Renewals drawer's Terms: owner / manager see Customer pays · Our cost · Margin (or
   "Cost missing — add in catalogue"); billing / support see only Amount and the catalogue is never read. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within } from "@testing-library/react";

const useCurrentUser = vi.fn(() => ({ data: { role: "owner" } as { role: string } }));
const useRenewalDrawerCatalog = vi.fn((_t: string | null, _on: boolean) => ({ data: CATALOG as unknown, isError: false }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => useCurrentUser() }));
vi.mock("./drawer-data", () => ({
  useRenewalDrawerData: () => ({ data: { docs: undefined, paid: undefined }, isLoading: false, isError: false }),
}));
vi.mock("./drawer-cost-data", () => ({
  useRenewalDrawerCatalog: (t: string | null, on: boolean) => useRenewalDrawerCatalog(t, on),
}));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";

const CATALOG = [
  { id: "E2E-GW-STD", name: "E2E Google Workspace Business Standard", vendor: "google", msrp: 736, wholesale: 620, prices: {}, is_active: true },
];
const SUB = {
  id: "sub-1", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2758 Sent Plan", plan: "Google Workspace Business Standard",
  seats: 20, vendor: "google", item_id: null, term_months: 12, mrr: 17000, term_amount: null, renewal_date: "2026-12-01",
  start_date: "2025-12-01", status: "active", renewal_quote_id: null, quote_id: null, reminder_count: 0,
};
const item = (sub = SUB, amount = renewalAmount(sub, null)): DrawerItem => ({
  sub: sub as never, daysUntil: 17, stage: null, amount, frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const show = (it: DrawerItem) => render(<RenewalDrawer item={it} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const terms = () => within(screen.getByTestId("renewal-drawer-terms"));

beforeEach(() => { useCurrentUser.mockReturnValue({ data: { role: "owner" } }); useRenewalDrawerCatalog.mockClear(); useRenewalDrawerCatalog.mockReturnValue({ data: CATALOG, isError: false }); });
afterEach(() => cleanup());

describe("R-2819 drawer cost lines", () => {
  it("owner: Customer pays ₹2,04,000/yr + GST · Our cost ₹1,48,800/yr · Margin ₹55,200/yr · 27%", () => {
    show(item());
    expect(terms().getByText("Customer pays")).toBeTruthy();
    expect(terms().queryByText("Amount")).toBeNull();
    expect(screen.getByTestId("renewal-drawer-cost").textContent).toBe("₹1,48,800/yr");
    expect(screen.getByTestId("renewal-drawer-margin").textContent).toBe("₹55,200/yr · 27%");
    expect(useRenewalDrawerCatalog).toHaveBeenCalledWith("t-1", true);
  });

  it("manager sees it too", () => {
    useCurrentUser.mockReturnValue({ data: { role: "manager" } });
    show(item());
    expect(screen.getByTestId("renewal-drawer-margin")).toBeTruthy();
  });

  it.each(["billing", "support"])("%s (opens Renewals, not the catalogue): only Amount, no cost, catalogue not read", (role) => {
    useCurrentUser.mockReturnValue({ data: { role } });
    show(item());
    expect(terms().getByText("Amount")).toBeTruthy();
    expect(terms().queryByText("Customer pays")).toBeNull();
    expect(terms().queryByText("Our cost")).toBeNull();
    expect(terms().queryByText("Margin")).toBeNull();
    expect(screen.queryByTestId("renewal-drawer-cost")).toBeNull();
    expect(useRenewalDrawerCatalog.mock.calls.every(([, on]) => on === false)).toBe(true);
  });

  it("no catalogue cost → 'Cost missing — add in catalogue' linking to /items, margin unknown", () => {
    show(item({ ...SUB, plan: "Some bespoke plan" }));
    const link = screen.getByRole("link", { name: "Cost missing — add in catalogue" });
    expect(link.getAttribute("href")).toBe("/items");
    expect(screen.getByTestId("renewal-drawer-margin").textContent).toBe("Unknown — no cost");
  });

  it("catalogue read failed → says so, never 'Cost missing'", () => {
    useRenewalDrawerCatalog.mockReturnValue({ data: undefined, isError: true });
    show(item());
    expect(screen.getByTestId("renewal-drawer-cost").textContent).toMatch(/Couldn.t read the catalogue/);
    expect(screen.queryByText(/Cost missing/)).toBeNull();
  });

  it("loss: cost above price → minus sign and (loss)", () => {
    const sub = { ...SUB, mrr: 10000 };
    show(item(sub));
    expect(screen.getByTestId("renewal-drawer-margin").textContent).toBe("−₹28,800/yr · −24% (loss)");
  });

  it("USD customer: their currency + the ₹ books line; margin in ₹ only", () => {
    const amount = renewalAmount(SUB, null, { id: "Q", amount: 1, status: "paid", currency: "USD", exchange_rate: 85 });
    show(item(SUB, amount));
    expect(terms().getByText(amount.text)).toBeTruthy();
    expect(screen.getByTestId("renewal-drawer-books").textContent).toBe("₹2,04,000/yr in ₹ (books)");
    expect(screen.getByTestId("renewal-drawer-margin").textContent).toBe("₹55,200/yr · 27%");
  });
});
