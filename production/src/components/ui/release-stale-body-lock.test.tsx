// @vitest-environment jsdom
//
// R-1427 (Pawan, staging 17 + 24 Oct): closing ANY dialog opened from the /leads More menu left
// body at `pointer-events: none` — Filter and lead rows were dead until a reload. The dialog had
// saved "none" as the page's normal value (a modal menu, carried by a second copy of Radix's
// dismissable layer, still held the page when it opened) and put it back on Close.
// The shared ui/dialog and ui/sheet now release such a stale lock once no layer is open.
// These tests use the REAL Radix dialog and sheet.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import * as React from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "./sheet";
import { releaseStaleBodyLock } from "./release-stale-body-lock";

const g = globalThis as unknown as { ResizeObserver?: unknown };
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = "";
  document.body.innerHTML = "";
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A dialog that opens while something else (the "other copy" of the layer) already holds body. */
function OneDialog({ kind }: { kind: "dialog" | "sheet" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      {kind === "dialog" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Import contacts from Google</DialogTitle>
            <DialogDescription>Not available</DialogDescription>
            <button type="button" onClick={() => setOpen(false)}>Close it</button>
          </DialogContent>
        </Dialog>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent>
            <SheetTitle>Lead</SheetTitle>
            <SheetDescription>Details</SheetDescription>
            <button type="button" onClick={() => setOpen(false)}>Close it</button>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** The owner's path in miniature: a foreign modal menu holds body, the dialog opens, the menu goes. */
async function openWithForeignLock() {
  document.body.style.pointerEvents = "none"; // the modal menu (other layer copy) holds the page
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open it" })); });
  expect(await screen.findByRole("dialog")).toBeTruthy();
  document.body.style.pointerEvents = ""; // the menu closed and its copy put back ""
}

describe("R-1427: shared dialog / sheet never leave body frozen after Close", () => {
  it.each(["dialog", "sheet"] as const)("%s: a dialog that saved a stale 'none' does not freeze the page on Close", async (kind) => {
    render(<OneDialog kind={kind} />);
    await openWithForeignLock();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close it" })); });
    await tick();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("does not release the lock while another dialog is still open (closing the inner of two)", async () => {
    function Two() {
      const [inner, setInner] = React.useState(true);
      return (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Outer</DialogTitle>
            <DialogDescription>stays open</DialogDescription>
            <Dialog open={inner} onOpenChange={setInner}>
              <DialogContent>
                <DialogTitle>Inner</DialogTitle>
                <DialogDescription>closes</DialogDescription>
                <button type="button" onClick={() => setInner(false)}>Close inner</button>
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Two />);
    await tick();
    expect(document.body.style.pointerEvents).toBe("none");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close inner" })); });
    await tick();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.body.style.pointerEvents).toBe("none");
  });
});

describe("releaseStaleBodyLock", () => {
  it("clears 'none' when no layer is open", () => {
    document.body.style.pointerEvents = "none";
    expect(releaseStaleBodyLock(document)).toBe(true);
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("keeps 'none' while an open menu / listbox / dialog owns it", () => {
    for (const role of ["menu", "listbox", "dialog", "alertdialog"]) {
      document.body.innerHTML = `<div role="${role}" data-state="open"></div>`;
      document.body.style.pointerEvents = "none";
      expect(releaseStaleBodyLock(document)).toBe(false);
      expect(document.body.style.pointerEvents).toBe("none");
    }
  });

  it("leaves any other body value alone", () => {
    document.body.style.pointerEvents = "auto";
    expect(releaseStaleBodyLock(document)).toBe(false);
    expect(document.body.style.pointerEvents).toBe("auto");
  });
});
