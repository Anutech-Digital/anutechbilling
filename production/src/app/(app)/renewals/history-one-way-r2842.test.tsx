// @vitest-environment jsdom
/* R-2842 (Renewals history audit H7): the card layout showed payment history two ways — R-2422's "History"
   popover (last 3 payments) under Last paid, and the drawer's Payments tab. Now ONE way: the card's single
   History button opens the drawer on the Payments tab (?view=payments) when the row has a payment, and the
   popover is gone. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-15" }));
vi.mock("./drawer-data", () => ({ useRenewalDrawerData: () => ({ data: { docs: undefined, paid: undefined, reminders: null }, isLoading: false, isError: false, isSuccess: true }) }));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { drawerViewFromSearch, withDrawerSub } from "./drawer";
import { LastPaidLine } from "./last-paid-cell";
import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";

afterEach(() => { cleanup(); });
const SUB_ID = "a1b2c3d4-0000-4000-8000-000000002842";

describe("R-2842 — ?view=payments next to ?sub=", () => {
  it("is written and read like history; unknown views are still dropped", () => {
    expect(withDrawerSub("/renewals?tab=overdue", SUB_ID, "payments")).toBe(`/renewals?tab=overdue&sub=${SUB_ID}&view=payments`);
    expect(drawerViewFromSearch(`?sub=${SUB_ID}&view=payments`)).toBe("payments");
    expect(drawerViewFromSearch(`?sub=${SUB_ID}&view=history`)).toBe("history");
    expect(drawerViewFromSearch(`?sub=${SUB_ID}&view=x`)).toBeNull();
    expect(drawerViewFromSearch("?view=payments")).toBeNull();
  });
});

describe("R-2842 — Last paid line has no second History", () => {
  const paid = {
    last: { paymentId: "p1", receivedAt: "2026-10-31", amount: 3835, method: "upi", invoiceId: "INV-1", quoteId: null, sharedWith: null },
    history: [] as never[],
  };
  it("shows the last payment and no History popover button", () => {
    render(<LastPaidLine paid={paid as never} loading={false} failed={false} canInvoices canQuotes />);
    expect(screen.getByText(/Last paid/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /History|last 3 payments/i })).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
  });
});

describe("R-2842 — the drawer opened with view=payments lands on the Payments tab", () => {
  const SUB = {
    id: SUB_ID, tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2842 Traders", plan: "Google Workspace Business Standard",
    seats: 5, vendor: "google", item_id: null, term_months: 12, mrr: 1000, term_amount: null, renewal_date: "2026-12-01",
    start_date: "2025-12-01", status: "active", renewal_quote_id: null, quote_id: "Q-1", reminder_count: 0,
  };
  const item: DrawerItem = {
    sub: SUB as never, daysUntil: 17, stage: null, amount: renewalAmount(SUB as never, null), frequency: "Yearly", payHref: null, docs: undefined,
    followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
  };
  it("view=payments selects Payments (focused); history stays on All; no view stays on All", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { unmount } = render(<RenewalDrawer item={item} open view="payments" onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("tab"));
    expect(document.activeElement?.textContent).toMatch(/^Payments/);
    expect(document.activeElement?.getAttribute("data-state")).toBe("active");
    unmount(); cleanup();
    render(<RenewalDrawer item={item} open view="history" onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("tab"));
    expect(document.activeElement?.textContent).toMatch(/^All/);
  });
});

describe("R-2842 wiring", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  const cell = readFileSync("src/app/(app)/renewals/last-paid-cell.tsx", "utf8");
  it("the popover is deleted; each card layout keeps ONE History button, opening Payments when there is a payment", () => {
    expect(cell).not.toMatch(/Popover/);
    expect(cell).not.toMatch(/Show the last 3 payments/);
    expect(page.match(/<HistoryButton /g)).toHaveLength(2);
    expect(page).toMatch(/onOpen\(sub\.id, lastPaid\.data\?\.get\(sub\.id\) \? "payments" : "history"\)/);
    expect(page).toMatch(/onOpen\(sub\.id, "history"\)/);
  });
});
