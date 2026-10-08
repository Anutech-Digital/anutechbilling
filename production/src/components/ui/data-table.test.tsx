// @vitest-environment jsdom
//
// R-297 — a sorted list keeps its sort when the operator opens a row and presses Back.
// R-272/R-287 put the filters in the URL; the sort still lived only in useState, so a
// list sorted by amount came back in the page's own order. With `urlKey` the sort is
// written to the address bar (?sort=amount.desc) and read back on the next mount.
// Without `urlKey` nothing about the URL changes (every other list keeps its old behaviour).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("@/components/providers/confirm-provider", () => ({ useAskText: () => async () => null }));

import { DataTable, type DataTableColumn } from "./data-table";

type Row = { id: string; amount: number };
const rows: Row[] = Array.from({ length: 120 }, (_, i) => ({ id: `INV-${String(i + 1).padStart(3, "0")}`, amount: i + 1 }));
const columns: DataTableColumn<Row>[] = [
  { id: "id", header: "Invoice", cell: (r) => r.id },
  { id: "amount", header: "Amount", cell: (r) => String(r.amount), sortValue: (r) => r.amount },
];

beforeEach(() => window.history.replaceState(null, "", "/invoices?tab=open"));
afterEach(cleanup);

function table(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable<Row>
      rows={rows}
      // A fresh array each render, like most pages pass — the sort must not reset paging.
      columns={[...columns]}
      getRowId={(r) => r.id}
      noun="invoice"
      mobileCard={(r) => <span>{r.id}</span>}
      pageSize={50}
      {...props}
    />,
  );
}
const tableRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const firstId = () => within(tableRows()[0]).getAllByRole("cell")[0].textContent;
const params = () => new URLSearchParams(window.location.search);

describe("DataTable sort in the URL (R-297)", () => {
  it("with urlKey: sort goes to the address bar and survives a remount (Back)", () => {
    const first = table({ urlKey: "sort" });
    fireEvent.click(screen.getByRole("button", { name: /Amount/ })); // asc
    fireEvent.click(screen.getByRole("button", { name: /Amount/ })); // desc
    expect(params().get("sort")).toBe("amount.desc");
    expect(params().get("tab")).toBe("open"); // other params kept
    first.unmount();

    table({ urlKey: "sort" });
    expect(firstId()).toBe("INV-120");
    expect(screen.getByRole("columnheader", { name: /Amount/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("Clear sort removes the key, so an unsorted list has a clean URL", () => {
    window.history.replaceState(null, "", "/invoices?sort=amount.desc");
    table({ urlKey: "sort" });
    expect(firstId()).toBe("INV-120");
    fireEvent.click(screen.getByRole("button", { name: "Clear sort" }));
    expect(params().has("sort")).toBe(false);
    expect(firstId()).toBe("INV-001");
  });

  it("a junk or unknown-column value in the URL is ignored", () => {
    window.history.replaceState(null, "", "/invoices?sort=hacked.sideways");
    table({ urlKey: "sort" });
    expect(firstId()).toBe("INV-001");
    cleanup();
    window.history.replaceState(null, "", "/invoices?sort=id.desc"); // column exists but is not sortable
    table({ urlKey: "sort" });
    expect(firstId()).toBe("INV-001");
  });

  it("Load more still works while the sort comes from the URL", () => {
    window.history.replaceState(null, "", "/invoices?sort=amount.desc");
    table({ urlKey: "sort" });
    expect(tableRows()).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(tableRows()).toHaveLength(100);
  });

  it("without urlKey: sorting never touches the URL and a remount starts unsorted", () => {
    const first = table();
    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
    expect(firstId()).toBe("INV-120");
    expect(window.location.search).toBe("?tab=open");
    first.unmount();
    table();
    expect(firstId()).toBe("INV-001");
  });
});
