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
/* R-1695: chainEffect is the real one unless a test sets `forcedFx` (the amber "chain mel nahi" case). */
let forcedFx: { before: number; after: number } | null = null;
vi.mock("@/lib/banking/import-history", async (orig) => {
  const real = await orig<typeof import("@/lib/banking/import-history")>();
  return { ...real, chainEffect: (...a: Parameters<typeof real.chainEffect>) => forcedFx ?? real.chainEffect(...a) };
});

/* jsdom here has no localStorage — a stand-in (the component must also work without one). */
const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as Storage,
});

import { BankImportsSection } from "./bank-imports-section";

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({ removed: 2 }); forcedFx = null; store.clear(); });

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

/** The "Dikhao / Chhupao" toggle of the whole card. */
const mainToggle = () => screen.getByRole("button", { name: /^(Show|Hide)$/ });
function expand() { fireEvent.click(screen.getByRole("button", { name: /^Show$/ })); }

describe("R-1695 — compact Imports card", () => {
  it("starts collapsed: one summary line with active / removed counts and the latest import; no rows", () => {
    history = [pdf, removed, old];
    renderSection();
    const summary = screen.getByTestId("imports-summary");
    expect(summary.textContent).toContain("2 active");
    expect(summary.textContent).toContain("1 removed");
    expect(summary.textContent).toContain("last: 19 Oct 2026");
    expect(summary.textContent).toContain("HDFC Aug.pdf");
    expect(mainToggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Remove import/ })).toBeNull();
  });

  it("R-1720: a ' · ' separates the latest import's date from its file label", () => {
    history = [row({ batch_id: "b9", file_name: null, source: "csv", line_count: 1, imported_at: "2026-10-20T06:00:00+00:00" })];
    renderSection();
    expect(screen.getByTestId("imports-summary").textContent).toContain("last: 20 Oct 2026 · no file name");
  });

  it("the latest import with no file name shows as 'Old import'", () => {
    history = [old];
    renderSection();
    expect(screen.getByTestId("imports-summary").textContent).toContain("Old import");
  });

  it("aria-expanded follows the toggle, and the choice is remembered for the next visit", () => {
    history = [pdf];
    renderSection();
    expand();
    expect(mainToggle().getAttribute("aria-expanded")).toBe("true");
    expect(mainToggle().textContent).toBe("Hide");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    cleanup();
    renderSection();
    expect(mainToggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(mainToggle());
    expect(mainToggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("an active import whose chain does not match starts the card open, with the warning in the summary and under its row", () => {
    history = [pdf, old];
    forcedFx = { before: 5000, after: 0 };
    renderSection();
    expect(mainToggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("imports-summary").textContent).toMatch(/balance chain mismatch/);
    expect(screen.getAllByText(/balance chain does not match the other lines/).length).toBeGreaterThan(0);
  });

  it("expanded shows ACTIVE imports only, newest first, one row each with date, source, file, lines, range and its remove button", () => {
    history = [old, removed, pdf];
    renderSection();
    expand();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("HDFC Aug.pdf");
    expect(items[0].textContent).toContain("PDF");
    expect(items[0].textContent).toContain("2 lines");
    expect(items[0].textContent).toContain("1 Aug 2026 – 31 Aug 2026");
    expect(within(items[0]).getByText("HDFC Aug.pdf").getAttribute("title")).toContain("Pardeep");
    expect(within(items[0]).getByRole("button", { name: /Remove import/ })).toBeTruthy();
    expect(items[1].textContent).toContain("Old import");
    expect(items[1].textContent).toContain("17 Oct 2026");
    expect(screen.queryByText(/galat\.csv/)).toBeNull();
  });

  it("shows 5 active imports, then 'Show N more' for the rest", () => {
    history = Array.from({ length: 7 }, (_, i) => row({ batch_id: `b${i}`, file_name: `f${i}.pdf`, line_count: 1,
      imported_at: `2026-10-${String(10 + i).padStart(2, "0")}T06:00:00+00:00` }));
    renderSection();
    expand();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("f6.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("removed imports sit behind their own 'Removed (M)' toggle — grey, one line with when / who / why, no remove button", () => {
    history = [pdf, removed];
    renderSection();
    expand();
    const t = screen.getByRole("button", { name: "Removed (1)" });
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/dobara chadh gaya/)).toBeNull();
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const gone = items[1];
    expect(gone.textContent).toContain("galat.csv");
    expect(gone.textContent).toContain("5 lines");
    expect(gone.textContent).toContain("Removed 18 Oct 2026");
    expect(gone.textContent).toContain("Pardeep");
    expect(gone.textContent).toContain("dobara chadh gaya");
    expect(within(gone).queryByRole("button", { name: /Remove import/ })).toBeNull();
  });

  it("renders fine when localStorage throws", () => {
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    history = [pdf];
    renderSection();
    expect(mainToggle().getAttribute("aria-expanded")).toBe("false");
    spy.mockRestore();
  });
});

describe("Imports list", () => {
  it("a sales login sees the list but is told only owner / accountant can remove", () => {
    history = [pdf];
    renderSection("sales");
    expand();
    expect(screen.queryByRole("button", { name: /Remove import/ })).toBeNull();
    expect(screen.getByText(/Only the owner or an accountant/)).toBeTruthy();
  });
});

describe("Remove import", () => {
  it("asks for a reason, then sends exactly that old import's insert-time range", async () => {
    history = [old];
    renderSection("accountant");
    expand();
    fireEvent.click(screen.getByRole("button", { name: /Remove import/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("2 lines");
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove 2 lines/ }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Enter a reason/);
    fireEvent.change(within(dialog).getByLabelText(/Reason for removing/), { target: { value: "17 Oct ka galat import" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove 2 lines/ }));
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
    expand();
    fireEvent.click(screen.getByRole("button", { name: /Remove import/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("1 of its lines are reconciled — un-reconcile them first");
    expect(dialog.textContent).toContain("LINE p1");
    expect(within(dialog).queryByRole("button", { name: /Remove d+ lines/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Un-reconcile/ }));
    expect(onUnreconcileLine).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });

  it("a refusal from the database is shown in the dialog, not swallowed", async () => {
    history = [pdf];
    mutateAsync.mockRejectedValueOnce({ message: "2 of this import's lines (the first dated 02 Aug 2026) are in closed books — the books are locked up to 31 Aug 2026. Ask the owner to unlock them in Accounting → Month-end close, then remove the import." });
    renderSection();
    expand();
    fireEvent.click(screen.getByRole("button", { name: /Remove import/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason for removing/), { target: { value: "galat file" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove 2 lines/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Month-end close");
  });
});
