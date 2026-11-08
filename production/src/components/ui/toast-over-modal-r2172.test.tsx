// @vitest-environment jsdom
/* R-2172 — error toasts were "behind" open dialogs/drawers app-wide (R-2168 Sandbox dialog,
   R-2095b reconcile drawer). A Radix modal (ui/dialog, ui/sheet) sets body to
   `pointer-events: none`; the toaster sits in <body> outside the modal and inherited it, so a
   click went through the toast to the overlay — the toast could not be closed or used, and the
   click shut the dialog. The fix is in the shared layer: ui/toaster turns pointer events back
   on for itself, and ui/dialog + ui/sheet treat a press on a toast as inside. The browser proof
   (real clicks, layer order) is e2e/cards/R-2172.spec.ts. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetTitle } from "./sheet";
import { Toaster, toast } from "./toaster";
import { isInToaster } from "./help-panel-guard";

Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {}, setPointerCapture: () => {}, scrollIntoView: () => {} });
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  });
}
afterEach(() => { act(() => { toast.dismiss(); }); cleanup(); document.body.style.pointerEvents = ""; });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

function DialogHarness({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); onOpenChange(v); }}>
        <DialogContent><DialogTitle>GSTIN verification</DialogTitle><p>form</p></DialogContent>
      </Dialog>
      <Toaster />
    </>
  );
}

function SheetHarness({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <Sheet open={open} onOpenChange={(v) => { setOpen(v); onOpenChange(v); }}>
        <SheetContent><SheetTitle>Quick add</SheetTitle><p>form</p></SheetContent>
      </Sheet>
      <Toaster />
    </>
  );
}

async function raiseError(): Promise<HTMLElement> {
  act(() => { toast.error("Save refused", { action: { label: "Open Settings", onClick: () => {} } }); });
  await settle();
  const el = (await screen.findByText("Save refused")).closest("[data-sonner-toast]") as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe.each([
  ["ui/dialog", DialogHarness],
  ["ui/sheet", SheetHarness],
])("R-2172 — an error toast over an open %s", (_name, Harness) => {
  it("the modal really locks body (the condition the toast must survive)", async () => {
    render(<Harness onOpenChange={vi.fn()} />);
    await settle();
    expect(document.body.style.pointerEvents).toBe("none");
  });

  it("the toaster turns pointer events back on for itself, so the toast takes clicks", async () => {
    render(<Harness onOpenChange={vi.fn()} />);
    await settle();
    const toastEl = await raiseError();
    const toaster = toastEl.closest("[data-sonner-toaster]") as HTMLElement;
    expect(toaster.style.pointerEvents).toBe("auto");
    // Nothing between the toast and the toaster turns it off again.
    for (let n: HTMLElement | null = toastEl; n && n !== toaster; n = n.parentElement) {
      expect(n.style.pointerEvents).not.toBe("none");
    }
  });

  it("pressing the toast's ✕ and its action does not close the dialog/sheet", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await settle();
    const toastEl = await raiseError();
    const action = screen.getByRole("button", { name: "Open Settings" });
    await act(async () => { fireEvent.pointerDown(action, { button: 0 }); fireEvent.focus(action); });
    await settle();
    const close = toastEl.querySelector("[data-close-button]") as HTMLElement;
    await act(async () => { fireEvent.pointerDown(close, { button: 0 }); });
    await settle();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  it("a press on the page outside (not a toast) still closes it", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await settle();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    await act(async () => { fireEvent.pointerDown(outside, { button: 0 }); });
    await settle();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    outside.remove();
  });
});

it("ui/sheet: a pick in a portalled Select list no longer closes the drawer (same chain as ui/dialog, R-2386)", async () => {
  const onOpenChange = vi.fn();
  render(<SheetHarness onOpenChange={onOpenChange} />);
  await settle();
  const list = document.createElement("div");
  list.setAttribute("data-radix-popper-content-wrapper", "");
  const option = document.createElement("div");
  option.setAttribute("role", "option");
  list.appendChild(option);
  document.body.appendChild(list);
  await act(async () => { fireEvent.pointerDown(option, { button: 0 }); });
  await settle();
  expect(onOpenChange).not.toHaveBeenCalled();
  list.remove();
});

it("isInToaster: inside the toaster yes, a plain element no, a toast removed after the press yes", () => {
  const toaster = document.createElement("ol");
  toaster.setAttribute("data-sonner-toaster", "");
  const btn = document.createElement("button");
  toaster.appendChild(btn);
  document.body.appendChild(toaster);
  expect(isInToaster(btn)).toBe(true);
  expect(isInToaster(document.body)).toBe(false);
  fireEvent.pointerDown(btn);
  toaster.remove();
  expect(isInToaster(btn)).toBe(true);
  expect(isInToaster(null)).toBe(false);
});
