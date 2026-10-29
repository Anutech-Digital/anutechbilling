// @vitest-environment jsdom
/* R-2025 (5) — "Known payers" on the customer page: who else pays for this customer (their own
   other account, a group company, a director, a third party), learned on Reconcile or added here.
   Owner / accountant add, edit and remove; everyone else only reads. Each row says on which bank
   lines it was seen. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const state = vi.hoisted(() => ({ payers: [] as unknown[], lines: [] as unknown[], save: vi.fn(), del: vi.fn() }));

vi.mock("@/lib/queries/customer-payers", () => ({
  useCustomerPayers: () => ({ data: state.payers, isLoading: false }),
  useCustomerPayerLines: () => ({ data: state.lines }),
  useSaveCustomerPayer: () => ({ mutateAsync: state.save, isPending: false }),
  useDeleteCustomerPayer: () => ({ mutateAsync: state.del, isPending: false }),
}));

import { KnownPayersCard } from "./known-payers-card";

const SHREE = {
  id: "kp1", customer_id: "c-links", payer_name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED",
  payer_name_key: "shree nandik technologies private limited", relation: "group_company", note: "Sister company",
  ifsc: "INDB0000006", upi_id: null, account_tail: null, uses: 2, first_seen_txn: "t1", created_at: "2026-10-27T12:00:00Z",
};
const OTHER = { ...SHREE, id: "kp9", customer_id: "c-acme", payer_name: "ACME PAYER", payer_name_key: "acme payer" };

afterEach(cleanup);
beforeEach(() => {
  state.payers = [SHREE, OTHER];
  state.lines = [
    { id: "t2", bank_account_id: "b1", txn_date: "2026-10-25", credit: 5000, payer_key: "shree nandik technologies private limited" },
    { id: "t1", bank_account_id: "b1", txn_date: "2026-10-23", credit: 16709, payer_key: "shree nandik technologies private limited" },
  ];
  state.save.mockReset().mockResolvedValue("kp-new");
  state.del.mockReset().mockResolvedValue(undefined);
});

describe("R-2025 Known payers card", () => {
  it("lists only this customer's payers: name, relation, IFSC, note, and the bank lines it was seen on", () => {
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit />);
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED");
    expect(row.textContent).toContain("Group company");
    expect(row.textContent).toContain("IFSC INDB0000006");
    expect(row.textContent).toContain("Sister company");
    const seen = within(row).getByRole("link", { name: "Seen on 2 bank lines" });
    expect(seen.getAttribute("href")).toBe("/accounting/banking/b1?txn=t2");
    expect(screen.queryByText("ACME PAYER")).toBeNull();
  });

  it("add: name + how related → one save call for this customer", async () => {
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Add known payer" }));
    fireEvent.change(screen.getByLabelText("Payer name (as on the bank line)"), { target: { value: "RAJESH KUMAR" } });
    fireEvent.change(screen.getByLabelText("How related"), { target: { value: "director" } });
    fireEvent.change(screen.getByLabelText("Account ending (optional)"), { target: { value: "4521" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payer" }));
    await screen.findByRole("button", { name: "Add known payer" });
    expect(state.save).toHaveBeenCalledWith({
      id: null, customerId: "c-links", payerName: "RAJESH KUMAR", relation: "director", note: null,
      ifsc: null, upi: null, accountTail: "4521",
    });
  });

  it("Save stays off until the name is filled", () => {
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Add known payer" }));
    expect((screen.getByRole("button", { name: "Save payer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("edit: the form opens filled in and saves the same row", async () => {
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Edit SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED" }));
    expect((screen.getByLabelText("Payer name (as on the bank line)") as HTMLInputElement).value).toBe("SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED");
    fireEvent.change(screen.getByLabelText("How related"), { target: { value: "third_party" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payer" }));
    await screen.findByRole("button", { name: "Add known payer" });
    expect(state.save.mock.calls[0][0]).toMatchObject({ id: "kp1", relation: "third_party", note: "Sister company", ifsc: "INDB0000006" });
  });

  it("remove asks once, then deletes", async () => {
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Remove SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED" }));
    expect(state.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));
    expect(state.del).toHaveBeenCalledWith("kp1");
  });

  it("a read-only role sees the list but no add / edit / remove", () => {
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit={false} />);
    expect(screen.getByText("SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add known payer" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("none yet: one plain line saying where they come from", () => {
    state.payers = [];
    render(<KnownPayersCard customerId="c-links" customerName="Links Infotech" canEdit />);
    expect(screen.getByText(/No known payers yet/)).toBeTruthy();
  });
});
