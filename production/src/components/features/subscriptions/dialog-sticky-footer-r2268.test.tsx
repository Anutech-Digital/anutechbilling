// @vitest-environment jsdom
/* R-2268 (design audit D8): "Save always visible". The owner had to scroll to find Save in
   Manage seats and Correct details, because the whole dialog scrolled — footer included.
   Now the dialog box itself does not scroll: its body does, and the footer (Cancel + the primary
   action) sits under the body, outside the scroll, so it is always on screen.
   Labels, disabled rules and the Cancel → primary keyboard order are unchanged. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { Subscription } from "@/lib/supabase/database.types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries/customers", () => ({ useCustomer: () => ({ data: null }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: "owner", tenantStateCode: "07", tenantGstin: null } }),
}));
vi.mock("./use-expected-seat-rate", () => ({ useExpectedSeatRate: () => ({ data: null }) }));
vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionTerms: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionData: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionCommitment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionDetails: () => ({ mutateAsync: vi.fn(), isPending: false }),  // R-2545: the one save
  useScheduleInvoices: () => ({ data: { sale: null, instalments: [], renewals: [], addSeats: [] } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-11-01",
}));

import AddSeatsDialog from "./add-seats-dialog";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";

afterEach(cleanup);

const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "E2E Test Co", domain: "e2etest.com",
  plan: "Google Workspace Business Standard", vendor: "google", seats: 15, used: 0, mrr: 16_200, status: "active",
  start_date: "2026-10-01", renewal_date: "2027-09-30", term_months: 12, billing_cycle: "yearly",
  item_id: null, quote_id: "Q-1", renewal_quote_id: null,
} as unknown as Subscription;

const cls = (el: Element) => el.className.split(/\s+/);

/** The footer is outside the scrolling body, the body scrolls, the box itself does not. */
function expectStickyFooter(primaryName: RegExp) {
  const footer = screen.getByTestId("dialog-sticky-footer");
  const body = screen.getByTestId("dialog-scroll-body");
  const box = screen.getByRole("dialog");

  const primary = screen.getByRole("button", { name: primaryName });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(footer.contains(primary)).toBe(true);
  expect(footer.contains(cancel)).toBe(true);

  expect(body.contains(footer)).toBe(false);
  expect(footer.parentElement).toBe(box);
  expect(body.parentElement).toBe(box);
  expect(cls(body)).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]));
  expect(cls(footer)).toEqual(expect.arrayContaining(["shrink-0", "border-t", "bg-paper"]));
  expect(cls(box)).toEqual(expect.arrayContaining(["flex", "flex-col", "overflow-hidden"]));
  expect(cls(box)).not.toContain("overflow-y-auto");

  // Keyboard order unchanged: Cancel, then the primary — both reachable by Tab.
  expect(cancel.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(primary.getAttribute("tabindex")).not.toBe("-1");
}

describe("R-2268: Save always visible — sticky footer", () => {
  it("Manage seats: Add N seats + Cancel sit in the footer, outside the scrolling body", () => {
    render(<AddSeatsDialog sub={sub} open onOpenChange={() => {}} />);
    expectStickyFooter(/^Add 1 seat$/);
  });

  it("Correct details: Save changes + Cancel sit in the footer, outside the scrolling body", () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    expectStickyFooter(/^Save changes$/);
  });
});
