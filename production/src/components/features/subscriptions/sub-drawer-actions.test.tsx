// @vitest-environment jsdom
// R-1727 (owner journey audit 21 Oct, T-J1 subscription drawer): Actions sat at the very
// bottom, after the billing schedule and late fees, and the only filled button there was a
// red "Cancel subscription" — the most dangerous act was the brightest. Owner expects:
// "Manage seats" on top as the main (amber) button; Cancel at the bottom, red outline only.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { SubDrawerActions, SubDrawerDangerZone } from "./sub-drawer-actions";

afterEach(cleanup);

const noop = () => {};
const handlers = { onManageSeats: noop, onExtend: noop, onOpenCustomer: noop, onStatement: noop, onCorrect: noop };

describe("R-1727 drawer actions — the everyday job first", () => {
  it("Manage seats is the primary (amber) button; the rest are secondary", () => {
    render(<SubDrawerActions hasCustomer primary {...handlers} />);
    const seats = screen.getByRole("button", { name: /Manage seats/ });
    expect(seats.className).toMatch(/\bbg-amber\b/);
    for (const name of [/Extend term/, /Statement/, /Open customer/, /Correct details/]) {
      const b = screen.getByRole("button", { name });
      expect(b.className).not.toMatch(/\bbg-amber\b|\bbg-rose\b/);
    }
  });

  it("no customer → no Open customer / Statement (never a dead button)", () => {
    render(<SubDrawerActions hasCustomer={false} primary {...handlers} />);
    expect(screen.queryByRole("button", { name: /Open customer/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Statement/ })).toBeNull();
  });

  it("when a leak fix is already the primary on screen, Manage seats steps down", () => {
    render(<SubDrawerActions hasCustomer primary={false} {...handlers} />);
    expect(screen.getByRole("button", { name: /Manage seats/ }).className).not.toMatch(/\bbg-amber\b/);
  });

  it("clicking Manage seats calls its handler", () => {
    const onManageSeats = vi.fn();
    render(<SubDrawerActions hasCustomer primary {...handlers} onManageSeats={onManageSeats} />);
    fireEvent.click(screen.getByRole("button", { name: /Manage seats/ }));
    expect(onManageSeats).toHaveBeenCalledOnce();
  });
});

describe("R-1727 danger zone — never the filled primary", () => {
  it("Cancel subscription and Delete are red OUTLINE, not filled", () => {
    render(<SubDrawerDangerZone cancelledNote={null} canDelete onCancel={noop} onDelete={noop} />);
    for (const name of [/Cancel subscription/, /Delete \(wrong entry\)/]) {
      const b = screen.getByRole("button", { name });
      // filled = a bare `bg-rose` class (hover:bg-rose-soft/40 is only the outline's hover tint)
      expect(b.className).not.toMatch(/(^|\s)bg-rose(\s|$)/);
      expect(b.className).not.toMatch(/\bbg-amber\b/);
      expect(b.className).toMatch(/\bborder-rose/);
      expect(b.className).toMatch(/\btext-rose\b/);
    }
  });

  it("a cancelled subscription shows its note instead of the Cancel button", () => {
    render(<SubDrawerDangerZone cancelledNote="Cancelled on 1 Oct" canDelete={false} onCancel={noop} onDelete={noop} />);
    expect(screen.queryByRole("button", { name: /Cancel subscription/ })).toBeNull();
    expect(screen.getByText("Cancelled on 1 Oct")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });
});

describe("R-1727 drawer order on /subscriptions", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/subscriptions/page.tsx"), "utf8");
  it("actions sit right under the header, before the facts and the billing schedule", () => {
    const header = src.indexOf("</SheetHeader>");
    const actions = src.indexOf("<SubDrawerActions");
    expect(actions).toBeGreaterThan(header);
    expect(actions).toBeLessThan(src.indexOf("subscriptionFacts(scheduleSub)"));
    expect(actions).toBeLessThan(src.indexOf("<BillingScheduleCard"));
  });
  it("Cancel / Delete sit apart at the bottom, after late fees", () => {
    expect(src.indexOf("<SubDrawerDangerZone")).toBeGreaterThan(src.indexOf("<LateChargesPreview"));
    expect(src).not.toMatch(/variant="danger"[\s\S]{0,200}Cancel subscription/);
  });
});
