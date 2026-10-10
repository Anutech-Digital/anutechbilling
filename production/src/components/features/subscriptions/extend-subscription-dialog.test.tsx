// @vitest-environment jsdom
/* R-809 — the Extend term dialog said "the renewal date will advance by 0 months" while the
   custom month box held an invalid count (12). An invalid count now hides that sentence; the
   red error above already says what is wrong. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Subscription } from "@/lib/supabase/database.types";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ExtendSubscriptionDialog from "./extend-subscription-dialog";
import { toast } from "sonner";

afterEach(cleanup);

const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "Test Co",
  plan: "Google Workspace Starter", vendor: "google", seats: 2, used: 0, mrr: 528, status: "active",
  start_date: "2026-09-03", renewal_date: "2027-09-02", term_months: 12, billing_cycle: "yearly",
} as unknown as Subscription;

function openMonths() {
  render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole("radio", { name: "Months" }));
  return screen.getByLabelText("Custom months") as HTMLInputElement;
}

describe("Extend term dialog — advance sentence (R-809)", () => {
  it("invalid custom months (12): no 'advance by 0 months'", () => {
    const input = openMonths();
    fireEvent.change(input, { target: { value: "12" } });
    expect(screen.getByRole("alert").textContent).toMatch(/between 1 and 11/);
    expect(screen.queryByTestId("extend-advance")).toBeNull();
    expect(document.body.textContent).not.toMatch(/advance by/);
  });

  it("valid custom months (5): says the real count", () => {
    const input = openMonths();
    fireEvent.change(input, { target: { value: "5" } });
    expect(screen.getByTestId("extend-advance").textContent).toMatch(/advance by\s*5 months\./);
  });

  it("1 month reads '1 month', not '1 months'", () => {
    const input = openMonths();
    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.getByTestId("extend-advance").textContent).toMatch(/advance by\s*1 month\./);
  });
});

/* R-820 — after "Create extension quote" the page stayed on /subscriptions; Add seats opens
   its quote. The dialog now navigates to /quotes/<id>, before it closes. */
describe("Extend term dialog — opens the new quote (R-820)", () => {
  afterEach(() => { vi.unstubAllGlobals(); nav.push.mockReset(); });

  it("success: navigates to /quotes/<id>, then closes", async () => {
    const calls: string[] = [];
    nav.push.mockImplementation((u: string) => { calls.push(`push ${u}`); });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: true, quoteId: "Q-F588-27-0009", amount: 19541, years: 1, months: 12 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={(v) => { calls.push(`open ${v}`); }} />);
    fireEvent.click(screen.getByRole("button", { name: /Create extension quote/ }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/quotes/Q-F588-27-0009"));
    expect(calls).toEqual(["push /quotes/Q-F588-27-0009", "open false"]);
  });

  it("error: stays put — no navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: "already open" }), { status: 409 },
    )));
    const onOpenChange = vi.fn();
    render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Create extension quote/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("already open"));
    expect(nav.push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
