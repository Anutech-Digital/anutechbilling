/**
 * R-2005 — a bill read by the AI (lib/accounting/bill-reader.ts) fills "The bill is not in the
 * books yet — record it now" on a money-out bank line (debit-pay-for-section.tsx), and tells the
 * operator when the bill's vendor is not the vendor picked for the line.
 */
import { normaliseCompanyName } from "@/app/api/ai/extract-bill/buyer-check";
import type { BillRead } from "@/lib/accounting/bill-reader";
import type { NewBillDraft, VendorLite } from "./debit-pay-for";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => { const x = Number(v); return v != null && v !== "" && Number.isFinite(x) ? x : null; };
const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;
const gstinOf = (v: unknown) => { const g = str(v).toUpperCase(); return GSTIN.test(g) ? g : null; };

/**
 * The new-bill draft after a read: only what the reader found is overwritten. Expense vs COGS
 * follows the reader's resale product (R-1767), the category only from our own lists, ₹ rounded
 * (the RPC books whole rupees). A foreign-currency bill fills number and date only — this form has
 * no exchange rate, so the ₹ amounts are typed by hand.
 */
export function newBillFromRead(
  prev: NewBillDraft,
  read: Pick<BillRead, "fields" | "resale">,
  cats: { expense: readonly string[]; cogs: readonly string[] },
): { bill: NewBillDraft; note: string | null } {
  const f = read.fields;
  const bill: NewBillDraft = { ...prev, pay: 0 };
  const billNo = str(f.bill_no);
  if (billNo) bill.billNo = billNo;
  const date = str(f.bill_date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) bill.billDate = date;

  if (read.resale) {
    const g = str(f.category_guess);
    bill.kind = "cogs";
    bill.category = cats.cogs.includes(g) ? g : cats.cogs.includes("COGS-Other") ? "COGS-Other" : "";
  } else {
    const c = str(f.expense_category);
    if (prev.kind !== "expense") bill.category = "";
    bill.kind = "expense";
    if (cats.expense.includes(c)) bill.category = c;
  }

  const notes: string[] = [];
  const cur = (str(f.currency) || "INR").toUpperCase();
  if (cur !== "INR") {
    bill.taxable = 0; bill.gst = 0;
    notes.push(`The bill is in ${cur} — type the ₹ value before GST and the GST by hand.`);
  } else {
    const gst = (num(f.cgst) ?? 0) + (num(f.sgst) ?? 0) + (num(f.igst) ?? 0);
    const subtotal = num(f.subtotal);
    const total = num(f.total);
    const taxable = subtotal ?? (total != null ? total - gst : null);
    if (taxable != null) bill.taxable = Math.max(0, Math.round(taxable));
    bill.gst = Math.max(0, Math.round(gst));
  }
  const proforma = f.document_type === "proforma";
  bill.itc = bill.gst > 0 && !proforma;
  if (proforma) notes.push("This is a proforma, not a tax invoice — no GST input credit. Record it when the tax invoice comes, or record it without credit.");
  return { bill, note: notes.length ? notes.join(" ") : null };
}

export interface BillVendorMismatch {
  readName: string;
  readGstin: string | null;
  /** The vendor master's entry for the bill's vendor — null: not in the master (add it as new). */
  match: VendorLite | null;
}

const sameName = (a: string, b: string) => {
  const x = normaliseCompanyName(a), y = normaliseCompanyName(b);
  return !!x && !!y && x === y;
};

/**
 * null when the bill names no vendor or names the vendor picked for the line. A GSTIN on both
 * decides; otherwise the names (without "Pvt Ltd", "M/s"). The master is searched by GSTIN when the
 * bill has one, else by name.
 */
export function billVendorCheck(
  fields: Record<string, unknown>,
  current: Pick<VendorLite, "name" | "gstin"> & { id?: string } | null,
  vendors: readonly VendorLite[],
): BillVendorMismatch | null {
  const readName = str(fields.vendor_name);
  const readGstin = gstinOf(fields.vendor_gstin);
  if (!readName && !readGstin) return null;
  if (current) {
    const curGstin = gstinOf(current.gstin);
    const same = readGstin && curGstin ? readGstin === curGstin : !!readName && sameName(readName, current.name);
    if (same) return null;
  }
  const match = readGstin
    ? vendors.find((v) => gstinOf(v.gstin) === readGstin) ?? null
    : vendors.find((v) => sameName(v.name, readName)) ?? null;
  if (current?.id && match?.id === current.id) return null;
  return { readName: readName || match?.name || readGstin || "", readGstin, match };
}
