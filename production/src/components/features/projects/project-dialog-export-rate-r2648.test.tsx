// @vitest-environment jsdom
//
// R-2648 — "New project quotation" / "New project invoice" for a customer abroad started at 18% GST
// (and CGST+SGST unless someone ticked IGST), which R-2636 then issued as an export WITH payment of
// IGST — the foreign buyer usually cannot claim it back. Now: with an LUT for today's FY the rate
// starts at 0% (export without payment) under that LUT; without one it stays 18%, IGST is ticked and a
// plain warning names the FY and the next step (Add LUT). A rate the user typed is never overwritten.
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const lutState = vi.hoisted(() => ({ rows: [] as unknown[], error: false }));
const created = vi.hoisted(() => vi.fn());

const CUSTOMERS = [
  { id: "c-us", name: "Peak Performance LLC", country: "United States", gst_treatment: "overseas", state_code: null, gstin: null },
  { id: "c-dl", name: "Delhi Traders", country: "India", gst_treatment: "registered_regular", state_code: "07", gstin: null },
];

vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/queries/customers", () => ({
  useCustomers: () => ({ data: CUSTOMERS }),
  useCreateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "T1", tenantStateCode: "07" } }) }));
vi.mock("@/lib/queries/tenant-luts", () => ({
  useTenantLuts: (enabled: boolean) => (enabled
    ? (lutState.error ? { isSuccess: false, isError: true, data: undefined } : { isSuccess: true, isError: false, data: lutState.rows })
    : { isSuccess: false, isError: false, data: undefined }),
}));
vi.mock("@/lib/queries/projects", () => {
  const m = () => ({ mutateAsync: async (p: unknown) => { created(p); return "P-1"; }, isPending: false });
  return {
    useCreateProjectQuote: m, useUpdateProjectQuote: m, useUpdateProjectFutureMilestones: m,
    useCreateProjectDirectInvoice: m, useProjectSale: () => ({ data: undefined }),
  };
});

import { CreateProjectQuoteDialog } from "./create-project-quote-dialog";
import { istToday } from "@/lib/dates/ist";
import { fyStartISO, fyBounds, fyLabel } from "@/lib/dates/ist";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => { lutState.rows = []; lutState.error = false; created.mockReset(); });
afterEach(cleanup);

const today = istToday();
const FY = fyLabel(today);
const lutToday = () => ({ fyStart: fyStartISO(today), arn: "AD0704260001234", validFrom: fyStartISO(today), validUpto: fyBounds(today).end });

const rate = () => (document.getElementById("q_gst") as HTMLInputElement).value;
const igst = () => (screen.getByLabelText(/Inter-state \(IGST\)/) as HTMLInputElement).checked;
const pick = (id: string) => fireEvent.change(document.getElementById("q_customer")!, { target: { value: id } });

describe("R-2648 project quotation for a customer abroad", () => {
  it("LUT for today's FY → GST rate starts at 0, IGST ticked, the LUT is named", async () => {
    lutState.rows = [lutToday()];
    render(<CreateProjectQuoteDialog open onOpenChange={() => {}} />);
    pick("c-us");
    await waitFor(() => expect(rate()).toBe("0"));
    expect(igst()).toBe(true);
    expect(screen.getByTestId("export-lut-note").textContent).toContain(`0% GST under LUT AD0704260001234 (FY ${FY})`);
    expect(screen.queryByTestId("export-lut-warning")).toBeNull();
  });

  it("no LUT → stays 18%, IGST ticked, warning names the FY and the Add LUT step", async () => {
    render(<CreateProjectQuoteDialog open onOpenChange={() => {}} />);
    pick("c-us");
    await waitFor(() => expect(screen.getByTestId("export-lut-warning")).toBeTruthy());
    expect(rate()).toBe("18");
    expect(igst()).toBe(true);
    expect(screen.getByTestId("export-lut-warning").textContent).toContain(`No LUT for FY ${FY} on file, so this quote charges 18% IGST`);
    expect(screen.getByRole("link", { name: "Add LUT" }).getAttribute("href")).toBe("/settings?tab=company#lut");
  });

  it("LUT read failed → 18% (never 0% on an unknown)", async () => {
    lutState.error = true;
    render(<CreateProjectQuoteDialog open onOpenChange={() => {}} />);
    pick("c-us");
    await waitFor(() => expect(screen.getByTestId("export-lut-warning")).toBeTruthy());
    expect(rate()).toBe("18");
  });

  it("a rate the user typed is kept when the customer changes", async () => {
    lutState.rows = [lutToday()];
    render(<CreateProjectQuoteDialog open onOpenChange={() => {}} />);
    fireEvent.change(document.getElementById("q_gst")!, { target: { value: "12" } });
    pick("c-us");
    await waitFor(() => expect(igst()).toBe(true));
    expect(rate()).toBe("12");
  });

  it("Indian customer → 18% as before, no LUT words", async () => {
    lutState.rows = [lutToday()];
    render(<CreateProjectQuoteDialog open onOpenChange={() => {}} />);
    pick("c-dl");
    await waitFor(() => expect(rate()).toBe("18"));
    expect(screen.queryByTestId("export-lut-note")).toBeNull();
    expect(screen.queryByTestId("export-lut-warning")).toBeNull();
  });

  it("switching from the customer abroad back to an Indian one → back to 18%", async () => {
    lutState.rows = [lutToday()];
    render(<CreateProjectQuoteDialog open onOpenChange={() => {}} />);
    pick("c-us");
    await waitFor(() => expect(rate()).toBe("0"));
    pick("c-dl");
    await waitFor(() => expect(rate()).toBe("18"));
  });
});
