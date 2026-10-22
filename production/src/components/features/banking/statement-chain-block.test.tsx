// @vitest-environment jsdom
/* R-1693 — the preview's balance-chain block: each gap named with page and amount, CSV/Excel
   recommended, Import held until the operator ticks the box; a statement with no balance
   column says the check did not run. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { StatementChainBlock } from "./statement-chain-block";
import { checkPreview, importBlocked, type PreviewCheck } from "@/lib/banking/statement-verify";
import { parseStatement } from "@/lib/banking/statement-parse";

afterEach(cleanup);

const gapCheck: PreviewCheck = {
  ran: true,
  gaps: [{ after: "2026-04-06", by: "2026-04-09", amount: 12000, pages: { from: 7, to: 7 } }],
  rowCountIssues: [],
  blocking: true,
};

describe("StatementChainBlock", () => {
  it("names each gap by page, amount and dates, recommends CSV/Excel, and offers the tick", () => {
    const onAck = vi.fn();
    const { container } = render(<StatementChainBlock check={gapCheck} source="ai" ack={false} onAck={onAck} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Page 7: lines worth ₹12,000 are missing — 6 Apr 2026 to 9 Apr 2026");
    expect(text).toMatch(/CSV\s*\/\s*Excel/);
    const box = screen.getByRole("checkbox", { name: /I understand — import the incomplete statement anyway/ });
    fireEvent.click(box);
    expect(onAck).toHaveBeenCalledWith(true);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("Import is blocked until the tick, and only while there is a gap", () => {
    expect(importBlocked(gapCheck, false)).toBe(true);
    expect(importBlocked(gapCheck, true)).toBe(false);
    expect(importBlocked({ ...gapCheck, gaps: [], blocking: false }, false)).toBe(false);
    expect(importBlocked(null, false)).toBe(false);
  });

  it("no balance column: says the check could not run — never that it passed", () => {
    const { container } = render(
      <StatementChainBlock check={{ ran: false, gaps: [], rowCountIssues: [], blocking: false }} source="csv" ack={false} onAck={() => {}} />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Balance check could not run/);
    expect(text).not.toMatch(/poori hai|sab theek|matches/i);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("a complete chain shows one quiet line", () => {
    const { container } = render(
      <StatementChainBlock check={{ ran: true, gaps: [], rowCountIssues: [], blocking: false }} source="ai" ack={false} onAck={() => {}} />,
    );
    expect(container.textContent).toMatch(/Balance chain complete/);
  });

  it("CSV with a missing line: the same red block, called a bad file, no re-read promised", () => {
    const csv = [
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "01/04/26,NEFT CR-ACME TRADERS,N1,01/04/26,,50000.00,150000.00",
      "02/04/26,UPI-AIRTEL,U2,02/04/26,1180.00,,148820.00",
      "04/04/26,UPI-SWIGGY,U4,04/04/26,420.00,,123400.00",
    ].join("\n");
    const check = checkPreview(parseStatement(csv).rows);
    const { container } = render(<StatementChainBlock check={check} source="csv" ack={false} onAck={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("lines worth ₹25,000 are missing — 2 Apr 2026 to 4 Apr 2026");
    expect(text).toMatch(/file is incomplete/i);
    expect(text).not.toMatch(/re-read/i);
    expect(screen.getByRole("checkbox", { name: /I understand/ })).toBeTruthy();
  });
});
