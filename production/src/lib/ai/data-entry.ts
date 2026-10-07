/**
 * AI data entry — anything pasted or photographed → proposed records (2 Oct 2026).
 *
 * Pardeep: "mere is app ke ai data entry agent bana do". A WhatsApp chat, an email, a
 * Hinglish note ("Sharma ji 15 seat, kal call"), a bill photo or a visiting card goes in;
 * a list of PROPOSED records comes out — lead, customer, expense, vendor bill, follow-up,
 * or a payment someone says they made. Nothing is written here: the operator reviews
 * each card and saves it through the same mutation the normal form uses (RLS and every
 * form rule still apply). A payment is never saved from here at all — money received
 * is recorded against an invoice, by a person.
 *
 * This file holds the prompt and the sanitizer. The model's JSON is untrusted: every
 * field is re-checked (GSTIN checksum, email shape, real dates, positive amounts under a
 * sane cap, categories from the fixed list) and anything that fails becomes null rather
 * than a plausible-looking wrong value.
 */
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { isValidGstin } from "@/lib/utils";

export const ENTRY_KINDS = ["lead", "customer", "expense", "vendor_bill", "task", "payment", "employee_advance"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface LeadFields {
  company: string | null; contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  plan: string | null; seats: number | null; domain: string | null; notes: string | null; follow_up_date: string | null;
}
export interface CustomerFields {
  name: string | null; contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  gstin: string | null; domain: string | null; address: string | null;
  /** R-174: the Indian state named in the input (address, card) — place of supply when there is no GSTIN. */
  state?: string | null;
}
export interface ExpenseFields {
  vendor_name: string | null; amount: number | null; expense_date: string | null; category: string; description: string | null;
  /** cash | upi | bank | card — what s.40A(3) turns on. */
  paid_by: string | null;
}
export interface VendorBillFields {
  vendor_name: string | null; vendor_gstin: string | null; bill_no: string | null; bill_date: string | null;
  subtotal: number | null; cgst: number | null; sgst: number | null; igst: number | null; total: number | null;
  /** The GSTIN the bill is made out TO — ITC only goes to that one (s.16(2)(aa)). */
  buyer_gstin: string | null;
  paid_by: string | null;
}
export interface TaskFields { title: string | null; due_date: string | null; company: string | null }
/** Company money handed to OUR staff for expenses — an asset with them, not an expense (R-101). */
export interface AdvanceFields { employee_name: string | null; amount: number | null; date: string | null; method: string | null; purpose: string | null }
export interface PaymentFields { payer: string | null; amount: number | null; received_on: string | null; reference: string | null; method: string | null }

interface ProposalBase { confidence: number; why: string; /** A GSTIN read but failing the checksum. */ gstinTyped?: string }
export type EntryProposal = ProposalBase & (
  | { kind: "lead"; fields: LeadFields }
  | { kind: "customer"; fields: CustomerFields }
  | { kind: "expense"; fields: ExpenseFields }
  | { kind: "vendor_bill"; fields: VendorBillFields }
  | { kind: "task"; fields: TaskFields }
  | { kind: "payment"; fields: PaymentFields }
  | { kind: "employee_advance"; fields: AdvanceFields });

export const MAX_PROPOSALS = 10;
export const MAX_INPUT_CHARS = 12_000;
const MAX_AMOUNT = 10_00_00_000; // ₹10 crore — above this it is a misread, not a bill

export function dataEntryPrompt(todayIST: string): string {
  return `You are the data-entry assistant inside ResellerOS, an Indian reseller's business app (Google Workspace, Microsoft 365, Zoho, hosting, domains).
Read the user's input (text in English, Hindi or Hinglish, and/or an image/PDF) and return EVERY record it contains, as JSON:
{"notes":[...],"entries":[{"kind":"lead|customer|expense|vendor_bill|task|payment","confidence":0..1,"why":"one short line: what in the input made this","fields":{...}}]}

Also return "notes": up to 3 short points where the input looks wrong under Indian law — GST (CGST/IGST Acts), Income-tax (TDS, cash limits s.40A(3)/269ST), Companies Act — each {"law":"Act + section","note":"..."}. Only real, specific provisions; no generic advice. Empty array if none.

Kinds and fields (use null for anything not stated — NEVER guess a phone, email, GSTIN, amount or date):
- lead: someone interested in buying. fields: company, contact_name, contact_email, contact_phone, plan (product named, e.g. "Google Workspace Business Starter"), seats (integer), domain, notes (short), follow_up_date (YYYY-MM-DD if a callback/follow-up day is stated)
- customer: an existing buyer whose details are being recorded (e.g. a visiting card of a client, "add customer ..."). fields: name (company), contact_name, contact_email, contact_phone, gstin, domain, address, state (the Indian state if written anywhere, e.g. in the address — null if not)
- expense: money WE spent without a GST tax invoice (cab, tea, petrol, small purchase). fields: vendor_name, amount (INR number), expense_date, category (one of: ${EXPENSE_CATEGORIES.join(", ")}), description, paid_by (cash|upi|bank|card, only if stated)
- vendor_bill: a supplier's tax invoice/bill to us (anything showing the supplier's GSTIN and GST). fields: vendor_name, vendor_gstin, buyer_gstin (the GSTIN it is billed TO), bill_no, bill_date, subtotal, cgst, sgst, igst, total, paid_by (cash|upi|bank|card, only if stated)
- task: a to-do or callback. fields: title (imperative, short), due_date (YYYY-MM-DD), company
- employee_advance: WE give money to our own employee/staff to spend on company expenses ("Prashant ko kharche ke liye 5000 advance", petty cash to office boy). Not a task, not an expense. fields: employee_name, amount, date (YYYY-MM-DD, today if "dena hai"/"diya"), method (bank_transfer|upi|cash|cheque, only if stated), purpose
- payment: someone says they PAID US. fields: payer, amount, received_on, reference (UTR/txn id), method (upi|neft|imps|rtgs|cheque|cash|card)

Rules:
- Today is ${todayIST} (India). Resolve "aaj"=today, "kal" for a future action = tomorrow, "parso" = day after; weekday names = the next such day.
- Amounts are rupees as plain numbers ("15k" = 15000, "1.2 lakh" = 120000). Phones: keep as written, with country code if given.
- A follow-up mentioned with a lead goes in the lead's follow_up_date, not a separate task.
- Several people/bills in one input → several entries (max ${MAX_PROPOSALS}).
- Nothing usable → {"entries":[]}.
Return JSON only.`;
}

/* ── sanitizer ─────────────────────────────────────────────────────────────── */

const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const email = (v: unknown): string | null => {
  const s = str(v, 120)?.toLowerCase() ?? null;
  return s && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(s) ? s : null;
};
const phone = (v: unknown): string | null => {
  const s = str(v, 30);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return null;
  return s.trim().startsWith("+") ? `+${digits}` : digits.length === 10 ? `+91${digits}` : `+${digits}`;
};
const gstin = (v: unknown): string | null => {
  const s = str(v, 20)?.toUpperCase().replace(/\s/g, "") ?? null;
  return s && isValidGstin(s) ? s : null;
};
const domain = (v: unknown): string | null => {
  const s = str(v, 120)?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") ?? null;
  return s && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
};
const money = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n < MAX_AMOUNT ? Math.round(n * 100) / 100 : null;
};
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n) : null;
};
/** A real calendar date within ±2 years of today, else null. */
export function cleanDate(v: unknown, todayIST: string): string | null {
  const s = str(v, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  const t = new Date(`${todayIST}T00:00:00Z`).getTime();
  return Math.abs(d.getTime() - t) <= 2 * 366 * 86400_000 ? s : null;
}
const category = (v: unknown): string => {
  const s = str(v, 60);
  const hit = EXPENSE_CATEGORIES.find((c) => c.toLowerCase() === (s ?? "").toLowerCase());
  return hit ?? "Other";
};
const PAID_BY = ["cash", "upi", "bank", "card"];
const paidBy = (v: unknown): string | null => {
  const s = str(v, 20)?.toLowerCase() ?? null;
  if (!s) return null;
  if (["neft", "rtgs", "imps", "cheque", "bank transfer", "netbanking"].includes(s)) return "bank";
  return PAID_BY.includes(s) ? s : null;
};
const METHODS = ["upi", "neft", "imps", "rtgs", "cheque", "cash", "card"];

function fieldsFor(kind: EntryKind, f: Record<string, unknown>, today: string): EntryProposal["fields"] | null {
  switch (kind) {
    case "lead": {
      const x: LeadFields = {
        company: str(f.company, 120), contact_name: str(f.contact_name, 80), contact_email: email(f.contact_email),
        contact_phone: phone(f.contact_phone), plan: str(f.plan, 80), seats: int(f.seats), domain: domain(f.domain),
        notes: str(f.notes, 500), follow_up_date: cleanDate(f.follow_up_date, today),
      };
      return x.company || x.contact_name || x.contact_email || x.contact_phone ? x : null;
    }
    case "customer": {
      const x: CustomerFields = {
        name: str(f.name, 120), contact_name: str(f.contact_name, 80), contact_email: email(f.contact_email),
        contact_phone: phone(f.contact_phone), gstin: gstin(f.gstin), domain: domain(f.domain), address: str(f.address, 300),
        state: str(f.state, 60),
      };
      return x.name || x.contact_name ? x : null;
    }
    case "expense": {
      const x: ExpenseFields = {
        vendor_name: str(f.vendor_name, 120), amount: money(f.amount), expense_date: cleanDate(f.expense_date, today) ?? today,
        category: category(f.category), description: str(f.description, 300), paid_by: paidBy(f.paid_by),
      };
      return x.amount ? x : null;
    }
    case "vendor_bill": {
      const x: VendorBillFields = {
        vendor_name: str(f.vendor_name, 120), vendor_gstin: gstin(f.vendor_gstin), bill_no: str(f.bill_no, 60),
        bill_date: cleanDate(f.bill_date, today), subtotal: money(f.subtotal), cgst: money(f.cgst), sgst: money(f.sgst),
        igst: money(f.igst), total: money(f.total), buyer_gstin: gstin(f.buyer_gstin), paid_by: paidBy(f.paid_by),
      };
      return x.total || x.vendor_name ? x : null;
    }
    case "task": {
      const x: TaskFields = { title: str(f.title, 160), due_date: cleanDate(f.due_date, today) ?? today, company: str(f.company, 120) };
      return x.title ? x : null;
    }
    case "employee_advance": {
      const m = str(f.method, 20)?.toLowerCase() ?? null;
      const method = m === "bank" || m === "neft" || m === "imps" || m === "rtgs" ? "bank_transfer" : m;
      const x: AdvanceFields = {
        employee_name: str(f.employee_name, 80), amount: money(f.amount), date: cleanDate(f.date, today) ?? today,
        method: method && ["bank_transfer", "upi", "cash", "cheque"].includes(method) ? method : null, purpose: str(f.purpose, 200),
      };
      return x.amount ? x : null;
    }
    case "payment": {
      const m = str(f.method, 20)?.toLowerCase() ?? null;
      const x: PaymentFields = {
        payer: str(f.payer, 120), amount: money(f.amount), received_on: cleanDate(f.received_on, today),
        reference: str(f.reference, 60), method: m && METHODS.includes(m) ? m : null,
      };
      return x.amount ? x : null;
    }
  }
}

/** The model's JSON → at most MAX_PROPOSALS checked proposals. Garbage in → []. */
export function sanitizeEntries(raw: unknown, todayIST: string): EntryProposal[] {
  const list = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  const out: EntryProposal[] = [];
  for (const e of list) {
    if (out.length >= MAX_PROPOSALS) break;
    const r = e as Record<string, unknown>;
    const kind = typeof r?.kind === "string" ? (r.kind as EntryKind) : null;
    if (!kind || !ENTRY_KINDS.includes(kind)) continue;
    const fields = fieldsFor(kind, (r.fields as Record<string, unknown>) ?? {}, todayIST);
    if (!fields) continue;
    const c = Number(r.confidence);
    /* A GSTIN the model read that failed the checksum: the field is null, but the card
       says what was read, so the operator can check it with the customer/vendor. */
    const rf = (r.fields as Record<string, unknown>) ?? {};
    const typedG = typeof (rf.gstin ?? rf.vendor_gstin) === "string" ? String(rf.gstin ?? rf.vendor_gstin).trim().toUpperCase().replace(/s/g, "") : "";
    const gField = (fields as unknown as Record<string, unknown>).gstin ?? (fields as unknown as Record<string, unknown>).vendor_gstin;
    out.push({
      kind, fields, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5,
      why: str(r.why, 160) ?? "",
      ...(typedG && !gField && /^[0-9]{2}[A-Z0-9]{13}$/.test(typedG) ? { gstinTyped: typedG } : {}),
    } as EntryProposal);
  }
  return out;
}

/** Phones / emails / GSTINs / domains in a proposal — what a duplicate is looked up by. */
export function proposalKeys(p: EntryProposal): { phones: string[]; emails: string[]; gstins: string[]; names: string[] } {
  const f = p.fields as unknown as Record<string, unknown>;
  const s = (k: string) => (typeof f[k] === "string" && f[k] ? [f[k] as string] : []);
  return {
    phones: s("contact_phone"),
    emails: s("contact_email"),
    gstins: [...s("gstin"), ...s("vendor_gstin")],
    names: [...s("company"), ...s("name")],
  };
}

export interface AiLawNote { law: string; note: string }
/** The model's own law notes — shown apart from the coded rules, as "AI note — check with your CA". */
export function sanitizeNotes(raw: unknown): AiLawNote[] {
  const list = (raw as { notes?: unknown })?.notes;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3).map((n) => ({ law: str((n as Record<string, unknown>)?.law, 80) ?? "", note: str((n as Record<string, unknown>)?.note, 240) ?? "" }))
    .filter((n) => n.law && n.note);
}
