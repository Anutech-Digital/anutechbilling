/**
 * AI Entry: a reviewed proposal → the insert its normal form would make (2 Oct 2026).
 * Pure, so what reaches the database from an AI read is pinned down by tests, and the
 * law checks for a proposal are computed the same way on every render.
 */
import type { AdvanceFields } from "@/lib/ai/data-entry";
import type { EntryProposal, LeadFields, CustomerFields, ExpenseFields, VendorBillFields, TaskFields } from "@/lib/ai/data-entry";
import { checkExpense, checkVendorBill, checkPayment, checkCustomer, type LawWarning, type Party } from "@/lib/compliance/entry-rules";
import { stateCodeFromGstin, stateCodeFromName } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE } from "@/lib/utils";

export interface Me { userId: string }

export function leadInsert(f: LeadFields, me: Me, now = Date.now()) {
  return {
    id: "L-" + now.toString(36).toUpperCase(),
    company: f.company ?? "",
    contact_name: f.contact_name,
    contact_email: f.contact_email,
    contact_phone: f.contact_phone,
    plan: f.plan,
    seats: f.seats,
    domain: f.domain,
    notes: f.notes,
    follow_up_date: f.follow_up_date,
    stage: "new" as const,
    source: "ai-entry",
    priority: "medium" as const,
    owner_id: me.userId,
    created_by: me.userId,
  };
}

export function customerInsert(f: CustomerFields) {
  // R-174: GSTIN first; else a state the input names (exact GST state only — never guessed).
  const state = stateCodeFromGstin(f.gstin) ?? stateCodeFromName(f.state);
  return {
    name: (f.name ?? f.contact_name ?? "").trim(),
    contact_name: f.contact_name,
    contact_email: f.contact_email,
    contact_phone: f.contact_phone,
    gstin: f.gstin,
    domain: f.domain,
    address: f.address,
    ...(state ? { state_code: state, state: GST_STATE_BY_CODE[state] ?? null } : {}),
  };
}

export function expenseInsert(f: ExpenseFields) {
  const paid = !!f.paid_by;
  return {
    amount: Math.round(f.amount ?? 0),
    category: f.category,
    expense_date: f.expense_date!,
    vendor_name: f.vendor_name,
    description: f.description,
    payment_method: f.paid_by,
    paid,
    paid_date: paid ? f.expense_date : null,
  };
}

export function vendorBillInsert(f: VendorBillFields) {
  return {
    vendor_name: (f.vendor_name ?? "").trim(),
    vendor_gstin: f.vendor_gstin,
    bill_no: f.bill_no,
    bill_date: f.bill_date!,
    subtotal: Math.round(f.subtotal ?? Math.max(0, (f.total ?? 0) - (f.cgst ?? 0) - (f.sgst ?? 0) - (f.igst ?? 0))),
    cgst: Math.round(f.cgst ?? 0),
    sgst: Math.round(f.sgst ?? 0),
    igst: Math.round(f.igst ?? 0),
    total: Math.round(f.total ?? 0),
  };
}

/** A follow-up at 10:00 IST on its day. */
export function taskInsert(f: TaskFields) {
  return { title: f.title ?? "Follow up", due_at: `${f.due_date}T10:00:00+05:30`, kind: "followup" as const };
}

/** The Employee Advances page, its "Give advance" form open and filled (2 Oct 2026). */
export function advanceFormHref(f: AdvanceFields): string {
  const q = new URLSearchParams({ give: "1" });
  if (f.employee_name) q.set("name", f.employee_name);
  if (f.amount) q.set("amount", String(Math.round(f.amount)));
  if (f.date) q.set("date", f.date);
  if (f.method) q.set("method", f.method);
  if (f.purpose) q.set("purpose", f.purpose);
  return `/accounting/advances?${q.toString()}`;
}

/** What still has to be filled before this can be saved — named, so the button can say why. */
export function missingFor(p: EntryProposal): string | null {
  switch (p.kind) {
    case "lead": return p.fields.company || p.fields.contact_name || p.fields.contact_phone || p.fields.contact_email ? null : "Add a company, name or phone.";
    case "customer": return !p.fields.name ? "Add the company name." : !p.fields.contact_name ? "Add the contact person (a customer needs one)."
      /* R-174: without a place of supply the customer's GST invoice is refused. */
      : !stateCodeFromGstin(p.fields.gstin) && !stateCodeFromName(p.fields.state) ? "Add the state (e.g. Punjab) or a valid GSTIN — the GST invoice needs it." : null;
    case "expense": return !p.fields.amount ? "Add the amount." : !p.fields.expense_date ? "Add the date." : null;
    case "vendor_bill": return !p.fields.vendor_name ? "Add the vendor." : !p.fields.total ? "Add the bill total." : !p.fields.bill_date ? "Add the bill date." : null;
    case "task": return !p.fields.title ? "Add what to do." : !p.fields.due_date ? "Add the day." : null;
    case "payment": return null;
    case "employee_advance": return !p.fields.amount ? "Add the amount." : !p.fields.employee_name ? "Add who it is for." : null;
  }
}

/** The coded Indian-law checks for this proposal as it stands now. */
export function warningsFor(p: EntryProposal, us: Party, todayIST: string, ctx: { vendorYtd?: number } = {}): LawWarning[] {
  switch (p.kind) {
    case "expense": return checkExpense({ ...p.fields, ytd: ctx.vendorYtd ?? 0 }, todayIST);
    case "vendor_bill": return checkVendorBill(p.fields, us, todayIST);
    case "payment": return checkPayment(p.fields);
    case "customer": return checkCustomer({ gstinTyped: p.gstinTyped ?? null, gstinValid: false });
    default: return [];
  }
}
