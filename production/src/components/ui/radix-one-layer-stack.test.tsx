// @vitest-environment jsdom
/* R-1822 — with ONE copy of Radix's dismissable-layer / focus-scope, a dropdown inside a
   drawer and a dialog opened from a dropdown share one layer stack, with NO per-screen
   workaround: Esc closes only the top layer, and closing never leaves body pointer-events:none.
   With the old two copies (select/menu 1.1.11 vs dialog 1.1.19) the two focus traps fought
   and this file overflowed the stack in jsdom. tests/radix-single-copy.test.ts guards the
   lockfile itself. */
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle } from "./sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {}, setPointerCapture: () => {}, scrollIntoView: () => {} });
afterEach(() => { cleanup(); document.body.style.pointerEvents = ""; });
const esc = async () => { await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }); }); };
it("plain Select in Sheet: Esc closes only the Select", async () => {
  const onOpenChange = vi.fn();
  function H() {
    const [o, setO] = React.useState(true);
    return (<Sheet open={o} onOpenChange={(v) => { setO(v); onOpenChange(v); }}><SheetContent><SheetTitle>S</SheetTitle>
      <Select><SelectTrigger aria-label="bank"><SelectValue placeholder="x" /></SelectTrigger>
      <SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select></SheetContent></Sheet>);
  }
  render(<H />);
  await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }); });
  expect(screen.getByRole("listbox")).toBeTruthy();
  await esc();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onOpenChange).not.toHaveBeenCalled();
  await esc();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(document.body.style.pointerEvents).not.toBe("none");
});
it("modal DropdownMenu opens a Dialog; closing it leaves body clickable", async () => {
  function H() {
    const [d, setD] = React.useState(false);
    return (<>
      <DropdownMenu><DropdownMenuTrigger>menu</DropdownMenuTrigger><DropdownMenuContent>
        <DropdownMenuItem onSelect={() => setD(true)}>Edit</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <Dialog open={d} onOpenChange={setD}><DialogContent><DialogTitle>D</DialogTitle></DialogContent></Dialog></>);
  }
  render(<H />);
  await act(async () => { fireEvent.keyDown(screen.getByText("menu"), { key: "Enter" }); });
  await act(async () => { fireEvent.click(screen.getByText("Edit")); });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await esc();
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
});
