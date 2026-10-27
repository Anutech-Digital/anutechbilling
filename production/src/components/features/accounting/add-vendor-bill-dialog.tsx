/**
 * AddVendorBillDialog — capture a bill received from a supplier.
 *
 * Auto-fills:
 *   - subtotal = total − (cgst+sgst+igst)  (if user enters total+gst)
 *   - status = unpaid (default)
 *
 * Intra-state GST: enter CGST + SGST (each 9% for SaaS HSN 998313).
 * Inter-state GST: enter IGST (18% combined).
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCreateVendorBill, useOwnStateCode, uploadBillAttachment, VENDOR_BILL_CATEGORIES } from "@/lib/queries/vendor-bills";
import { BILL_DOCUMENT_TYPES, BILL_DOCUMENT_TYPE_LABEL, billItcEligibility, isBillDocumentType, type BillDocumentType } from "@/lib/gst/bill-itc";
import { useVendors, ensureVendor } from "@/lib/queries/vendors";
import { istToday } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";
import { fillLineQty } from "@/app/api/ai/extract-bill/sanitize";
import { checkBillFile, readBillFile } from "@/lib/accounting/bill-reader";
import { buyerConfirmedNote, buyerWarningText, isBuyerMismatch, type BuyerMismatch } from "@/app/api/ai/extract-bill/buyer-check";
import { useConfirm } from "@/components/providers/confirm-provider";

const schema = z.object({
  vendor_name:  z.string().min(2, "Vendor name required"),
  vendor_gstin: z.string().optional(),
  bill_no:      z.string().optional(),
  bill_date:    z.string().min(10, "Bill date required"),
  due_date:     z.string().optional(),
  category:     z.string().min(2),
  subtotal:     z.coerce.number().min(0),
  cgst:         z.coerce.number().min(0).default(0),
  sgst:         z.coerce.number().min(0).default(0),
  igst:         z.coerce.number().min(0).default(0),
  total:        z.coerce.number().min(1, "Total must be > 0"),
  notes:        z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const VENDOR_PRESETS = [
  { name: "Google Cloud / Workspace", gstin: "", category: "COGS-Workspace" },
  { name: "Microsoft Partner Center", gstin: "", category: "COGS-M365" },
  { name: "Zoho Corporation",         gstin: "", category: "COGS-Zoho" },
];

/**
 * Fields an extraction can seed. Same shape `sanitizeExtractedBill` returns, so
 * the billing@ review queue can hand over exactly what Gemini read without a
 * second mapping in between.
 */
export interface VendorBillPrefill {
  vendor_name?:  string | null;
  vendor_gstin?: string | null;
  bill_no?:      string | null;
  bill_date?:    string | null;
  currency?:     string | null;
  subtotal?:     number | null;
  cgst?:         number | null;
  sgst?:         number | null;
  igst?:         number | null;
  total?:        number | null;
  category_guess?: string | null;
  /** R-1510 reader: "tax_invoice" | "proforma" | "other". R-1576 saves it on the bill. */
  document_type?: string | null;
  line_items?:   Array<{ description?: string; qty?: number | null; unit_price?: number | null; amount?: number | null }>;
  /** R-1767: the extract-bill route's answer — the bill is addressed to another company. */
  buyer_mismatch?: BuyerMismatch | null;
  /** R-1767 addition: the bill already uploaded in Add expense — attached on save, never re-read. */
  file?: File | null;
}

/**
 * R-1767 — the red "addressed to another company" line and the proforma line, shown on the AI
 * preview of BOTH bill dialogs (Add expense, Add COGS Bill) so the two never word it differently.
 */
