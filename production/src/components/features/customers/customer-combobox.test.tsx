// @vitest-environment jsdom
//
// R-468: Add lead → Existing customer — the picker sits inside a Sheet (a modal dialog).
// Its list used to portal to <body>, outside the sheet's focus trap, so a click on an
// option closed the list with nothing chosen. It now portals into the dialog it is in.
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/lib/queries/customers", () => ({
  useCustomers: () => ({
    data: [{ id: "c-1", name: "Sharma Traders", contact_email: "amit@sharma.in", contact_name: "Amit", domain: "sharma.in", state: null }],
    isLoading: false,
  }),
}));

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CustomerCombobox } from "./customer-combobox";

beforeAll(() => {
  // Radix popper measures; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("CustomerCombobox inside a Sheet (R-468)", () => {
  it("the list opens inside the sheet's dialog and an option can be picked", () => {
    const onChange = vi.fn();
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Add lead</SheetTitle>
          <CustomerCombobox id="lead-customer" value="" onChange={onChange} placeholder="Search customers…" />
        </SheetContent>
      </Sheet>,
    );
    fireEvent.click(screen.getByText("Search customers…"));
    const option = screen.getByRole("button", { name: /Sharma Traders/ });
    const dialog = screen.getByText("Add lead").closest("[role=dialog]");
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(option)).toBe(true);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("c-1");
  });

  it("outside any dialog the list still portals to the page", () => {
    render(<CustomerCombobox value="" onChange={vi.fn()} placeholder="Pick" />);
    fireEvent.click(screen.getByText("Pick"));
    expect(screen.getByRole("button", { name: /Sharma Traders/ })).toBeTruthy();
  });
});
