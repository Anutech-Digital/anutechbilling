/**
 * R-1531 — Section 31(3)(a) revised-invoice reminder.
 *
 * The gap (before R-1531): a business that switches Settings → GST registration to
 * "Registered" with an effective date in the past (gst-registration.ts:105-112 saves
 * gst_registered_from) keeps the Bills of Supply it issued between that date and the day it
 * got its registration certificate — they were frozen as supplier_gst_status 'unregistered'
 * at issue (migration 20261018022629_r1529_bill_of_supply.sql:93-94). Nothing in
 * lib/compliance or on /today or /compliance reads them: compliance-view.tsx and
 * today/page.tsx:121-130 only list calendar filings. So the owner is never told that the
 * law wants a revised Tax Invoice for each within one month of the certificate.
 */
import { describe, expect, it } from "vitest";

import {
  REVISED_INVOICE_GRACE_DAYS,
  revisedInvoiceDeadline,
  revisedInvoiceReminder,
  revisedInvoiceTodayItem,
  revisedInvoiceWindow,
  type RevisedInvoiceBill,
  type RevisedInvoiceSettings,
} from "./revised-invoice";
import { gstRegistrationPatch, gstRegistrationProblem, gstRegistrationFromRow } from "./gst-registration";

const bos = (id: string, invoice_date: string, over: Partial<RevisedInvoiceBill> = {}): RevisedInvoiceBill => ({
  id, invoice_date, amount: 10000, taxable_value: 10000, status: "pending", customer_name: "Acme",
  document_kind: "bill_of_supply", supplier_gst_status: "unregistered", ...over,
});

const registered: RevisedInvoiceSettings = { saved: "registered", registeredFrom: "2026-09-01", rcDate: "2026-10-10" };

describe("revisedInvoiceDeadline — one month from the certificate (Section 31(3)(a))", () => {
  it("is the same day next month", () => {
    expect(revisedInvoiceDeadline("2026-10-10")).toBe("2026-11-10");
    expect(revisedInvoiceDeadline("2026-12-15")).toBe("2027-01-15");
  });
  it("stops at the last day of a shorter month", () => {
    expect(revisedInvoiceDeadline("2027-01-31")).toBe("2027-02-28");
    expect(revisedInvoiceDeadline("2028-01-31")).toBe("2028-02-29");
    expect(revisedInvoiceDeadline("2026-08-31")).toBe("2026-09-30");
  });
});

describe("revisedInvoiceWindow", () => {
  it("runs from the effective date to the certificate date", () => {
    expect(revisedInvoiceWindow(registered, "2026-10-19")).toEqual({ from: "2026-09-01", to: "2026-10-10" });
  });
  it("runs to today when the certificate date is not entered yet", () => {
    expect(revisedInvoiceWindow({ ...registered, rcDate: null }, "2026-10-19")).toEqual({ from: "2026-09-01", to: "2026-10-19" });
  });
  it("is null unless the business is Registered with an effective date", () => {
    expect(revisedInvoiceWindow({ ...registered, registeredFrom: null }, "2026-10-19")).toBeNull();
    expect(revisedInvoiceWindow({ ...registered, saved: "unregistered" }, "2026-10-19")).toBeNull();
    expect(revisedInvoiceWindow({ ...registered, saved: "composition" }, "2026-10-19")).toBeNull();
    expect(revisedInvoiceWindow({ ...registered, saved: null }, "2026-10-19")).toBeNull();
  });
  it("is null when the effective date is still in the future", () => {
    expect(revisedInvoiceWindow({ ...registered, registeredFrom: "2026-11-01", rcDate: null }, "2026-10-19")).toBeNull();
  });
});

