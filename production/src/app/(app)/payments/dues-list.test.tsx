// @vitest-environment jsdom
//
// R-1698 — Payments → Subscription dues (payments audit, 20 Oct 2026).
// Between 768 and 1279px (a laptop with the sidebar, the Claude pane at ~800px) no dues ROWS
// showed — the phone list was `md:hidden`, the table `hidden xl:block` — only the heading
// "Subscription dues · ₹X". Each table row had four buttons and the table scrolled in its own
// max-height box under the page's sticky bar (two scrolls). Remind wrote "reminder sent"
// before the mail app even opened.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { OutstandingRow } from "@/lib/queries/payments";
import { SubscriptionDuesList, duesOrder, DUES_FIRST, DUES_AGE_LEGEND, type DuesActions } from "./dues-list";
import { DuesPayButton } from "./dues-pay";

afterEach(cleanup);

const TODAY = "2026-10-24";
let n = 0;
const due = (over: Partial<OutstandingRow>): OutstandingRow => ({
  subscription_id: `sub-${++n}`,
  customer_id: `c-${n}`,
  customer_name: `Customer ${n}`,
  plan: "Google Workspace Business Starter",
  outstanding_amount: 1000,
  total_quote_amount: 3000,
  paid_amount: 2000,
  status: "active",
  started_at: "2026-01-01",
  age_from: "2026-10-01",
  last_reminder_at: null,
  days_outstanding: 10,
  quote_id: `Q-${n}`,
  payment_due_date: null,
  ...over,
});

const actions = (): DuesActions & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    payButton: (o) => <DuesPayButton route={{ kind: "quote", quoteId: o.quote_id ?? "Q" }} onRecord={() => calls.push(`pay:${o.subscription_id}`)} />,
    onRemind: (o) => calls.push(`remind:${o.subscription_id}`),
    onSuspend: (o) => calls.push(`suspend:${o.subscription_id}`),
    onResume: (o) => calls.push(`resume:${o.subscription_id}`),
    onWriteOff: (o) => calls.push(`writeoff:${o.subscription_id}`),
  };
};

describe("duesOrder — overdue first", () => {
  it("rows past their agreed due date come first, then the oldest balance", () => {
    const fresh = due({ customer_name: "Fresh", days_outstanding: 3 });
    const old = due({ customer_name: "Old", days_outstanding: 70 });
    const late = due({ customer_name: "Late", days_outstanding: 5, payment_due_date: "2026-10-10" });
    const mid = due({ customer_name: "Mid", days_outstanding: 20 });
    expect(duesOrder([fresh, old, late, mid], TODAY).map((o) => o.customer_name)).toEqual(["Late", "Old", "Mid", "Fresh"]);
  });

  it("does not change the list it is given", () => {
    const rows = [due({ days_outstanding: 1 }), due({ days_outstanding: 9 })];
    const copy = [...rows];
    duesOrder(rows, TODAY);
    expect(rows).toEqual(copy);
  });
});

describe("SubscriptionDuesList (R-1698)", () => {
  it("every width shows the rows: cards below xl (not md:hidden), the table from xl, no inner scroll box", () => {
    const { container } = render(<SubscriptionDuesList rows={[due({})]} readOnly={false} actions={actions()} />);
    const cards = container.querySelector("ul");
    expect(cards?.className).toMatch(/\bxl:hidden\b/);
    expect(cards?.className).not.toMatch(/\bmd:hidden\b/);
    const table = container.querySelector("table")?.parentElement;
    expect(table?.className).toMatch(/\bhidden xl:block\b/);
    expect(container.innerHTML).not.toMatch(/max-h-/);
    expect(container.innerHTML).not.toMatch(/overflow-auto/);
  });

  it("one filled button per row — Record payment — and the rest behind ⋯", () => {
    const a = actions();
    const { container } = render(<SubscriptionDuesList rows={[due({ days_outstanding: 45 })]} readOnly={false} actions={a} />);
    for (const row of Array.from(container.querySelectorAll("[data-dues-row]"))) {
      const buttons = within(row as HTMLElement).getAllByRole("button");
      const filled = buttons.filter((b) => /Record payment/.test(b.textContent ?? ""));
      expect(filled).toHaveLength(1);
      expect(buttons.map((b) => b.textContent?.trim())).not.toContain("Remind");
      expect(buttons.map((b) => b.textContent?.trim())).not.toContain("Write off");
      expect(within(row as HTMLElement).getByRole("button", { name: /More actions for/ })).toBeTruthy();
      expect(buttons).toHaveLength(2);
    }
  });

  it("first 5 rows, then 'Show all N' opens the rest", () => {
    const rows = Array.from({ length: 7 }, (_, i) => due({ customer_name: `Row ${i}`, days_outstanding: 7 - i }));
    const { container } = render(<SubscriptionDuesList rows={rows} readOnly={false} actions={actions()} />);
    const cardRows = () => container.querySelectorAll("ul [data-dues-row]").length;
    expect(cardRows()).toBe(DUES_FIRST);
    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(cardRows()).toBe(7);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(cardRows()).toBe(DUES_FIRST);
  });

  it("5 rows or fewer: no Show all button", () => {
    render(<SubscriptionDuesList rows={[due({}), due({})]} readOnly={false} actions={actions()} />);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("the age legend sits on the Age header's tooltip", () => {
    const { container } = render(<SubscriptionDuesList rows={[due({})]} readOnly={false} actions={actions()} />);
    const ageTh = Array.from(container.querySelectorAll("th")).find((th) => /^Age/.test(th.textContent ?? ""));
    expect(ageTh?.getAttribute("title")).toBe(DUES_AGE_LEGEND);
    expect(DUES_AGE_LEGEND).toMatch(/60\+ days/);
  });

  it("view-only role: rows show, no action buttons", () => {
    const { container } = render(<SubscriptionDuesList rows={[due({})]} readOnly actions={actions()} />);
    expect(container.querySelectorAll("[data-dues-row]").length).toBe(2); // card + table row
    expect(screen.queryByRole("button", { name: /Record payment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("Record payment calls the row's own action", () => {
    const a = actions();
    const row = due({});
    const { container } = render(<SubscriptionDuesList rows={[row]} readOnly={false} actions={a} />);
    fireEvent.click(within(container.querySelector("ul [data-dues-row]") as HTMLElement).getByRole("button", { name: /Record payment/ }));
    expect(a.calls).toEqual([`pay:${row.subscription_id}`]);
  });
});

describe("payments page wiring (R-1698)", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("the dues card renders SubscriptionDuesList — no md:hidden phone list, no max-h scroll box left", () => {
    expect(src).toMatch(/<SubscriptionDuesList\b/);
    expect(src).not.toMatch(/max-h-\[calc\(100vh-15rem\)\]/);
    expect(src).not.toMatch(/function OutstandingRowView/);
  });

  it("the old legend line under the list is gone (it lives on the Age header)", () => {
    expect(src).not.toMatch(/0–15 days: friendly reminder/);
  });

  it("Remind marks 'sent' only after the mail opened AND the user says it went", () => {
    const at = src.indexOf("onRemind:");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1500);
    const mail = body.indexOf("mailto:");
    const ask = body.indexOf("await confirm(");
    const mark = body.indexOf("markReminderSent.mutateAsync");
    expect(mail).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(mail);
    expect(mark).toBeGreaterThan(ask);
  });
});

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
