// @vitest-environment jsdom
/* R-2386 — Private Vault → Banking → "New account": picking the Type with the MOUSE closed the
   whole dialog (keyboard worked). A Select / Popover / Combobox opened from a dialog renders
   its list in a PORTAL at the end of <body> — outside the dialog's DOM box — so when Radix
   reports a pointer-down there as "outside" (a portal that is not a React child of the
   dialog, a layer stack that lost track of it, or a press reported only after the list was
   removed), the dialog closed with the pick. The shared dialog now treats a press inside any
   portalled popover list as inside. A real click on the overlay still closes it. */
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { isInPortalledPopover } from "./help-panel-guard";

Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {}, setPointerCapture: () => {}, scrollIntoView: () => {} });
afterEach(() => { cleanup(); document.body.style.pointerEvents = ""; document.querySelectorAll("[data-test-popover]").forEach((n) => n.remove()); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

function Harness({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); onOpenChange(v); }}>
      <DialogContent><DialogTitle>New account</DialogTitle><p>form</p></DialogContent>
    </Dialog>
  );
}

/** A popover list portalled to <body> by someone else (not a React child of the dialog). */
function portalledList(attr: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.setAttribute(attr, "");
  wrap.setAttribute("data-test-popover", "");
  const item = document.createElement("div");
  item.setAttribute("role", "option");
  item.textContent = "Cash";
  wrap.appendChild(item);
  document.body.appendChild(wrap);
  return item;
}

it("a mouse press on an option in a portalled Select list does not close the dialog", async () => {
  const onOpenChange = vi.fn();
  render(<Harness onOpenChange={onOpenChange} />);
  await settle();
  const option = portalledList("data-radix-popper-content-wrapper");
  await act(async () => { fireEvent.pointerDown(option, { button: 0 }); });
  await settle();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
});

it("same for an item-aligned Select (viewport, no popper wrapper)", async () => {
  const onOpenChange = vi.fn();
  render(<Harness onOpenChange={onOpenChange} />);
  await settle();
  const option = portalledList("data-radix-select-viewport");
  await act(async () => { fireEvent.pointerDown(option, { button: 0 }); });
  await settle();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("a press on the page outside (not a popover) still closes the dialog", async () => {
  const onOpenChange = vi.fn();
  render(<Harness onOpenChange={onOpenChange} />);
  await settle();
  const outside = document.createElement("div");
  outside.setAttribute("data-test-popover", "");
  document.body.appendChild(outside);
  await act(async () => { fireEvent.pointerDown(outside, { button: 0 }); });
  await settle();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("isInPortalledPopover: inside a list yes, a plain element no, a list item removed after the press yes", () => {
  const item = portalledList("data-radix-popper-content-wrapper");
  expect(isInPortalledPopover(item)).toBe(true);
  expect(isInPortalledPopover(document.body)).toBe(false);
  // The pick closes the list and removes it before a deferred "outside" report arrives.
  fireEvent.pointerDown(item);
  item.parentElement?.remove();
  expect(isInPortalledPopover(item)).toBe(true);
});

it("Escape still closes the dialog (the popover rule is for outside presses only)", async () => {
  const onOpenChange = vi.fn();
  render(<Harness onOpenChange={onOpenChange} />);
  await settle();
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
