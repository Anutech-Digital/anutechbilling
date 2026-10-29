// @vitest-environment jsdom
//
// R-2029 (27 Oct 2026, staging screenshot): the customer picker read
// "JAK GROUP PRIVATE LIMITEDJAK GROUP PRIVATE LIMITED" and on localhost
// "T-J1-21Oct Audit Pvt LtdDelhi". The avatar was handed the FULL name as its
// "initials" (so it printed the name a second time), and the muted second line
// (email / domain / state) ran straight into the name.
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/lib/queries/customers", () => ({
  useCustomers: () => ({
    data: [
      { id: "c-1", name: "JAK GROUP PRIVATE LIMITED", contact_email: null, contact_name: null, domain: null, state: null },
      { id: "c-2", name: "T-J1-21Oct Audit Pvt Ltd", contact_email: null, contact_name: null, domain: null, state: "Delhi" },
    ],
    isLoading: false,
  }),
}));

import { CustomerCombobox } from "./customer-combobox";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("R-2029 customer picker shows each name once, cleanly", () => {
  it("an option's name is not doubled and the extra info is set apart with ' · '", () => {
    render(<CustomerCombobox value="" onChange={vi.fn()} placeholder="Pick" />);
    fireEvent.click(screen.getByText("Pick"));
    const jak = screen.getByRole("button", { name: /JAK GROUP/ });
    expect(jak.textContent).not.toContain("JAK GROUP PRIVATE LIMITEDJAK GROUP PRIVATE LIMITED");
    expect(jak.textContent?.match(/JAK GROUP PRIVATE LIMITED/g)?.length).toBe(1);
    const tj = screen.getByRole("button", { name: /T-J1-21Oct/ });
    expect(tj.textContent).not.toContain("LtdDelhi");
    expect(tj.getAttribute("aria-label")).toBe("T-J1-21Oct Audit Pvt Ltd · Delhi");
  });

  it("the picked customer on the trigger shows the name once", () => {
    render(<CustomerCombobox value="c-1" onChange={vi.fn()} />);
    const trigger = screen.getAllByRole("button")[0];
    expect(trigger.textContent?.match(/JAK GROUP PRIVATE LIMITED/g)?.length).toBe(1);
  });
});
