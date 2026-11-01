// @vitest-environment jsdom
/**
 * R-2013 (DPDP, part B): Settings → Privacy requests. The owner sees each confirmed request
 * with its due-by date and an Overdue badge once it is late, and the next steps: Export
 * (JSON / CSV), Mark corrected (open only), Close (not on a closed one). The export carries
 * every lead / customer / consent / invoice record of that person.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";

import { RequestTable } from "./request-table";
import { dueState, exportCsvRows, sortRequests, exportFileStem, privacyRequestSchema, type PrivacyRequestRow } from "@/lib/privacy/requests";

afterEach(() => cleanup());

const row = (over: Partial<PrivacyRequestRow>): PrivacyRequestRow => ({
  id: "r1", full_name: "Asha Verma", email: "asha@example.in", phone: null, kind: "erasure", details: null,
  status: "open", verified_at: "2026-10-01T10:00:00Z", due_by: "2026-10-31", lead_ids: ["L-1"], customer_ids: [],
  note: null, exported_at: null, closed_at: null, created_at: "2026-10-01T09:58:00Z", ...over,
});

describe("dueState — 30 days, overdue badge", () => {
  it("counts days left, says due today, and flags overdue", () => {
    expect(dueState("2026-11-10", "open", "2026-11-02")).toMatchObject({ daysLeft: 8, overdue: false, label: "8 days left" });
    expect(dueState("2026-11-02", "open", "2026-11-02")).toMatchObject({ overdue: false, label: "Due today" });
    expect(dueState("2026-10-31", "open", "2026-11-02")).toMatchObject({ overdue: true, label: "Overdue by 2 days" });
    expect(dueState("2026-10-31", "corrected", "2026-11-02").overdue).toBe(true);
    expect(dueState("2026-10-31", "closed", "2026-11-02").overdue).toBe(false);
  });

  it("lists open requests first, soonest due first; closed last", () => {
    const s = sortRequests([
      row({ id: "a", status: "closed", due_by: "2026-10-01" }),
      row({ id: "b", due_by: "2026-11-20" }),
      row({ id: "c", status: "corrected", due_by: "2026-11-05" }),
    ]);
    expect(s.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

describe("the list", () => {
  const today = "2026-11-02";
  const handlers = () => ({ onExport: vi.fn(), onCorrected: vi.fn(), onClose: vi.fn() });

  it("shows who, what, due by and Overdue for a late open request, with all next steps", () => {
    const h = handlers();
    render(<RequestTable rows={[row({})]} todayIst={today} {...h} />);
    const r = screen.getByTestId("privacy-row-r1");
    expect(within(r).getByText("Asha Verma")).toBeTruthy();
    expect(within(r).getByText("Delete my data")).toBeTruthy();
    expect(within(r).getByText("31 Oct 2026")).toBeTruthy();
    expect(within(r).getByText("Overdue by 2 days")).toBeTruthy();
    expect(within(r).getByText("1 lead, 0 customers")).toBeTruthy();
    fireEvent.click(within(r).getByRole("button", { name: /as JSON/ }));
    fireEvent.click(within(r).getByRole("button", { name: /as CSV/ }));
    fireEvent.click(within(r).getByRole("button", { name: "Mark corrected" }));
    fireEvent.click(within(r).getByRole("button", { name: "Close" }));
    expect(h.onExport.mock.calls.map((c) => c[1])).toEqual(["json", "csv"]);
    expect(h.onCorrected).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("a closed request: no Overdue badge, no Mark corrected / Close; export still there", () => {
    render(<RequestTable rows={[row({ status: "closed", closed_at: "2026-11-01T10:00:00Z" })]} todayIst={today} {...handlers()} />);
    const r = screen.getByTestId("privacy-row-r1");
    expect(within(r).queryByText(/Overdue/)).toBeNull();
    expect(within(r).queryByRole("button", { name: "Close" })).toBeNull();
    expect(within(r).queryByRole("button", { name: "Mark corrected" })).toBeNull();
    expect(within(r).getByText("Closed")).toBeTruthy();
  });

  it("nobody matched → says so, and Export is off (there is nothing to export)", () => {
    render(<RequestTable rows={[row({ lead_ids: [], due_by: "2026-11-30" })]} todayIst={today} {...handlers()} />);
    const r = screen.getByTestId("privacy-row-r1");
    expect(within(r).getByText("No matching lead or customer")).toBeTruthy();
    expect((within(r).getByRole("button", { name: /as JSON/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(r).getByText("28 days left")).toBeTruthy();
  });
});

describe("the export", () => {
  it("CSV has one line per field of each record, empty fields left out", () => {
    const { headers, rows } = exportCsvRows({
      request: { id: "r1", kind: "access", name: "Asha", email: "a@example.in", phone: null, confirmed: "2026-11-01", due_by: "2026-12-01" },
      leads: [{ id: "L-1", contact_email: "a@example.in", contact_phone: null }],
      customers: [{ id: "C-1", name: "Asha Traders", contact_persons: [{ name: "Asha" }] }],
      consent: [{ id: "e1", choice: "withdrawn" }],
      invoices: [{ id: "I-1", amount: 1180 }],
    });
    expect(headers).toEqual(["Section", "Record", "Field", "Value"]);
    expect(rows).toContainEqual(["lead", "L-1", "contact_email", "a@example.in"]);
    expect(rows).toContainEqual(["customer", "C-1", "contact_persons", '[{"name":"Asha"}]']);
    expect(rows).toContainEqual(["consent", "e1", "choice", "withdrawn"]);
    expect(rows).toContainEqual(["invoice", "I-1", "amount", "1180"]);
    expect(rows.some((r) => r[2] === "contact_phone" || r[2] === "phone")).toBe(false);
    expect(exportFileStem("Asha Verma!")).toBe("privacy-request-asha-verma");
  });
});

describe("the public form's rules", () => {
  it("needs an email (the code goes there); a correction or nomination needs details", () => {
    expect(privacyRequestSchema.safeParse({ fullName: "Asha", email: "", kind: "access" }).success).toBe(false);
    expect(privacyRequestSchema.safeParse({ fullName: "Asha", email: "A@Example.in", kind: "access" })).toMatchObject({ success: true, data: { email: "a@example.in" } });
    expect(privacyRequestSchema.safeParse({ fullName: "Asha", email: "a@example.in", kind: "correction" }).success).toBe(false);
    expect(privacyRequestSchema.safeParse({ fullName: "Asha", email: "a@example.in", kind: "nominate", details: "Ravi, ravi@example.in" }).success).toBe(true);
    expect(privacyRequestSchema.safeParse({ fullName: "Asha", email: "a@example.in", kind: "access", phone: "123" }).success).toBe(false);
  });
});
