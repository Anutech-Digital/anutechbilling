// @vitest-environment jsdom
/* R-1848 — Balance Sheet → Partners' capital accounts: one fluctuating account per partner
   (opening + introduced + share of profit − drawings = closing), click a partner for the
   statement, older typed names offer "Link to partner", the rest shows as "Not yet split". */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { FirmPartner } from "@/lib/accounting/partners";
import type { OwnerEquityMovement } from "@/lib/accounting/owner-equity";

const link = vi.fn();
vi.mock("@/lib/queries/partners", () => ({
  useLinkOwnerEquityPartner: () => ({ mutate: link, isPending: false }),
}));
const csv = vi.fn();
vi.mock("@/lib/csv", () => ({ downloadCSV: (...a: unknown[]) => csv(...a) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { PartnerCapitalBox } from "./partner-capital-box";

const fp = (id: string, name: string, pct: number, cap = 0): FirmPartner => ({
  id, name, pan: null, din_dpin: null, is_designated: false, profit_share_pct: pct, capital_contribution: cap,
  joined_on: null, left_on: null, note: null,
});
let n = 0;
const mv = (over: Partial<OwnerEquityMovement>): OwnerEquityMovement => ({
  id: `m${++n}`, kind: "drawings", movement_date: "2026-10-05", amount: 0, bank_account_id: "acc", bank_txn_id: `t${n}`,
  own_line: true, partner_name: null, partner_id: null, note: null, ...over,
});

const A = fp("a", "Partner A", 60);
const B = fp("b", "Partner B", 40);
let movements: OwnerEquityMovement[] = [];

afterEach(cleanup);
beforeEach(() => {
  link.mockReset(); csv.mockReset();
  movements = [
    mv({ kind: "capital_introduced", amount: 100000, partner_id: "a", partner_name: "Partner A", movement_date: "2026-10-01" }),
    mv({ kind: "drawings", amount: 20000, partner_id: "b", partner_name: "Partner B", movement_date: "2026-10-02", note: "Home rent" }),
  ];
});

const box = (over: Partial<React.ComponentProps<typeof PartnerCapitalBox>> = {}) => (
  <PartnerCapitalBox partners={[A, B]} movements={movements} profit={0} range={{ upTo: "2026-10-24" }} sectionTotal={80000} {...over} />
);

describe("R-1848 partners' capital accounts on the Balance Sheet", () => {
  it("card example: A +1,00,000, B −20,000, together the equity", () => {
    render(box());
    const a = screen.getByRole("button", { name: /Partner A/ });
    const b = screen.getByRole("button", { name: /Partner B/ });
    expect(a.textContent).toMatch(/1,00,000/);
    expect(b.textContent).toMatch(/\(₹20,000\)/);
    expect(screen.queryByText(/Not yet split/)).toBeNull();
  });

  it("clicking a partner opens their statement, with a CSV", () => {
    render(box());
    fireEvent.click(screen.getByRole("button", { name: /Partner B/ }));
    const st = screen.getByRole("table", { name: /Partner B/ });
    expect(within(st).getByText("Opening capital")).toBeTruthy();
    expect(within(st).getByText("Drawings")).toBeTruthy();
    expect(within(st).getByText(/Home rent/)).toBeTruthy();
    expect(within(st).getByText("Closing capital")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /CSV for Partner B/ }));
    expect(csv).toHaveBeenCalled();
    expect(csv.mock.calls[0][0]).toMatch(/partner-b/i);
  });

  it("profit share by ratio is marked as an estimate", () => {
    render(box({ profit: 10000, sectionTotal: 90000 }));
    expect(screen.getByText(/estimate/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Partner A/ }).textContent).toMatch(/1,06,000/);
  });

  it("what the partner accounts do not cover shows as Not yet split (total unchanged)", () => {
    render(box({ sectionTotal: 380000 }));
    expect(screen.getByText(/Not yet split between partners/)).toBeTruthy();
    expect(screen.getByText(/3,00,000/)).toBeTruthy();
    expect(screen.getByText(/Set each partner's capital contribution/)).toBeTruthy();
  });

  it("partner accounts MORE than the equity: says so and points at the opening balance, not at setting contributions", () => {
    render(box({ partners: [fp("a", "Partner A", 60, 500000), B], sectionTotal: 80000 }));
    expect(screen.getByText(/Not yet split between partners/)).toBeTruthy();
    expect(screen.getByText(/partner accounts add up to more than the equity/i)).toBeTruthy();
    expect(screen.getByText(/check the opening balance/i)).toBeTruthy();
    expect(screen.queryByText(/Set each partner's capital contribution/)).toBeNull();
  });

  it("an older entry with a typed name is listed under it and can be linked to a register partner", () => {
    movements = [...movements, mv({ kind: "drawings", amount: 700, partner_name: "A (old)" })];
    render(box({ sectionTotal: 79300 }));
    expect(screen.getByText(/A \(old\)/)).toBeTruthy();
    const pick = screen.getByLabelText(/Link A \(old\) to a partner/) as HTMLSelectElement;
    fireEvent.change(pick, { target: { value: "a" } });
    expect(link).toHaveBeenCalledWith({ movementId: movements[2].id, partnerId: "a" });
  });

  it("no partners and no entries → a prompt to add the partners", () => {
    movements = [];
    render(box({ partners: [], sectionTotal: 0 }));
    expect((screen.getByRole("link", { name: /Add partners/ }) as HTMLAnchorElement).getAttribute("href")).toBe("/settings?tab=company#partners");
  });
});
