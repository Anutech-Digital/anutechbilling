// @vitest-environment jsdom
//
// R-2648 — "New project sale" (Projects → New project): a customer abroad started at 18% GST. With an
// LUT for today's FY it now starts at 0% (export without payment) and IGST; without one it stays 18%,
// IGST, with the Add-LUT warning. A rate the user typed is kept.
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const lutState = vi.hoisted(() => ({ rows: [] as unknown[] }));
const CUSTOMERS = [
  { id: "c-us", name: "Peak Performance LLC", country: "United States", gst_treatment: "overseas", state_code: null, gstin: null, state: null },
  { id: "c-dl", name: "Delhi Traders", country: "India", gst_treatment: "registered_regular", state_code: "07", gstin: null, state: "Delhi" },
];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: CUSTOMERS }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "T1", tenantStateCode: "07" } }) }));
vi.mock("@/lib/queries/tenant-luts", () => ({
  useTenantLuts: (enabled: boolean) => (enabled ? { isSuccess: true, isError: false, data: lutState.rows } : { isSuccess: false, isError: false, data: undefined }),
}));
vi.mock("@/lib/queries/projects", () => ({ useCreateProjectSale: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({ AddCustomerForm: () => null }));
vi.mock("@/components/features/customers/customer-combobox", () => ({
  CustomerCombobox: ({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {CUSTOMERS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  ),
}));

import { CreateProjectDialog } from "./create-project-dialog";
import { istToday, fyStartISO, fyBounds, fyLabel } from "@/lib/dates/ist";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => { lutState.rows = []; });
afterEach(cleanup);

const today = istToday();
const lutToday = () => ({ fyStart: fyStartISO(today), arn: "AD0704260001234", validFrom: fyStartISO(today), validUpto: fyBounds(today).end });
const rate = () => (document.getElementById("p_gst") as HTMLInputElement).value;
const igst = () => (screen.getByLabelText(/Inter-state supply/) as HTMLInputElement).checked;
const pick = (id: string) => fireEvent.change(document.getElementById("p_customer")!, { target: { value: id } });

describe("R-2648 project sale for a customer abroad", () => {
  it("LUT for today's FY → 0%, IGST, the LUT named", async () => {
    lutState.rows = [lutToday()];
    render(<CreateProjectDialog open onOpenChange={() => {}} />);
    pick("c-us");
    await waitFor(() => expect(rate()).toBe("0"));
    expect(igst()).toBe(true);
    expect(screen.getByTestId("export-lut-note").textContent).toContain("0% GST under LUT AD0704260001234");
  });

  it("no LUT → 18%, IGST, warning with Add LUT", async () => {
    render(<CreateProjectDialog open onOpenChange={() => {}} />);
    pick("c-us");
    await waitFor(() => expect(screen.getByTestId("export-lut-warning")).toBeTruthy());
    expect(rate()).toBe("18");
    expect(igst()).toBe(true);
    expect(screen.getByTestId("export-lut-warning").textContent).toContain(`No LUT for FY ${fyLabel(today)} on file`);
  });

  it("typed rate kept; Indian customer stays 18% with no LUT words", async () => {
    lutState.rows = [lutToday()];
    render(<CreateProjectDialog open onOpenChange={() => {}} />);
    fireEvent.change(document.getElementById("p_gst")!, { target: { value: "5" } });
    pick("c-us");
    await waitFor(() => expect(igst()).toBe(true));
    expect(rate()).toBe("5");
    cleanup();
    render(<CreateProjectDialog open onOpenChange={() => {}} />);
    pick("c-dl");
    await waitFor(() => expect(rate()).toBe("18"));
    expect(screen.queryByTestId("export-lut-warning")).toBeNull();
    expect(screen.queryByTestId("export-lut-note")).toBeNull();
  });
});
