// @vitest-environment jsdom
/* R-1692 — Escape in "Add bank account" while the Bank dropdown is open closes ONLY the dropdown.
   The Select and the Sheet bring two different copies of Radix's dismissable layer
   (react-select pins 1.1.11, react-dialog 1.1.19), so neither knows the other is on top: one
   Escape closed both, and the Select then put `pointer-events: none` back on <body> after the
   Sheet had cleared it — nothing on the page could be clicked, so "Add account" would not open
   again until a reload. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/queries/bank", () => ({
  useCreateBankAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateBankAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

/* jsdom lacks these; Radix Select calls them when it opens. */
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  setPointerCapture: () => {},
  scrollIntoView: () => {},
});

import { AddBankAccountForm } from "./add-bank-account-form";

afterEach(() => { cleanup(); document.body.style.pointerEvents = ""; });

function Harness({ onClosed }: { onClosed: () => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Add account</button>
      <AddBankAccountForm open={open} onOpenChange={(o) => { setOpen(o); if (!o) onClosed(); }} />
    </>
  );
}

describe("Add bank account — Escape with the Bank dropdown open (R-1692)", () => {
  it("closes the dropdown only; the drawer stays open", async () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    const trigger = screen.getByRole("combobox", { name: /bank/i });
    await act(async () => { fireEvent.keyDown(trigger, { key: "Enter" }); });
    expect(screen.getByRole("listbox")).toBeTruthy();

    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByText("Add bank account")).toBeTruthy();
  });

  it("a second Escape (nothing open inside) closes the drawer, and the page stays clickable", async () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    const trigger = screen.getByRole("combobox", { name: /bank/i });
    await act(async () => { fireEvent.keyDown(trigger, { key: "Enter" }); });
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); });
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); });

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});
