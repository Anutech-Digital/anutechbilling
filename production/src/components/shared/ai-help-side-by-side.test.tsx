// @vitest-environment jsdom
/**
 * R-827 — AI Help works side by side with the page and with an open dialog.
 *  - a click / focus / Escape inside help never closes the shared Dialog;
 *  - focus can move into help while a dialog is open (the dialog's focus trap does not pull it back),
 *    and back into the dialog to type;
 *  - Minimize folds help to a small bar and "Open help" brings it back with the chat intact;
 *  - dialogs centre left of the docked panel only when there is room.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/subscriptions", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import * as React from "react";
import { AiHelp, AiHelpButton, helpDockWidth, DIALOG_ROOM } from "./ai-help";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { isInHelpPanel, keepOpenForHelp, HELP_PANEL_SELECTOR } from "@/components/ui/help-panel-guard";
import { HELP_SELF } from "./help-shot";

beforeEach(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear() },
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  /* put the shared help store back to closed */
  const bar = screen.queryByRole("button", { name: "Close help", hidden: true });
  if (bar) fireEvent.click(bar);
  const btn = screen.queryByRole("button", { name: /^Help —/, hidden: true });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
});

function OnboardDialog({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>1-Click Onboard Subscription</DialogTitle>
        <DialogDescription>Add a customer and subscription.</DialogDescription>
        <label htmlFor="contact">Contact Person</label>
        <input id="contact" />
      </DialogContent>
    </Dialog>
  );
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("help-panel guard", () => {
  it("uses the same root selector as the help panel", () => {
    expect(HELP_PANEL_SELECTOR).toBe(HELP_SELF);
  });

  it("keepOpenForHelp cancels outside events from help (also Radix CustomEvents) and runs the caller's handler", () => {
    const help = document.createElement("div");
    help.setAttribute("data-ai-help", "");
    const inner = document.createElement("button");
    help.appendChild(inner);
    const page = document.createElement("button");
    document.body.append(help, page);
    expect(isInHelpPanel(inner)).toBe(true);
    expect(isInHelpPanel(page)).toBe(false);

    const own = vi.fn();
    const guard = keepOpenForHelp(own);
    const fromHelp = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: inner } } });
    guard(fromHelp);
    expect(fromHelp.defaultPrevented).toBe(true);
    const fromPage = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: page } } });
    guard(fromPage);
    expect(fromPage.defaultPrevented).toBe(false);
    expect(own).toHaveBeenCalledTimes(2);
    help.remove(); page.remove();
  });
});

describe("AI Help with a dialog open (R-827)", () => {
  it("clicking and typing in help does not close the dialog; focus stays where the person puts it", async () => {
    const onOpenChange = vi.fn();
    render(<><AiHelpButton /><AiHelp /><OnboardDialog onOpenChange={onOpenChange} /></>);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Help —/, hidden: true }));
    await flush();

    const helpRoot = document.querySelector(HELP_PANEL_SELECTOR) as HTMLElement;
    expect(helpRoot.style.pointerEvents).toBe("auto");

    const box = screen.getByLabelText("Your question") as HTMLTextAreaElement;
    /* pointer-down inside help: Radix would treat it as "outside" the dialog */
    fireEvent.pointerDown(box);
    fireEvent.mouseDown(box);
    act(() => { box.focus(); });
    await flush();
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "How do I fill Billing Period?" } });
    expect(box.value).toBe("How do I fill Billing Period?");
    fireEvent.keyDown(box, { key: "Escape" });
    await flush();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    /* back into the dialog: typing works */
    const contact = screen.getByLabelText("Contact Person") as HTMLInputElement;
    act(() => { contact.focus(); });
    fireEvent.change(contact, { target: { value: "Ravi" } });
    expect(document.activeElement).toBe(contact);
    expect(contact.value).toBe("Ravi");

    /* and back into help again — still not pulled back */
    act(() => { box.focus(); });
    await flush();
    expect(document.activeElement).toBe(box);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a pointer-down on the page outside both still closes the dialog (normal behaviour kept)", async () => {
    const onOpenChange = vi.fn();
    render(<><button type="button">Page button</button><AiHelp /><OnboardDialog onOpenChange={onOpenChange} /></>);
    await flush();
    fireEvent.pointerDown(screen.getByText("Page button"));
    await flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Minimize (R-827)", () => {
  it("folds help to a small bar and Open help restores it with the chat intact", async () => {
    render(<><AiHelpButton /><AiHelp /></>);
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    const box = screen.getByLabelText("Your question") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "half typed question" } });

    fireEvent.click(screen.getByRole("button", { name: "Minimize help" }));
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    expect(screen.getByRole("region", { name: "Help (minimized)" })).toBeTruthy();
    /* the top-bar icon shows help as not open, and pressing it restores */
    expect(screen.getByRole("button", { name: /^Help —/ }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Open help" }));
    expect(screen.getByRole("dialog", { name: "Help" })).toBeTruthy();
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("half typed question");
    expect(screen.queryByRole("region", { name: "Help (minimized)" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Minimize help" }));
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    expect(screen.getByRole("dialog", { name: "Help" })).toBeTruthy();
  });

  it("Minimize is offered on a phone too (not desktop-only) and the panel is docked right on desktop", () => {
    render(<><AiHelpButton /><AiHelp /></>);
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    expect(screen.getByRole("button", { name: "Minimize help" }).className).not.toMatch(/\bhidden\b/);
    const cls = screen.getByRole("dialog", { name: "Help" }).className.split(/\s+/);
    expect(cls).toContain("md:right-0");
    expect(cls).toContain("z-[65]");
  });

  it("sets --ai-help-dock while shown on a wide screen, clears it when minimized or closed", () => {
    const root = document.documentElement;
    render(<><AiHelpButton /><AiHelp /></>);
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    expect(root.style.getPropertyValue("--ai-help-dock")).toBe("420px");
    fireEvent.click(screen.getByRole("button", { name: "Minimize help" }));
    expect(root.style.getPropertyValue("--ai-help-dock")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Close help" }));
    expect(root.style.getPropertyValue("--ai-help-dock")).toBe("");
  });
});

describe("helpDockWidth", () => {
  it("shifts dialogs only when a dialog still fits left of the panel", () => {
    expect(helpDockWidth(420, 1440)).toBe(420);
    expect(helpDockWidth(420, 420 + DIALOG_ROOM)).toBe(420);
    expect(helpDockWidth(420, 420 + DIALOG_ROOM - 1)).toBe(0);
    expect(helpDockWidth(840, 1280)).toBe(0);
    expect(helpDockWidth(360, 700)).toBe(0); /* phone/tablet: dialog stays centred */
  });
});

void React;
