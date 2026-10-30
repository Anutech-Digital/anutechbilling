// @vitest-environment jsdom
/* R-1963 — on an empty catalogue, "Add my own item" made a licence line (e.g. "Google
   Workspace Business Starter (1 year)", qty 10) with NO commitment; the builder then saved it
   as one_time, so accepting the quote made no subscription and no renewal. The Custom item
   form now asks "Billing" (the builder's own One-time / Monthly flex / Annual (1-yr) choice),
   suggests it from the name, and the picked term is what the line carries. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({ data: [], isLoading: false }),
  useLoadDefaultCatalog: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AddLineItemDialog } from "./add-line-item-dialog";
import { markOneTimeLines } from "@/lib/quotes/line-commit-choice";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const onAdd = vi.fn();
const onOpenChange = vi.fn();

beforeEach(() => {
  onAdd.mockReset(); onOpenChange.mockReset();
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

async function openCustom() {
  render(<AddLineItemDialog open onOpenChange={onOpenChange} onAdd={onAdd} />);
  fireEvent.click(screen.getByRole("button", { name: /Add my own item/ }));
  await waitFor(() => expect(screen.getByLabelText(/Item name/)).toBeTruthy());
}
const billing = () => screen.getByLabelText(/^Billing/) as HTMLSelectElement;
const type = (label: RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
const submit = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Add line" }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
  return onAdd.mock.calls[0][0] as QuoteLineItem;
};

describe("R-1963 Custom item asks how it is billed", () => {
  it("the form shows the Billing choice with the builder's three terms", async () => {
    await openCustom();
    const opts = Array.from(billing().options).map((o) => o.textContent);
    expect(opts).toEqual(["One-time", "Flexible (monthly)", "Annual commitment"]);
  });

  it("a licence name prefills Annual; saved it carries annual_yearly and no one_time", async () => {
    await openCustom();
    type(/Item name/, "Google Workspace Business Starter (1 year)");
    await waitFor(() => expect(billing().value).toBe("annual"));
    type(/Quantity/, "10");
    type(/^Rate/, "3240");
    const line = await submit();
    expect(line.commitment).toBe("annual_yearly");
    expect(line.qty).toBe(10);
    expect(line.rate).toBe(3240); // price untouched: what was typed, per unit per year
    const [saved] = markOneTimeLines([line]);
    expect(saved.one_time).toBeUndefined();
    expect(saved.commitment).toBe("annual_yearly");
  });

  it("the user can change the suggestion (Monthly flex saves monthly)", async () => {
    await openCustom();
    type(/Item name/, "GW Business Starter (1 year)");
    await waitFor(() => expect(billing().value).toBe("annual"));
    fireEvent.change(billing(), { target: { value: "monthly" } });
    type(/Item name/, "GW Business Starter (1 year) x");
    expect(billing().value).toBe("monthly"); // a picked term is not overwritten by typing
    type(/^Rate/, "270");
    const line = await submit();
    expect(line.commitment).toBe("monthly");
  });

  it("plain one-time still works: no commitment, saved as one_time", async () => {
    await openCustom();
    type(/Item name/, "Data migration");
    expect(billing().value).toBe("one_time");
    type(/Quantity/, "1");
    type(/^Rate/, "5000");
    const line = await submit();
    expect(line.commitment).toBeUndefined();
    expect(markOneTimeLines([line])[0].one_time).toBe(true);
  });

  it("choosing One-time for a licence-looking name warns it makes no subscription", async () => {
    await openCustom();
    type(/Item name/, "GW Business Starter (1 year)");
    await waitFor(() => expect(billing().value).toBe("annual"));
    expect(screen.queryByText(/no subscription/i)).toBeNull();
    fireEvent.change(billing(), { target: { value: "one_time" } });
    expect(screen.getByText(/no subscription/i)).toBeTruthy();
  });
});
