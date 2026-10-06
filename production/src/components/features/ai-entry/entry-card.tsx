"use client";

/**
 * One proposed record from AI Entry (2 Oct 2026): editable fields, existing matches, the
 * coded Indian-law checks (live as fields change), and Save through the normal mutation.
 * A "stop" warning needs an explicit "I understand" before Save. A payment is never saved
 * here — it links to Invoices, where money received is recorded by a person.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, rupee } from "@/lib/utils";
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import type { EntryProposal } from "@/lib/ai/data-entry";
import type { ProposalWithMatches } from "@/app/api/ai/data-entry/route";
import { advanceFormHref, warningsFor, missingFor, leadInsert, customerInsert, expenseInsert, vendorBillInsert, taskInsert } from "@/lib/ai/entry-save";
import { hasStop, type Party } from "@/lib/compliance/entry-rules";
import { useCreateLead } from "@/lib/queries/leads";
import { useCreateCustomer } from "@/lib/queries/customers";
import { useCreateExpense } from "@/lib/queries/expenses";
import { useCreateVendorBill } from "@/lib/queries/vendor-bills";
import { useCreateTask } from "@/lib/queries/tasks";

type FieldDef = { key: string; label: string; type?: "text" | "number" | "date" | "select"; options?: readonly string[]; wide?: boolean };

const FIELDS: Record<EntryProposal["kind"], FieldDef[]> = {
  lead: [
    { key: "company", label: "Company" }, { key: "contact_name", label: "Contact" },
    { key: "contact_phone", label: "Phone" }, { key: "contact_email", label: "Email" },
    { key: "plan", label: "Interested in" }, { key: "seats", label: "Seats", type: "number" },
    { key: "domain", label: "Domain" }, { key: "follow_up_date", label: "Follow up on", type: "date" },
    { key: "notes", label: "Notes", wide: true },
  ],
  customer: [
    { key: "name", label: "Company" }, { key: "contact_name", label: "Contact person" },
    { key: "contact_phone", label: "Phone" }, { key: "contact_email", label: "Email" },
    { key: "gstin", label: "GSTIN" }, { key: "domain", label: "Domain" },
    /* R-174: place of supply when there is no GSTIN — the GST invoice needs one. */
    { key: "state", label: "State (if no GSTIN)" },
    { key: "address", label: "Address", wide: true },
  ],
  expense: [
    { key: "vendor_name", label: "Paid to" }, { key: "amount", label: "Amount ₹", type: "number" },
    { key: "expense_date", label: "Date", type: "date" }, { key: "category", label: "Category", type: "select", options: EXPENSE_CATEGORIES },
    { key: "paid_by", label: "Paid by", type: "select", options: ["", "cash", "upi", "bank", "card"] },
    { key: "description", label: "Description", wide: true },
  ],
  vendor_bill: [
    { key: "vendor_name", label: "Vendor" }, { key: "vendor_gstin", label: "Vendor GSTIN" },
    { key: "bill_no", label: "Bill no." }, { key: "bill_date", label: "Bill date", type: "date" },
    { key: "subtotal", label: "Taxable ₹", type: "number" }, { key: "total", label: "Total ₹", type: "number" },
    { key: "cgst", label: "CGST ₹", type: "number" }, { key: "sgst", label: "SGST ₹", type: "number" },
    { key: "igst", label: "IGST ₹", type: "number" }, { key: "buyer_gstin", label: "Billed to GSTIN" },
    { key: "paid_by", label: "Paid by", type: "select", options: ["", "cash", "upi", "bank", "card"] },
  ],
  task: [
    { key: "title", label: "To do", wide: true }, { key: "due_date", label: "On", type: "date" }, { key: "company", label: "For" },
  ],
  employee_advance: [
    { key: "employee_name", label: "Given to" }, { key: "amount", label: "Amount ₹", type: "number" },
    { key: "date", label: "Date", type: "date" },
    { key: "method", label: "Paid by", type: "select", options: ["", "bank_transfer", "upi", "cash", "cheque"] },
    { key: "purpose", label: "For", wide: true },
  ],
  payment: [
    { key: "payer", label: "From" }, { key: "amount", label: "Amount ₹", type: "number" },
    { key: "received_on", label: "Received on", type: "date" },
    { key: "method", label: "Method", type: "select", options: ["", "upi", "neft", "imps", "rtgs", "cheque", "cash", "card"] },
    { key: "reference", label: "UTR / reference" },
  ],
};

