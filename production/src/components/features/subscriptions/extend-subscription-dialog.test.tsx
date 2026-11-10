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
/* R-1532: the dialog reads the business's GST registration (Bill of Supply → no GST). */
const gst = vi.hoisted(() => ({ saved: null as string | null }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: gst.saved } }) }));

/* R-2648: the dialog reads the customer (country) and the company's LUTs. */
const r2648 = vi.hoisted(() => ({ customer: null as Record<string, unknown> | null, luts: [] as unknown[] }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: r2648.customer ? [r2648.customer] : [] }) }));
vi.mock("@/lib/queries/tenant-luts", () => ({
  useTenantLuts: (enabled: boolean) => (enabled ? { isSuccess: true, isError: false, data: r2648.luts } : { isSuccess: false, isError: false, data: undefined }),
}));

import ExtendSubscriptionDialog from "./extend-subscription-dialog";
import { istToday, fyStartISO, fyBounds, fyLabel } from "@/lib/dates/ist";
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

describe("Extend term dialog — Bill of Supply business (R-1532)", () => {
  it("not registered: no GST row, total = subtotal, the Bill of Supply line instead", () => {
    gst.saved = "unregistered";
    try {
      render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
      const t = document.body.textContent ?? "";
      expect(t).toContain("No GST — Bill of Supply (your business is not GST-registered)");
      expect(t).not.toContain("GST 18%");
      expect(t).not.toContain("Total (incl GST)");
    } finally {
      gst.saved = null;
    }
  });

  it("registered (not chosen): GST 18% as before", () => {
    render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    expect(document.body.textContent).toContain("GST 18%");
  });
});

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

describe("Extend term dialog — customer abroad (R-2648)", () => {
  const today = istToday();
  afterEach(() => { r2648.customer = null; r2648.luts = []; });

  it("LUT for today's FY → GST 0%, total = subtotal, the LUT named (same rate the server saves)", () => {
    r2648.customer = { id: "c1", country: "United States", gst_treatment: "overseas" };
    r2648.luts = [{ fyStart: fyStartISO(today), arn: "AD0704260001234", validFrom: fyStartISO(today), validUpto: fyBounds(today).end }];
    render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    const t = document.body.textContent ?? "";
    expect(t).toContain("GST 0%");
    expect(t).not.toContain("GST 18%");
    expect(screen.getByTestId("export-lut-note").textContent).toContain("0% GST under LUT AD0704260001234");
  });

  it("no LUT → GST 18% as before + the add-LUT warning", () => {
    r2648.customer = { id: "c1", country: "United States", gst_treatment: "overseas" };
    render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    expect(document.body.textContent).toContain("GST 18%");
    expect(screen.getByTestId("export-lut-warning").textContent).toContain(`No LUT for FY ${fyLabel(today)} on file, so this quote charges 18% IGST`);
    expect(screen.getByRole("link", { name: "Add LUT" }).getAttribute("target")).toBe("_blank");
  });
});
