// @vitest-environment jsdom
/* R-2894 — Hitesh (16 Nov): the statement has ₹52,000 to the same person in several months and
   "Link now" offered one line only. Now: several lines → a short list (date, narration, bank),
   nearest the salary's pay date first, each opening exactly that line; one line → direct link. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [{ id: "acct-hdfc", name: "HDFC Current" }, { id: "acct-icici", name: "ICICI Salary" }] }),
}));

import { SalaryStatusCell, SalaryBankLinkAction } from "./salary-status-cell";
import { salaryBankLink, type WaitingBankLine } from "@/lib/payroll/salary-bank-link";

const line = (id: string, date: string, narr: string, acct = "acct-hdfc"): WaitingBankLine =>
  ({ id, bank_account_id: acct, txn_date: date, description: narr, debit: 52000 });
const waiting = new Map<number, WaitingBankLine[]>([[52000, [
  line("l-oct", "2026-10-03", "NEFT-SALARY-OCT UTR111"),
  line("l-jul", "2026-07-02", "NEFT-SALARY-JUN UTR222", "acct-icici"),
]]]);
const june = { net: 52000, paid_amount: 0, paid_status: "unpaid", period: "2026-06", pay_date: "2026-07-02" } as const;

afterEach(cleanup);

describe("R-2894 salary → which bank line", () => {
  it("two same-amount lines → a picker; both listed, the line nearest the pay date first", () => {
    render(<SalaryStatusCell p={june} waitingLines={waiting} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: /Link now \(2 lines\)/ }));
    const list = screen.getByRole("list", { name: /Unlinked bank lines/ });
    const items = within(list).getAllByRole("link");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("href")).toBe("/accounting/banking/acct-icici?focus=l-jul");
    expect(items[1].getAttribute("href")).toBe("/accounting/banking/acct-hdfc?focus=l-oct");
    expect(within(items[0]).getByText("NEFT-SALARY-JUN UTR222")).toBeTruthy();
    expect(within(items[0]).getByText("ICICI Salary")).toBeTruthy();
    expect(within(items[0]).getByText("Closest date")).toBeTruthy();
    expect(within(items[1]).getByText("HDFC Current")).toBeTruthy();
    expect(within(items[1]).queryByText("Closest date")).toBeNull();
  });

  it("an October salary paid 30 Sep → the 3 Oct line comes first", () => {
    render(<SalaryStatusCell p={{ ...june, period: "2026-09", pay_date: "2026-09-30" }} waitingLines={waiting} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: /Link now/ }));
    expect(within(screen.getByRole("list")).getAllByRole("link")[0].getAttribute("href")).toContain("focus=l-oct");
  });

  it("one line only → the plain Link now button opens that exact line", () => {
    const one = new Map([[52000, [line("l-only", "2026-07-02", "x")]]]);
    render(<SalaryStatusCell p={june} waitingLines={one} canWrite />);
    expect(screen.getByRole("link", { name: "Link now" }).getAttribute("href")).toBe("/accounting/banking/acct-hdfc?focus=l-only");
    expect(screen.queryByRole("button", { name: /lines/ })).toBeNull();
  });

  it("no line / view-only → no Link now at all", () => {
    const { unmount } = render(<SalaryStatusCell p={june} waitingLines={new Map()} canWrite />);
    expect(screen.queryByText(/Link now/)).toBeNull();
    unmount();
    render(<SalaryStatusCell p={june} waitingLines={waiting} canWrite={false} />);
    expect(screen.queryByText(/Link now/)).toBeNull();
  });

  it("a Paid salary with no bank line: Match offers the same list when several lines fit", () => {
    const paid = { id: "s1", net: 52000, paid_amount: 52000, paid_status: "paid", reconciled_txn_id: null } as const;
    const link = salaryBankLink(paid, undefined, [...waiting.get(52000)!]);
    expect(link.kind === "not_matched" && link.choices?.length).toBe(2);
    render(<SalaryBankLinkAction link={link} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: /Match \(2 lines\)/ }));
    expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(2);
  });
});
