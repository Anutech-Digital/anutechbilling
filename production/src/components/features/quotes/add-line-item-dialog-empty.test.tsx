// @vitest-environment jsdom
/* R-1928 — an empty catalogue no longer dead-ends the "Add line item" picker. The empty
   state offers "Load standard price list" (the existing useLoadDefaultCatalog hook, not a
   new loader) and "Add my own item" (the Custom item tab). After loading, the plans are
   listed and can be picked; the dialog stays open, so the quote being typed is untouched. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

type Row = { id: string; name: string; vendor: string; kind: string; msrp: number; wholesale: number; margin_pct: number; item_type: string; prices: null };

/* A tiny store standing in for the ["items"] query: the load hook writes to it the way the
   real one invalidates ["items"], and useItems re-renders from it. */
let catalog: Row[] = [];
const listeners = new Set<() => void>();
const setCatalog = (rows: Row[]) => { catalog = rows; listeners.forEach((l) => l()); };
const loaded: Row[] = [
  { id: "GWS-STARTER-t1", name: "Google Workspace Business Starter", vendor: "google", kind: "plan", msrp: 270, wholesale: 110, margin_pct: 59, item_type: "subscription", prices: null },
];
const mutate = vi.fn(() => setCatalog(loaded));

vi.mock("@/lib/queries/items", () => ({
  useItems: () => {
    const data = React.useSyncExternalStore(
      (l) => { listeners.add(l); return () => listeners.delete(l); },
      () => catalog,
    );
    return { data, isLoading: false };
  },
  useLoadDefaultCatalog: () => ({ mutate, isPending: false }),
}));

import { AddLineItemDialog } from "./add-line-item-dialog";

const onAdd = vi.fn();
const onOpenChange = vi.fn();
const renderIt = () => render(<AddLineItemDialog open onOpenChange={onOpenChange} onAdd={onAdd} />);

beforeEach(() => {
  catalog = []; mutate.mockClear(); onAdd.mockReset(); onOpenChange.mockReset();
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("R-1928 empty catalogue picker", () => {
  it("shows both buttons and no developer wording", () => {
    renderIt();
    expect(screen.getByRole("button", { name: /Load standard price list/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add my own item/ })).toBeTruthy();
    expect(screen.queryByText(/\/items page/)).toBeNull();
  });

  it("Load calls the existing hook, then the plans are listed and can be picked", async () => {
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: /Load standard price list/ }));
    expect(mutate).toHaveBeenCalledTimes(1);

    const row = await screen.findByText("Google Workspace Business Starter");
    // Loading does not close the dialog — the quote underneath is left as it was.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(row);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ item_id: "GWS-STARTER-t1", name: "Google Workspace Business Starter" }));
  });

  it("Add my own item opens the Custom item tab", async () => {
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: /Add my own item/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Custom item" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByLabelText(/Item name/)).toBeTruthy();
  });
});
