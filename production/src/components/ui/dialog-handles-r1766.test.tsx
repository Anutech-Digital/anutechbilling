// @vitest-environment jsdom
/**
 * R-1766 — the invisible resize handles of a dialog must sit on the dialog's real edges.
 *
 * Owner (22 Oct, localhost, Settings → Integrations → Import from Zoho): a MOUSE click on
 * "Undo import" did nothing; Enter on the same button worked. Measured in Chromium: the
 * handle overlay was measured once while the dialog was still zooming in (scale 95%,
 * "Checking…" content) and never again, so its TOP edge strip — 6px tall, catching
 * pointer-down to start a resize — lay across the middle of the finished dialog, right on
 * the Undo import button. The click went to the strip, never to the button.
 * Fix: measure again when the open animation ends (and whenever the dialog moves/resizes).
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The dialog box as the browser reports it: first mid-animation (scaled), then final. */
let rect = { left: 336, top: 303, width: 608, height: 202 };
function mockRect() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("role") === "dialog") {
      return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) } as DOMRect;
    }
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}
const overlay = () => document.querySelector<HTMLElement>("div.fixed.pointer-events-none")!;

describe("R-1766: dialog resize handles follow the finished dialog", () => {
  it("measured mid-animation, the handles move to the real box when the open animation ends", async () => {
    rect = { left: 336, top: 303, width: 608, height: 202 };
    mockRect();
    render(
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>T-Import from Zoho Books</DialogTitle>
          <DialogDescription>T-desc</DialogDescription>
          <button type="button">Undo import</button>
        </DialogContent>
      </Dialog>,
    );
    expect(overlay().style.top).toBe("303px");

    /* Animation over: the dialog is full size and taller (the import result loaded). */
    rect = { left: 320, top: 116, width: 640, height: 569 };
    await act(async () => { fireEvent.animationEnd(screen.getByRole("dialog")); });

    expect(overlay().style.top).toBe("116px");
    expect(overlay().style.height).toBe("569px");
    expect(overlay().style.width).toBe("640px");
  });
});