describe("revisedInvoiceReminder", () => {
  const today = "2026-10-19";

  it("counts the unregistered Bills of Supply in the window, with the deadline", () => {
    const r = revisedInvoiceReminder({
      settings: registered,
      today,
      bills: [bos("BOS-1", "2026-09-05"), bos("BOS-2", "2026-10-10", { amount: 2500, taxable_value: null })],
    });
    expect(r).not.toBeNull();
    expect(r!.bills.map((b) => b.id)).toEqual(["BOS-1", "BOS-2"]);
    expect(r!.count).toBe(2);
    expect(r!.total).toBe(12500);
    expect(r!.deadline).toBe("2026-11-10");
    expect(r!.daysLeft).toBe(22);
    expect(r!.state).toBe("open");
  });

  it("shows nothing when there are no such bills (doneWhen: na hon to kuch nahi)", () => {
    expect(revisedInvoiceReminder({ settings: registered, today, bills: [] })).toBeNull();
  });

  it("leaves out bills before the effective date, after the certificate, composition bills, tax invoices, drafts and voids", () => {
    const r = revisedInvoiceReminder({
      settings: registered,
      today,
      bills: [
        bos("before", "2026-08-31"),
        bos("after-rc", "2026-10-11"),
        bos("comp", "2026-09-10", { supplier_gst_status: "composition" }),
        bos("inv", "2026-09-10", { document_kind: "tax_invoice", supplier_gst_status: "registered" }),
        bos("draft", "2026-09-10", { status: "draft" }),
        bos("void", "2026-09-10", { status: "void" }),
        bos("ok", "2026-09-10", { status: "paid" }),
      ],
    });
    expect(r!.bills.map((b) => b.id)).toEqual(["ok"]);
  });

  it("still reminds when the certificate date is missing — with no deadline, and asks for it", () => {
    const r = revisedInvoiceReminder({ settings: { ...registered, rcDate: null }, today, bills: [bos("BOS-1", "2026-10-15")] });
    expect(r!.state).toBe("no_rc_date");
    expect(r!.deadline).toBeNull();
    expect(r!.daysLeft).toBeNull();
  });

  it("says overdue after the deadline, then stops after the grace period", () => {
    const bills = [bos("BOS-1", "2026-09-05")];
    const late = revisedInvoiceReminder({ settings: registered, today: "2026-11-11", bills });
    expect(late!.state).toBe("overdue");
    expect(late!.daysLeft).toBe(-1);
    const lastDay = revisedInvoiceReminder({ settings: registered, today: `2026-12-${String(10 + REVISED_INVOICE_GRACE_DAYS - 30).padStart(2, "0")}`, bills });
    expect(lastDay!.state).toBe("overdue");
    expect(revisedInvoiceReminder({ settings: registered, today: "2026-12-11", bills })).toBeNull();
  });

  it("orders the list by date then number", () => {
    const r = revisedInvoiceReminder({
      settings: registered, today,
      bills: [bos("BOS-3", "2026-09-20"), bos("BOS-2", "2026-09-05"), bos("BOS-1", "2026-09-05")],
    });
    expect(r!.bills.map((b) => b.id)).toEqual(["BOS-1", "BOS-2", "BOS-3"]);
  });
});

describe("revisedInvoiceTodayItem", () => {
  const bills = [bos("BOS-1", "2026-09-05"), bos("BOS-2", "2026-09-06")];

  it("is a GST row on /today linking to the reminder on /compliance", () => {
    const r = revisedInvoiceReminder({ settings: registered, today: "2026-10-19", bills })!;
    const item = revisedInvoiceTodayItem(r)!;
    expect(item.kind).toBe("compliance");
    expect(item.href).toBe("/compliance#revised-invoices");
    expect(item.title).toBe("Issue revised tax invoices for 2 Bills of Supply · by 10 Nov 2026");
    expect(item.due_at).toBe(new Date("2026-11-10T00:00:00+05:30").toISOString());
    expect(item.priority).toBe(62);
  });

  it("is urgent inside the last week and when late", () => {
    const soon = revisedInvoiceReminder({ settings: registered, today: "2026-11-05", bills })!;
    expect(revisedInvoiceTodayItem(soon)!.priority).toBe(78);
    const late = revisedInvoiceReminder({ settings: registered, today: "2026-11-12", bills })!;
    expect(revisedInvoiceTodayItem(late)!.priority).toBe(88);
    expect(revisedInvoiceTodayItem(late)!.title).toContain("deadline was 10 Nov 2026");
  });

  it("asks for the certificate date when it is missing", () => {
    const r = revisedInvoiceReminder({ settings: { ...registered, rcDate: null }, today: "2026-10-19", bills: [bos("BOS-1", "2026-10-15")] })!;
    const item = revisedInvoiceTodayItem(r)!;
    expect(item.title).toBe("Issue a revised tax invoice for 1 Bill of Supply · add your GST certificate date");
    expect(item.due_at).toBeNull();
    expect(item.priority).toBe(78);
  });
});

describe("gst-registration — certificate date (R-1531)", () => {
  it("cannot be before the effective date", () => {
    expect(gstRegistrationProblem({ status: "registered", gstin: "29ABCDE1234F1Z5", compositionRate: 6, registeredFrom: "2026-09-01", rcDate: "2026-08-31" }))
      .toMatch(/certificate date cannot be before the registration effective date/i);
  });
  it("cannot be in the future", () => {
    expect(gstRegistrationProblem({ status: "registered", gstin: "29ABCDE1234F1Z5", compositionRate: 6, registeredFrom: "2026-09-01", rcDate: "2026-10-20", today: "2026-10-19" }))
      .toMatch(/cannot be after today/i);
  });
  it("is saved only for Registered, and cleared otherwise", () => {
    expect(gstRegistrationPatch({ status: "registered", gstin: "x", compositionRate: 6, registeredFrom: "2026-09-01", rcDate: "2026-10-10" }).gst_rc_date)
      .toBe("2026-10-10");
    expect(gstRegistrationPatch({ status: "composition", gstin: "x", compositionRate: 6, registeredFrom: "2026-09-01", rcDate: "2026-10-10" }).gst_rc_date)
      .toBeNull();
  });
  it("is left out of the patch when the column is not in this database yet", () => {
    expect("gst_rc_date" in gstRegistrationPatch({ status: "registered", gstin: "x", compositionRate: 6, registeredFrom: "2026-09-01", rcDate: "2026-10-10" }, { rcDateColumn: false }))
      .toBe(false);
  });
  it("reads from the row", () => {
    expect(gstRegistrationFromRow({ gst_registration: "registered", gst_registered_from: "2026-09-01", gst_rc_date: "2026-10-10" }, null).rcDate)
      .toBe("2026-10-10");
  });
});
