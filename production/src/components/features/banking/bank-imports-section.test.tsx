// @vitest-environment jsdom
/* R-1623 — the account page's Imports list and "Ye import hatao": every import with when / file /
   source / lines / who / dates, newest first; an old import (no batch) by its insert time; the
   removal asks for a reason and sends exactly that import; a reconciled line blocks it with the
   lines listed and an Un-reconcile button each; a role that may not remove is told so. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { BankImportRow } from "@/lib/banking/import-history";
import type { BankTransactionRow } from "@/lib/queries/bank";

const mutateAsync = vi.fn();
let history: BankImportRow[] = [];
vi.mock("@/lib/queries/bank", () => ({
  useBankImportHistory: () => ({ data: history, isLoading: false, isError: false, refetch: vi.fn() }),
  useRemoveBankImport: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { BankImportsSection } from "./bank-imports-section";

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({ removed: 2 }); });

const row = (over: Partial<BankImportRow>): BankImportRow => ({
  kind: "batch", batch_id: null, legacy_from: null, legacy_to: null, file_name: null, source: "pdf",
  line_count: 0, imported_at: "2026-10-18T05:00:00+00:00", imported_by: null, txn_from: null, txn_to: null,
  first_balance: null, last_balance: null, reconciled_count: 0, removed_at: null, removed_by: null,
  remove_reason: null, removed_lines: null, ...over,
});

const txn = (id: string, over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  id, tenant_id: "t1", bank_account_id: "acc1", txn_date: "2026-04-02", description: `LINE ${id}`,
  debit: 100, credit: 0, balance_after: null, reference: null, source: "csv_upload",
  matched_to_type: null, matched_to_id: null, matched_at: null, matched_by: null, match_confidence: null,
  imported_at: "", created_at: "2026-10-17T11:29:06.123456+00:00", updated_at: "", import_batch_id: null, ...over,
});

const pdf = row({ batch_id: "b1", file_name: "HDFC Aug.pdf", source: "pdf", line_count: 2, imported_by: "Pardeep",
  txn_from: "2026-08-01", txn_to: "2026-08-31", imported_at: "2026-10-19T06:00:00+00:00" });
const old = row({ kind: "legacy", source: "legacy", line_count: 2, txn_from: "2026-04-01", txn_to: "2026-04-03",
  legacy_from: "2026-10-17T11:29:06.123456Z", legacy_to: "2026-10-17T11:29:06.123456Z", imported_at: "2026-10-17T11:29:06.123456+00:00" });
const removed = row({ batch_id: "b0", file_name: "galat.csv", source: "csv", line_count: 5, removed_lines: 5,
  removed_at: "2026-10-18T07:00:00+00:00", removed_by: "Pardeep", remove_reason: "dobara chadh gaya", imported_at: "2026-10-18T06:00:00+00:00" });

const lines = [
  txn("p1", { import_batch_id: "b1", txn_date: "2026-08-02" }),
  txn("p2", { import_batch_id: "b1", txn_date: "2026-08-03" }),
  txn("o1"), txn("o2", { txn_date: "2026-04-03" }),
];

function renderSection(role = "owner", ls = lines, onUnreconcileLine = vi.fn()) {
  render(<BankImportsSection accountId="acc1" transactions={ls} openingBalance={0} role={role} onUnreconcileLine={onUnreconcileLine} />);
  return { onUnreconcileLine };
}

describe("Imports list", () => {
  it("lists every import newest first — file, source, lines, who, dates; an old import by its insert time; a removed one with why", () => {
    history = [pdf, removed, old];
    renderSection();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("HDFC Aug.pdf");
    expect(items[0].textContent).toContain("PDF");
    expect(items[0].textContent).toContain("2 lines");
    expect(items[0].textContent).toContain("Pardeep");
    expect(items[0].textContent).toContain("1 Aug 2026 – 31 Aug 2026");
    expect(items[2].textContent).toContain("Purana import");
    expect(items[2].textContent).toContain("17 Oct 2026");
    expect(items[1].textContent).toContain("Hataya");
    expect(items[1].textContent).toContain("dobara chadh gaya");
    expect(within(items[1]).queryByRole("button", { name: /Ye import hatao/ })).toBeNull();
  });

  it("a sales login sees the list but is told only owner / accountant can remove", () => {
    history = [pdf];
    renderSection("sales");
    expect(screen.queryByRole("button", { name: /Ye import hatao/ })).toBeNull();
    expect(screen.getByText(/sirf owner ya accountant/)).toBeTruthy();
  });
});

describe("Ye import hatao", () => {
  it("asks for a reason, then sends exactly that old import's insert-time range", async () => {
    history = [old];
    renderSection("accountant");
    fireEvent.click(screen.getByRole("button", { name: /Ye import hatao/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("2 lines");
    fireEvent.click(within(dialog).getByRole("button", { name: /2 lines hatao/ }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/wajah likho/);
    fireEvent.change(within(dialog).getByLabelText(/Kyun hata rahe ho/), { target: { value: "17 Oct ka galat import" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /2 lines hatao/ }));
    expect(mutateAsync).toHaveBeenCalledWith({
      p_account_id: "acc1", p_batch_id: null,
      p_legacy_from: "2026-10-17T11:29:06.123456Z", p_legacy_to: "2026-10-17T11:29:06.123456Z",
      p_reason: "17 Oct ka galat import",
    });
  });

  it("a reconciled line blocks it: says how many, lists them, and each has Un-reconcile", () => {
    history = [pdf];
    const ls = [txn("p1", { import_batch_id: "b1", matched_to_type: "expense", debit: 4500 }), txn("p2", { import_batch_id: "b1" })];
    const { onUnreconcileLine } = renderSection("owner", ls);
    fireEvent.click(screen.getByRole("button", { name: /Ye import hatao/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Ye 1 lines reconcile hain — pehle Un-reconcile karo");
    expect(dialog.textContent).toContain("LINE p1");
    expect(within(dialog).queryByRole("button", { name: /lines hatao/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Un-reconcile/ }));
    expect(onUnreconcileLine).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });

  it("a refusal from the database is shown in the dialog, not swallowed", async () => {
    history = [pdf];
    mutateAsync.mockRejectedValueOnce({ message: "Is import ki 2 lines (pehli 02 Aug 2026 ki) band books me hain — books 31 Aug 2026 tak lock hain. Owner Accounting → Month-end close par lock kholein, phir import hatao." });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Ye import hatao/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Kyun hata rahe ho/), { target: { value: "galat file" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /2 lines hatao/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Month-end close");
  });
});
