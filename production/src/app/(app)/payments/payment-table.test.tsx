// @vitest-environment jsdom
//
// R-215 — Payments Received on the shared DataTable: header sort, Load more kept (R-104),
// and the keyboard follows the painted order.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { sortRows } from "@/lib/table/data-table";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { paymentSortValues, readRowIds, PAY_ROW_ATTR, type PaymentSortRow } from "./payment-table";
import { useRowOrder } from "./use-row-order";

afterEach(cleanup);

type Pay = PaymentSortRow & { id: string; customer: string | null };
const pay = (id: string, over: Partial<Pay> = {}): Pay => ({
  id, quote_id: `Q-${id}`, received_at: "2026-10-01T10:00:00Z", amount: 1000, method: "upi",
  reference: null, status: "received", customer: "Acme", ...over,
});

const rows: Pay[] = [
  pay("a", { amount: 9000, received_at: "2026-10-03T05:00:00Z", method: "bank_transfer", customer: "Zen Labs", reference: "UTR9" }),
  pay("b", { amount: 10000, received_at: null, method: "cash", customer: "acme", status: "refunded" }),
  pay("c", { amount: 450, received_at: "2026-09-30T05:00:00Z", method: "upi", customer: null, reference: "UTR1" }),
];
const S = paymentSortValues<Pay>((p) => p.customer);
const ids = (r: Pay[]) => r.map((p) => p.id);

describe("R-215 payments — sortable headers", () => {
  it("amount sorts as a number (9,000 below 10,000)", () => {
    expect(ids(sortRows(rows, S.amount, "asc"))).toEqual(["c", "a", "b"]);
    expect(ids(sortRows(rows, S.amount, "desc"))).toEqual(["b", "a", "c"]);
  });

  it("date: no date goes last both ways", () => {
    expect(ids(sortRows(rows, S.date, "asc"))).toEqual(["c", "a", "b"]);
    expect(ids(sortRows(rows, S.date, "desc"))).toEqual(["a", "c", "b"]);
  });

  it("customer from the quote, any case; unknown customer last", () => {
    expect(ids(sortRows(rows, S.customer, "asc"))).toEqual(["b", "a", "c"]);
  });

  it("method sorts on the label people read (R-177), not the stored key", () => {
    // "Bank transfer" < "Cash" < "UPI"
    expect(ids(sortRows(rows, S.method, "asc"))).toEqual(["a", "b", "c"]);
  });

  it("reference: blank last", () => {
    expect(ids(sortRows(rows, S.reference, "asc"))).toEqual(["c", "a", "b"]);
  });
});

/* The real DataTable with the page's wiring: rows carry PAY_ROW_ATTR, the keyboard order
   comes from useRowOrder. */
function Harness({ list }: { list: Pay[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const order = useRowOrder(ref, list.length > 0);
  const columns: DataTableColumn<Pay>[] = [
    { id: "id", header: "Id" },
    { id: "amount", header: "Amount", sortValue: S.amount },
  ];
  return (
    <div>
      <p data-testid="order">{order.join(",")}</p>
      <div ref={ref}>
        <DataTable
          rows={list}
          columns={columns}
          getRowId={(p) => p.id}
          noun="payment"
          pageSize={50}
          cardsBelow="xl"
          mobileCard={(p) => <span>{p.id}</span>}
          renderRow={(p) => (
            <tr {...{ [PAY_ROW_ATTR]: p.id }}><td>{p.id}</td><td>{p.amount}</td></tr>
          )}
        />
      </div>
    </div>
  );
}

const many: Pay[] = Array.from({ length: 120 }, (_, i) => pay(`p${i + 1}`, { amount: (i + 1) * 10 }));

describe("R-215 payments — DataTable keeps R-104's Load more", () => {
  it("paints 50 of 120, then 50 more, then the last 20", () => {
    render(<Harness list={many} />);
    expect(screen.getAllByRole("row")).toHaveLength(51); // header + 50
    expect(screen.getByText("70 more payments below")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    fireEvent.click(screen.getByRole("button", { name: "Load 20 more" }));
    expect(screen.getAllByRole("row")).toHaveLength(121);
    expect(screen.queryByRole("button", { name: /Load .* more/ })).toBeNull();
  });
});

describe("R-215 payments — keyboard follows the painted order", () => {
  it("reads row ids in screen order", () => {
    const div = document.createElement("div");
    div.innerHTML = `<table><tr ${PAY_ROW_ATTR}="x"></tr><tr ${PAY_ROW_ATTR}="y"></tr></table>`;
    expect(readRowIds(div)).toEqual(["x", "y"]);
    expect(readRowIds(null)).toEqual([]);
  });

  it("after a header sort, the order the keys use is the sorted one", async () => {
    render(<Harness list={rows} />);
    expect(screen.getByTestId("order").textContent).toBe("a,b,c");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");
  });

  it("Load more extends the order the keys can reach", async () => {
    render(<Harness list={many} />);
    expect(screen.getByTestId("order").textContent!.split(",")).toHaveLength(50);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("order").textContent!.split(",")).toHaveLength(100);
  });
});
