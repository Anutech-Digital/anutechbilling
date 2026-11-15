// @vitest-environment jsdom
/* R-2823 — the Renewals drawer's Terms show the vendor's own renewal date ("Google renews 12 Jan 2027")
   when it is known and differs from our renewal date; nothing when unknown or the same. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within } from "@testing-library/react";
import { formatDate } from "@/lib/utils";

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "billing" } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-15" }));
vi.mock("./drawer-data", () => ({
  useRenewalDrawerData: () => ({ data: { docs: undefined, paid: undefined }, isLoading: false, isError: false }),
}));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";

const SUB = {
  id: "sub-1", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2737 Split", plan: "Google Workspace Business Standard",
  seats: 20, vendor: "google", item_id: null, term_months: 12, mrr: 17000, term_amount: null, renewal_date: "2027-03-29",
  start_date: "2026-03-29", status: "active", renewal_quote_id: null, quote_id: null, reminder_count: 0, vendor_term_end: "2027-01-12",
};
const item = (sub: Record<string, unknown>): DrawerItem => ({
  sub: sub as never, daysUntil: 134, stage: null, amount: renewalAmount(sub as never, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const show = (sub: Record<string, unknown>) =>
  render(<RenewalDrawer item={item(sub)} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const terms = () => within(screen.getByTestId("renewal-drawer-terms"));

afterEach(cleanup);

describe("R-2823 drawer Terms — the vendor's own renewal date", () => {
  it("known and different → 'Google renews 12 Jan 2027'", () => {
    show(SUB);
    expect(terms().getByTestId("renewal-drawer-vendor-term").textContent).toBe(`Google renews ${formatDate("2027-01-12")}`);
    expect(terms().getByText("At the vendor")).toBeTruthy();
  });
  it("not known → no line", () => {
    show({ ...SUB, vendor_term_end: null });
    expect(screen.queryByTestId("renewal-drawer-vendor-term")).toBeNull();
  });
  it("same as our renewal date → no line", () => {
    show({ ...SUB, vendor_term_end: "2027-03-29" });
    expect(screen.queryByTestId("renewal-drawer-vendor-term")).toBeNull();
  });
  it("passed → says to update it", () => {
    show({ ...SUB, vendor_term_end: "2026-10-01" });
    expect(screen.getByTestId("renewal-drawer-vendor-term").textContent).toMatch(/has passed — update it in Subscriptions → Correct details/);
  });
});