export function BillReadWarnings({ buyer, proforma }: { buyer: BuyerMismatch | null; proforma: boolean }) {
  if (!buyer && !proforma) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {buyer && (
        <div role="alert" className="flex items-start gap-1.5 rounded-md bg-rose-soft/40 px-2.5 py-2 text-xs text-rose">
          <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
          <span>{buyerWarningText(buyer)}</span>
        </div>
      )}
      {proforma && (
        <div role="status" className="flex items-start gap-1.5 rounded-md bg-amber-soft/60 px-2.5 py-2 text-xs text-amber-ink">
          <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
          <span>This is a proforma, not a tax invoice — no GST input credit. Save it when the tax invoice comes, or save it without credit.</span>
        </div>
      )}
    </div>
  );
}

/**
 * @param prefill   values read from a bill that arrived by email. Seeds the SAME
 *                  fields the in-dialog AI upload seeds — including forcing the
 *                  FX rate blank for a foreign bill, so an emailed invoice can
 *                  never be saved at a rate nobody chose.
 * @param onCreated the new bill's id, so a caller can link its own record to it.
 *
 * Both optional: every existing caller is unchanged.
 */
export function AddVendorBillDialog({
  onClose,
  prefill,
  onCreated,
}: {
  onClose: () => void;
  prefill?: VendorBillPrefill;
  onCreated?: (billId: string) => void;
}) {
  const create = useCreateVendorBill();
  const today  = istToday();
  const confirm = useConfirm();
  /* R-1767: the bill is addressed to another company → red line + a confirm before Save. */
  const [aiBuyer, setAiBuyer] = React.useState<BuyerMismatch | null>(null);

  // Vendor master autocomplete — pick an existing supplier (fills GSTIN +
  // category) or type a new name (auto-added to Vendors on save).
  const { data: vendors } = useVendors();
  const [vendorId, setVendorId] = React.useState<string | null>(null);
  const [vendorOpen, setVendorOpen] = React.useState(false);

  // ── AI bill reader ────────────────────────────────────────────────────────
  // Upload a photo/PDF → Gemini extracts the fields → we PRE-FILL the form. The
  // values stay editable and are never auto-saved — the operator verifies the
  // amounts against the bill (they feed GST input credit + P&L).
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [reading, setReading] = React.useState(false);
  const [aiNote, setAiNote]   = React.useState<string | null>(null);
  const [aiError, setAiError] = React.useState<string | null>(null);
  // The uploaded file is kept and attached to the bill on save (proof).
  const [attachFile, setAttachFile] = React.useState<File | null>(null);

  // Currency of the bill. Books are in ₹, so a foreign bill (USD etc.) needs an
  // exchange rate the operator confirms — we never push raw foreign amounts
  // into the INR P&L. rate = ₹ per 1 unit of `currency` (1 for INR).
  const [currency, setCurrency] = React.useState("INR");
  const [fxRate, setFxRate]     = React.useState("");        // string for the input; "" until entered
  const [fxError, setFxError]   = React.useState<string | null>(null);
  const isForeign = currency !== "INR";

  // R-1576: what kind of document this is — only a TAX INVOICE gives GST input credit.
  // Saved on the bill; the GST page, 3B, P&L and Balance Sheet read it (lib/gst/bill-itc.ts).
  const [docType, setDocType] = React.useState<BillDocumentType>("tax_invoice");
  // Second press of Save on a bill whose GST gives no credit = "yes, save it as cost".
  const [noCreditOk, setNoCreditOk] = React.useState(false);
  const { data: ownStateCode } = useOwnStateCode();
  const rate = isForeign ? Number(fxRate || 0) : 1;

  // Line items (products/services on the bill) — amounts stay in the bill's own
  // currency, faithful to the document; the ₹ books use the converted totals.
  type Line = { description: string; qty: string; unit_price: string; amount: string };
  const [lines, setLines] = React.useState<Line[]>([]);
  const addLine    = () => setLines((ls) => [...ls, { description: "", qty: "", unit_price: "", amount: "" }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));
  const setLine    = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function handleBillFile(file: File) {
    setAiError(null); setAiNote(null); setAiBuyer(null);
    /* R-2005: the one bill reader (lib/accounting/bill-reader.ts) — same check, route and words
       as Add expense and the bank Reconcile "record the bill now". */
    const bad = checkBillFile(file);
    if (bad) { setAiError(bad); return; }
    setAttachFile(file);   // keep it — attaches to the bill on save
    setReading(true);
    try {
      const out = await readBillFile(file);
      if (!out.ok) { setAiError(out.error); return; }
      const f = out.read.fields as Record<string, string | number | null>;
      setAiBuyer(out.read.buyer);
      // Prefill — only overwrite what the AI actually found.
      if (f.vendor_name)  setValue("vendor_name",  String(f.vendor_name));
      if (f.vendor_gstin) setValue("vendor_gstin", String(f.vendor_gstin));
      if (f.bill_no)      setValue("bill_no",      String(f.bill_no));
      if (f.bill_date)    setValue("bill_date",    String(f.bill_date));
      if (f.subtotal != null) setValue("subtotal", Number(f.subtotal));
      setValue("cgst", Number(f.cgst ?? 0));
      setValue("sgst", Number(f.sgst ?? 0));
      setValue("igst", Number(f.igst ?? 0));
      if (f.total != null) setValue("total", Number(f.total));
      if (f.category_guess && (VENDOR_BILL_CATEGORIES as readonly string[]).includes(String(f.category_guess))) {
        setValue("category", String(f.category_guess));
      }
      // Currency + line items
      const cur = String((f as Record<string, unknown>).currency ?? "INR") || "INR";
      setCurrency(cur);
      if (cur !== "INR") setFxRate("");   // force the operator to enter today's rate
      const items = Array.isArray((f as Record<string, unknown>).line_items)
        ? ((f as Record<string, unknown>).line_items as Array<Record<string, unknown>>)
        : [];
      setLines(items.map((it) => fillLineQty({
        description: String(it.description ?? ""),
        qty:         it.qty        != null ? String(it.qty)        : "",
        unit_price:  it.unit_price != null ? String(it.unit_price) : "",
        amount:      it.amount     != null ? String(it.amount)     : "",
      })));
      /* R-1576: the reader's document type is saved on the bill (R-1510 only warned). */
      const readType = (f as Record<string, unknown>).document_type;
      if (isBillDocumentType(readType)) setDocType(readType);
      /* R-1510: a Proforma is a request for payment, not a GST tax invoice — no input
         credit can be claimed on it. Say so; the bill is still saved as typed. */
      const proformaWarn = (f as Record<string, unknown>).document_type === "proforma"
        ? " ⚠ This is a PROFORMA, not a tax invoice — no GST input credit can be claimed on it; ask the vendor for the tax invoice."
        : "";
      setAiNote(
        (cur !== "INR"
          ? `Filled by AI · the bill is in ${cur} — enter the exchange rate (₹/${cur}) below so the books are right in ₹. 📎 "${file.name}" will be attached.`
          : `Filled by AI · 📎 "${file.name}" will be attached to the bill — check the amounts against the bill, then Save.`) + proformaWarn,
      );
    } catch {
      setAiError("Upload failed — try again, or fill the fields by hand.");
    } finally {
      setReading(false);
    }
  }

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      bill_date: today,
      category:  "COGS-Workspace",
      subtotal:  0, cgst: 0, sgst: 0, igst: 0, total: 0,
    },
  });

  /* Seed from an extraction that arrived by email. Mirrors handleBillFile above
     rather than sharing it, because that one also holds the File for upload and
     an emailed bill is already stored — but the RULES are the same, deliberately:
     only overwrite what was actually read, and blank the FX rate on a foreign
     bill so nobody can save at a rate they did not choose. */
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!prefill || seeded.current) return;
    seeded.current = true;

    if (prefill.vendor_name)  setValue("vendor_name",  String(prefill.vendor_name));
    if (prefill.vendor_gstin) setValue("vendor_gstin", String(prefill.vendor_gstin));
    if (prefill.bill_no)      setValue("bill_no",      String(prefill.bill_no));
    if (prefill.bill_date)    setValue("bill_date",    String(prefill.bill_date));
    if (prefill.subtotal != null) setValue("subtotal", Number(prefill.subtotal));
    setValue("cgst", Number(prefill.cgst ?? 0));
    setValue("sgst", Number(prefill.sgst ?? 0));
    setValue("igst", Number(prefill.igst ?? 0));
    if (prefill.total != null) setValue("total", Number(prefill.total));
    if (prefill.category_guess && (VENDOR_BILL_CATEGORIES as readonly string[]).includes(String(prefill.category_guess))) {
      setValue("category", String(prefill.category_guess));
    }

    if (isBillDocumentType(prefill.document_type)) setDocType(prefill.document_type);
    /* R-1767 */
    setAiBuyer(isBuyerMismatch(prefill.buyer_mismatch) ? prefill.buyer_mismatch : null);
    if (prefill.file) {
      setAttachFile(prefill.file);
      setAiNote(`Filled from the bill read in Add expense · 📎 "${prefill.file.name}" will be attached to the bill — check the amounts against the bill, then Save.`
        + (prefill.document_type === "proforma"
          ? " ⚠ This is a PROFORMA, not a tax invoice — no GST input credit can be claimed on it; ask the vendor for the tax invoice."
          : ""));
    }

    const cur = String(prefill.currency ?? "INR") || "INR";
    setCurrency(cur);
    if (cur !== "INR") setFxRate("");   // force the operator to enter today's rate

    if (Array.isArray(prefill.line_items)) {
      setLines(prefill.line_items.map((it) => fillLineQty({
        description: String(it.description ?? ""),
        qty:         it.qty        != null ? String(it.qty)        : "",
        unit_price:  it.unit_price != null ? String(it.unit_price) : "",
        amount:      it.amount     != null ? String(it.amount)     : "",
      })));
    }
  }, [prefill, setValue]);

  const subtotal = Number(watch("subtotal") || 0);
  const cgst     = Number(watch("cgst")     || 0);
  const sgst     = Number(watch("sgst")     || 0);
  const igst     = Number(watch("igst")     || 0);
  const computedTotal = subtotal + cgst + sgst + igst;

  /* R-1576 (§24): say BEFORE saving whether this bill's GST will be input credit, and why not. */
  const vendorGstinNow = watch("vendor_gstin");
  const categoryNow = watch("category");
  const itc = billItcEligibility({
    document_type: docType, vendor_gstin: vendorGstinNow, category: categoryNow,
    cgst, sgst, igst, ownStateCode: ownStateCode ?? null,
  });
  const gstOnBill = cgst + sgst + igst;
  const noCredit = gstOnBill > 0 && !itc.eligible;
  /* Any change to what decides the credit asks again. */
  React.useEffect(() => { setNoCreditOk(false); }, [docType, vendorGstinNow, categoryNow, cgst, sgst, igst]);

  // Quick-fill: pretend the user typed only subtotal — auto-derive intra/inter
  function applyGST18Intra() {
    const half = Math.round(subtotal * 0.09);
    setValue("cgst", half);
    setValue("sgst", half);
    setValue("igst", 0);
    setValue("total", subtotal + half * 2);
  }
  function applyGST18Inter() {
    const igstAmt = Math.round(subtotal * 0.18);
    setValue("cgst", 0);
    setValue("sgst", 0);
    setValue("igst", igstAmt);
    setValue("total", subtotal + igstAmt);
  }
  function syncTotalToComputed() {
    setValue("total", computedTotal);
  }

  async function onSubmit(values: FormData) {
    // Foreign bill must have an exchange rate before it can hit the ₹ books.
    if (isForeign && rate <= 0) {
      setFxError(`Enter today's exchange rate (₹ per 1 ${currency}) to save — the ₹ books need it.`);
      return;
    }
    setFxError(null);
    /* R-1576: GST that gives no credit becomes cost — ask once, plainly, before saving. */
    if (noCredit && !noCreditOk) { setNoCreditOk(true); return; }
    /* R-1767: another company's bill never enters our books without a clear yes — the yes is
       written into the bill's notes. */
    let buyerNote: string | null = null;
    if (aiBuyer) {
      const ok = await confirm({
        title: `Did ${aiBuyer.own_name} really pay this bill?`,
        body: buyerWarningText(aiBuyer),
        danger: true,
        confirmLabel: `Yes, ${aiBuyer.own_name} paid it`,
        cancelLabel: "No, don't save",
      });
      if (!ok) return;
      buyerNote = buyerConfirmedNote(aiBuyer);
    }
    // Convert the bill's own-currency amounts to ₹ for the books (rate = 1 for INR).
    const inr = (n: number) => Math.round(n * rate);

    // Line items — keep amounts in the bill's OWN currency (faithful to the
    // document); drop blank rows.
    const line_items = lines
      .map(fillLineQty)   // R-1510: a line typed with only an amount saves as 1 × amount
      .map((l) => ({
        name:   l.description.trim(),
        qty:    l.qty ? Number(l.qty) : undefined,
        rate:   l.unit_price ? Number(l.unit_price) : undefined,
        amount: Number(l.amount || 0),
      }))
      .filter((l) => l.name || l.amount > 0);

    // Record the FX basis in notes so the ₹ figures are auditable later.
    // Both locales are PINNED on purpose: this string is persisted, so the same
    // bill must produce the same note on every machine (an un-pinned
    // toLocaleString() follows the browser locale). The foreign amount stays
    // "en-US" — Western grouping is correct for USD/EUR; do NOT "fix" it to
    // en-IN. Only the ₹ conversion uses Indian lakh grouping.
    const fxNote = isForeign
      ? `Foreign bill: ${currency} ${values.total.toLocaleString("en-US")} @ ₹${rate}/${currency} = ₹${inr(values.total).toLocaleString("en-IN")}.`
      : "";
    const notes = [fxNote, values.notes?.trim(), buyerNote].filter(Boolean).join(" ") || null;

    // Link to the vendors master — reuse the picked vendor, else find-or-create
    // one from the typed name (keeps the master clean + dedup'd).
    const vId = vendorId ?? await ensureVendor({
      name: values.vendor_name, gstin: values.vendor_gstin, defaultCategory: values.category,
    });
    // Attach the uploaded bill file (proof) — non-fatal if the upload fails.
    let attachment_url: string | null = null;
    if (attachFile) {
      try { attachment_url = await uploadBillAttachment(attachFile); }
      catch { /* keep saving the bill even if the file upload hiccups */ }
    }
    const saved = await create.mutateAsync({
      vendor_id:    vId,
      attachment_url,
      vendor_name:  values.vendor_name,
      vendor_gstin: values.vendor_gstin || null,
      bill_no:      values.bill_no      || null,
      bill_date:    values.bill_date,
      due_date:     values.due_date     || null,
      category:     values.category,
      currency,
      fx_rate:      rate,
      subtotal:     inr(values.subtotal),
      cgst:         inr(values.cgst),
      sgst:         inr(values.sgst),
      igst:         inr(values.igst),
      total:        inr(values.total),
      notes,
      status:       "unpaid",
      document_type: docType,
      line_items,
    });
    // Told AFTER the write succeeded, so a caller linking its own record to this
    // bill can never point at one that was never saved.
    if (saved?.id) onCreated?.(saved.id);
    onClose();
  }

  function applyVendorPreset(idx: number) {
    const p = VENDOR_PRESETS[idx];
    if (!p) return;
    setValue("vendor_name", p.name);
    setValue("category",    p.category);
    setVendorId(null);   // find-or-create on save
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add COGS Bill</DialogTitle>
          <DialogDescription>
            Record a bill received from a supplier — Google CSP, Microsoft Partner, Zoho Partner, etc.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* AI bill reader — upload → auto-fill (review before saving). */}
          <div className="rounded-lg border border-dashed border-amber/50 bg-amber-soft/20 p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <Icon name="sparkles" size={18} className="text-amber-ink shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">Upload the bill — AI fills in the form</p>
                  <p className="text-xs text-ink-3">Photo (JPG/PNG) or PDF · AI reads the fields and fills the form; check it, then Save</p>
                </div>
              </div>
              <Button type="button" variant="primary" size="sm" icon="upload" loading={reading} onClick={() => fileRef.current?.click()}>
                {reading ? "Reading…" : "Upload bill"}
              </Button>
              <input
                ref={fileRef}
                id="vendor-bill-file"
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBillFile(f); e.target.value = ""; }}
              />
            </div>
            {aiNote && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald">
                <Icon name="check_circle" size={12} /> {aiNote}
              </p>
            )}
            {aiError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-rose">
                <Icon name="alert" size={12} /> {aiError}
              </p>
            )}
            {aiBuyer && <div className="mt-2"><BillReadWarnings buyer={aiBuyer} proforma={false} /></div>}
            {attachFile && !aiNote && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">
                <Icon name="file" size={12} /> {attachFile.name} — will be attached to the bill
              </p>
            )}
          </div>

          {/* Quick presets */}
          <div className="flex flex-wrap gap-1.5">
            <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold self-center mr-1">
              Quick fill:
            </span>
            {VENDOR_PRESETS.map((p, i) => (
              <button
                key={p.name}
                type="button"
                onClick={() => applyVendorPreset(i)}
                className="text-xs px-2.5 py-1 rounded-full border border-hairline text-ink-3 hover:text-ink hover:bg-paper-2 transition-colors"
              >
                {p.name.split(" ")[0]}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Vendor name" required htmlFor="vendor_name">
              <div className="relative">
                <Input
                  id="vendor_name"
                  placeholder="e.g. Google Cloud"
                  autoComplete="off"
                  error={errors.vendor_name?.message}
                  {...register("vendor_name", { onChange: () => { setVendorId(null); setVendorOpen(true); } })}
                  onFocus={() => setVendorOpen(true)}
                  onBlur={() => setTimeout(() => setVendorOpen(false), 130)}
                />
                {vendorOpen && (vendors ?? []).length > 0 && (() => {
                  const q = (watch("vendor_name") || "").trim().toLowerCase();
                  const matches = (vendors ?? []).filter((v) => !q || v.name.toLowerCase().includes(q)).slice(0, 8);
                  if (matches.length === 0) return null;
                  return (
                    <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
                      {matches.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setValue("vendor_name", v.name);
                            if (v.gstin) setValue("vendor_gstin", v.gstin);
                            if (v.default_category && (VENDOR_BILL_CATEGORIES as readonly string[]).includes(v.default_category)) {
                              setValue("category", v.default_category);
                            }
                            setVendorId(v.id);
                            setVendorOpen(false);
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2"
                        >
                          <span className="text-ink truncate">{v.name}</span>
                          {v.gstin && <span className="text-xs text-ink-3 font-mono shrink-0">{v.gstin}</span>}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </FormField>
            <FormField label="Vendor GSTIN (optional)" htmlFor="vendor_gstin">
              <Input id="vendor_gstin" placeholder="e.g. 27ABCDE1234F1Z5" {...register("vendor_gstin")} />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="Bill # (vendor's)" htmlFor="bill_no">
              <Input id="bill_no" placeholder="e.g. INV-12345" {...register("bill_no")} />
            </FormField>
            <FormField label="Bill date" required htmlFor="bill_date">
              <Input id="bill_date" type="date" error={errors.bill_date?.message} {...register("bill_date")} />
            </FormField>
            <FormField label="Due date (optional)" htmlFor="due_date">
              <Input id="due_date" type="date" {...register("due_date")} />
            </FormField>
          </div>

          <FormField label="Category" required htmlFor="category">
            <Select
              value={watch("category")}
              onValueChange={(v) => setValue("category", v)}
            >
              <SelectTrigger id="category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_BILL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-ink-3 mt-1">
              Categories starting with <code>COGS-</code> count as cost of goods sold in the P&L.
            </p>
          </FormField>

          <FormField label="Document type" required htmlFor="document_type">
            <Select value={docType} onValueChange={(v) => { if (isBillDocumentType(v)) setDocType(v); }}>
              <SelectTrigger id="document_type">
                <SelectValue placeholder="Select document type" />
              </SelectTrigger>
              <SelectContent>
                {BILL_DOCUMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{BILL_DOCUMENT_TYPE_LABEL[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-ink-3 mt-1">
              Check the title printed on the bill — GST input credit is available only on a <b>Tax Invoice</b>.
            </p>
          </FormField>

          {/* Line items — products/services on the bill (auto-filled from AI). */}
          <div className="p-3 rounded-lg border border-hairline bg-paper-2/30">
            <div className="flex items-center justify-between mb-2">
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                Items on this bill{isForeign ? ` · amounts in ${currency}` : ""}
              </p>
              <Button type="button" variant="ghost" size="sm" icon="plus" onClick={addLine}>Add item</Button>
            </div>
            {lines.length === 0 ? (
              <p className="text-xs text-ink-3">No items yet — upload a bill to auto-fill, or add rows manually.</p>
            ) : (
              /* R-1510: the description gets the FULL width of its own row and wraps, so a
                 long name like "Google Workspace ( 1 September - 30 September , 2026 )"
                 is readable on desktop and phone (it was cut off in a 5/12 column). */
              <div className="space-y-3">
                {lines.map((l, i) => (
                  <div key={i} className="space-y-1.5 border-b border-hairline pb-3 last:border-b-0 last:pb-0">
                    <div className="flex items-start gap-2">
                      <Textarea aria-label="Item description" rows={1} autoGrow maxRows={4} placeholder="e.g. Team plan - Premium"
                        title={l.description || undefined}
                        value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                      <button type="button" onClick={() => removeLine(i)} aria-label="Remove item"
                        className="mt-2 shrink-0 text-ink-3 hover:text-rose">
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pr-6">
                      <label className="block">
                        <span className="text-3xs uppercase tracking-wider text-ink-3">Qty</span>
                        <Input aria-label="Qty" className="text-right" type="number" min={0} step="any" placeholder="1"
                          value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                      </label>
                      <label className="block">
                        <span className="text-3xs uppercase tracking-wider text-ink-3">Unit price</span>
                        <Input aria-label="Unit price" className="text-right" type="number" step="any" placeholder="Unit"
                          value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} />
                      </label>
                      {/* Amount allows negatives — credit / unused-time lines are refunds.
                          Leaving it with no qty fills Qty 1 × this amount (R-1510). */}
                      <label className="block">
                        <span className="text-3xs uppercase tracking-wider text-ink-3">Amount</span>
                        <Input aria-label="Amount" className="text-right" type="number" step="any" placeholder="Amount"
                          value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })}
                          onBlur={() => setLines((ls) => ls.map((x, idx) => (idx === i ? fillLineQty(x) : x)))} />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Amounts grid */}
          <div className="p-3 rounded-lg border border-hairline bg-paper-2/30">
            {isForeign && (
              <div className="mb-3 rounded-md bg-amber-soft/40 p-2.5">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="text-xs text-amber-ink leading-snug max-w-[55%]">
                    Bill is in <b>{currency}</b>. Enter today's rate — the ₹ books use the converted amounts.
                  </div>
                  <FormField htmlFor="add-vendor-field" label={`Exchange rate (₹ per 1 ${currency})`} required>
                    <Input id="add-vendor-field" type="number" min={0} step="any" placeholder="e.g. 83.50"
                      value={fxRate}
                      error={fxError ?? undefined}
                      onChange={(e) => { setFxRate(e.target.value); if (fxError) setFxError(null); }} />
                  </FormField>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <FormField label={`Pre-GST subtotal (${isForeign ? currency : "₹"})`} required htmlFor="subtotal">
                <Input id="subtotal" type="number" min={0} step="any" error={errors.subtotal?.message} {...register("subtotal")} />
              </FormField>
              <FormField label={`CGST (${isForeign ? currency : "₹"})`} htmlFor="cgst">
                <Input id="cgst" type="number" min={0} step="any" {...register("cgst")} />
              </FormField>
              <FormField label={`SGST (${isForeign ? currency : "₹"})`} htmlFor="sgst">
                <Input id="sgst" type="number" min={0} step="any" {...register("sgst")} />
              </FormField>
              <FormField label={`${isForeign ? "GST/IGST" : "IGST"} (${isForeign ? currency : "₹"})`} htmlFor="igst">
                <Input id="igst" type="number" min={0} step="any" {...register("igst")} />
              </FormField>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              <button type="button" onClick={applyGST18Intra}
                className="text-xs px-2.5 py-1 rounded-full border border-hairline text-ink-3 hover:text-ink hover:bg-paper transition-colors">
                Intra-state GST 18% (CGST 9 + SGST 9)
              </button>
              <button type="button" onClick={applyGST18Inter}
                className="text-xs px-2.5 py-1 rounded-full border border-hairline text-ink-3 hover:text-ink hover:bg-paper transition-colors">
                Inter-state GST 18% (IGST 18)
              </button>
            </div>
            {gstOnBill > 0 && (
              <p role="status" className={`mt-3 flex items-start gap-1.5 text-xs ${itc.eligible ? "text-emerald" : "text-rose"}`}>
                <Icon name={itc.eligible ? "check_circle" : "alert"} size={12} className="mt-0.5 shrink-0" />
                <span>
                  {itc.eligible
                    ? "ITC available — this goes to GST input credit (GST Report, GSTR-3B 4(A))."
                    : <>ITC not available — {itc.reason}. This GST is added to cost (P&amp;L), not to Input GST.</>}
                </span>
              </p>
            )}
          </div>

          <FormField label={`Total (${isForeign ? currency : "₹"}) incl GST`} required htmlFor="total">
            <div className="flex items-center gap-2">
              <Input id="total" type="number" min={1} step="any" error={errors.total?.message} {...register("total")} />
              {computedTotal > 0 && Number(watch("total")) !== computedTotal && (
                <Button type="button" variant="ghost" size="sm" onClick={syncTotalToComputed}>
                  = {isForeign ? currency + " " : "₹"}{computedTotal.toLocaleString("en-IN")}
                </Button>
              )}
            </div>
            {isForeign && rate > 0 && Number(watch("total")) > 0 && (
              <p className="mt-1 text-xs text-emerald">
                ≈ {rupee(Math.round(Number(watch("total")) * rate))} in books (@ ₹{rate}/{currency})
              </p>
            )}
          </FormField>

          <FormField label="Notes (optional)" htmlFor="notes">
            <Textarea id="notes" rows={2} placeholder="Reference, period, comments…" {...register("notes")} />
          </FormField>

          {noCredit && noCreditOk && (
            <p role="alert" className="rounded-md bg-rose-soft/40 p-2.5 text-xs text-rose">
              No credit is available for this bill's GST ({isForeign ? `${currency} ` : "₹"}{gstOnBill.toLocaleString("en-IN")}) — {itc.reason}.
              It is added to cost. To save anyway, click &quot;Save — GST as cost&quot;; otherwise ask the vendor for a tax invoice.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              {noCredit && noCreditOk ? "Save — GST as cost" : "Save bill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