const KIND_LABEL: Record<EntryProposal["kind"], string> = {
  lead: "Lead", customer: "Customer", expense: "Expense", vendor_bill: "Vendor bill", task: "Follow-up", payment: "Payment received", employee_advance: "Employee advance",
};

const invoicesHref = (payer: string | null): Route => (payer ? `/invoices?q=${encodeURIComponent(payer)}` : "/invoices") as Route;

const MATCH_HREF = (m: { type: string; id: string }) =>
  (m.type === "lead" ? `/leads?lead=${m.id}` : m.type === "customer" ? `/customers/${m.id}` : `/accounting/vendors`) as Route;

export function EntryCard({ initial, us, todayIST, userId, onDone }: {
  initial: ProposalWithMatches;
  us: Party;
  todayIST: string;
  userId: string;
  onDone: (state: "saved" | "discarded", label?: string) => void;
}) {
  const [p, setP] = React.useState<EntryProposal>(initial);
  const [ack, setAck] = React.useState(false);
  const [saved, setSaved] = React.useState<{ href: Route; label: string } | null>(null);

  const createLead = useCreateLead();
  const createCustomer = useCreateCustomer();
  const createExpense = useCreateExpense();
  const createBill = useCreateVendorBill();
  const createTask = useCreateTask();
  const pending = createLead.isPending || createCustomer.isPending || createExpense.isPending || createBill.isPending || createTask.isPending;

  const warnings = warningsFor(p, us, todayIST, initial.context);
  const stop = hasStop(warnings);
  const missing = missingFor(p);
  const fields = p.fields as unknown as Record<string, string | number | null>;

  const setField = (key: string, def: FieldDef, raw: string) => {
    const v = def.type === "number" ? (raw === "" ? null : Number(raw)) : raw === "" ? null : raw;
    setP((cur) => ({ ...cur, fields: { ...(cur.fields as object), [key]: key === "category" ? (v ?? "Other") : v } }) as unknown as EntryProposal);
  };

  const save = async () => {
    try {
      if (p.kind === "lead") {
        const row = await createLead.mutateAsync(leadInsert(p.fields, { userId }));
        setSaved({ href: `/leads?lead=${row.id}` as Route, label: "Open lead" });
      } else if (p.kind === "customer") {
        const row = await createCustomer.mutateAsync(customerInsert(p.fields));
        setSaved({ href: `/customers/${row.id}` as Route, label: "Open customer" });
      } else if (p.kind === "expense") {
        const row = await createExpense.mutateAsync(expenseInsert(p.fields));
        setSaved({ href: `/accounting/expenses?edit=${row.id}` as Route, label: "Open expense" });
      } else if (p.kind === "vendor_bill") {
        await createBill.mutateAsync(vendorBillInsert(p.fields));
        setSaved({ href: "/accounting/bills" as Route, label: "Open bills" });
      } else if (p.kind === "task") {
        const lead = initial.matches.find((m) => m.type === "lead");
        const cust = initial.matches.find((m) => m.type === "customer");
        await createTask.mutateAsync({ ...taskInsert(p.fields), lead_id: lead?.id ?? null, customer_id: cust?.id ?? null });
        setSaved({ href: "/tasks" as Route, label: "Open tasks" });
      }
      onDone("saved", KIND_LABEL[p.kind]);
    } catch {
      /* the mutation's own toast already says why */
    }
  };

  return (
    <div className={cn("rounded-lg border bg-paper p-4", saved ? "border-emerald/50" : stop ? "border-rose/50" : "border-hairline")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge kind={p.kind === "payment" ? "warning" : "info"}>{KIND_LABEL[p.kind]}</Badge>
            <span className="text-2xs text-ink-3">{Math.round(p.confidence * 100)}% sure</span>
          </div>
          {p.why && <p className="text-2xs text-ink-3 mt-1">{p.why}</p>}
        </div>
        {!saved && (
          <button type="button" onClick={() => onDone("discarded")} className="text-2xs text-ink-3 hover:text-ink">Discard</button>
        )}
      </div>

      {initial.matches.length > 0 && (
        <div className="mt-2.5 rounded-md bg-amber-soft/50 px-2.5 py-1.5 text-2xs text-amber-ink">
          Already in the app:{" "}
          {initial.matches.map((m, i) => (
            <React.Fragment key={`${m.type}-${m.id}`}>
              {i > 0 && ", "}
              <Link href={MATCH_HREF(m)} className="font-medium underline">{m.label}</Link> ({m.type}, same {m.by})
            </React.Fragment>
          ))}
          . Open it instead of adding again, if it is the same.
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {FIELDS[p.kind].map((def) => (
          <label key={def.key} className={cn("block", def.wide && "col-span-2")}>
            <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{def.label}</span>
            {def.type === "select" ? (
              <select
                value={String(fields[def.key] ?? "")}
                disabled={!!saved}
                onChange={(e) => setField(def.key, def, e.target.value)}
                className="mt-0.5 w-full rounded border border-hairline bg-paper px-2 py-1.5 text-sm"
              >
                {def.options!.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
              </select>
            ) : (
              <input
                type={def.type ?? "text"}
                value={fields[def.key] ?? ""}
                disabled={!!saved}
                onChange={(e) => setField(def.key, def, e.target.value)}
                className="mt-0.5 w-full rounded border border-hairline bg-paper px-2 py-1.5 text-sm tabular-nums"
              />
            )}
          </label>
        ))}
      </div>

      {p.gstinTyped && (
        <p className="mt-2 text-2xs text-amber-ink">Read GSTIN “{p.gstinTyped}” fails the check digit, so it was left blank — confirm it.</p>
      )}

      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {warnings.map((w) => (
            <li key={w.code} className={cn("rounded-md px-2.5 py-1.5 text-xs", w.severity === "stop" ? "bg-rose/10 text-rose" : "bg-amber-soft/60 text-amber-ink")}>
              <span className="font-semibold">{w.severity === "stop" ? "Not allowed" : "Check"} · {w.law}:</span> {w.message}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        {saved ? (
          <span className="text-sm text-emerald">✓ Saved · <Link href={saved.href} className="underline">{saved.label}</Link></span>
        ) : p.kind === "employee_advance" ? (
          <>
            {/* Straight to the real entry (Pardeep: "seedha entry par bhi to le ja sakta hai"):
                the Give advance form, filled — the bank/cash account it leaves from is picked there. */}
            <span className="text-2xs text-ink-3">{missing ?? "Held as company money with them — not an expense until bills come in."}</span>
            {missing ? (
              <span className="text-sm text-ink-3">Fill the fields first</span>
            ) : (
              <Link href={advanceFormHref(p.fields) as Route} className="inline-flex items-center rounded-md bg-amber px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber/90">
                Give advance →
              </Link>
            )}
          </>
        ) : p.kind === "payment" ? (
          <>
            <span className="text-2xs text-ink-3">Money received is recorded against its invoice{p.fields.amount ? ` (${rupee(p.fields.amount)})` : ""}.</span>
            <Link href={invoicesHref(p.fields.payer)} className="text-sm font-medium text-amber-ink hover:underline">Find the invoice →</Link>
          </>
        ) : (
          <>
            {stop ? (
              <label className="flex items-center gap-1.5 text-2xs text-rose">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="accent-rose" />
                I understand — save anyway
              </label>
            ) : <span className="text-2xs text-amber-ink">{missing ?? ""}</span>}
            <Button
              size="sm" variant="primary" onClick={save} loading={pending}
              disabled={!!missing || (stop && !ack)}
              title={missing ?? (stop && !ack ? "Tick “I understand” to save an entry the law flags" : undefined)}
            >
              Save {KIND_LABEL[p.kind].toLowerCase()}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
