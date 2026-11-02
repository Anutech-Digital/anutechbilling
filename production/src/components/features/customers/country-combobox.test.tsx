// @vitest-environment jsdom
//
// R-2180: the customer Country picker is searchable — type "Est" and pick Estonia — and it
// works inside a dialog (Add customer from bank reconcile).
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CountryCombobox } from "./country-combobox";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(cleanup);

describe("CountryCombobox (R-2180)", () => {
  it('type "Est" → Estonia is offered; clicking it picks Estonia', () => {
    const onChange = vi.fn();
    render(<CountryCombobox id="country" value="India" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search countries" }), { target: { value: "Est" } });
    fireEvent.click(screen.getByRole("option", { name: "Estonia" }));
    expect(onChange).toHaveBeenCalledWith("Estonia");
  });

  it("Enter picks the first match (keyboard only)", () => {
    const onChange = vi.fn();
    render(<CountryCombobox id="country" value="India" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    const search = screen.getByRole("searchbox", { name: "Search countries" });
    fireEvent.change(search, { target: { value: "cayman" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("Cayman Islands");
  });

  it("shows the saved value as it is, even one not in the list", () => {
    render(<CountryCombobox id="country" value="Atlantis" onChange={() => {}} />);
    expect(screen.getByRole("combobox").textContent).toContain("Atlantis");
  });

  it("inside a dialog, the list opens inside it and can be picked", () => {
    const onChange = vi.fn();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Add customer</DialogTitle>
          <CountryCombobox id="country" value="India" onChange={onChange} />
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search countries" }), { target: { value: "Est" } });
    const option = screen.getByRole("option", { name: "Estonia" });
    expect(screen.getByText("Add customer").closest("[role=dialog]")?.contains(option)).toBe(true);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("Estonia");
  });
});
