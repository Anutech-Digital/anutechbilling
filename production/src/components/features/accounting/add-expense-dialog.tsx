/**
 * AddExpenseDialog — capture an operating expense.
 *
 * Optional GST paid → flows into the input tax credit report.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, formatForeignAmount, formatDate } from "@/lib/utils";
import {
  useCreateExpense,
  useUpdateExpense,
  useExpenseDupList,
  findDuplicateExpense,
  suggestCategory,
  splitLinesByCategory,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  useCommissionToPayeeThisFy,
  useVendorTdsThisFy,
  type Expense,
} from "@/lib/queries/expenses";
import { COMMISSION_CATEGORY, TDS_194H_THRESHOLD, commissionTdsView } from "@/lib/accounting/commission-tds";
import { AD_CHANNELS, isMarketingCategory, suggestAdChannel } from "@/lib/marketing/ad-channels";
import { useCampaignOptions } from "@/lib/queries/marketing-campaigns";
import { localDateISO } from "@/lib/leads/outcomes";
import { useEmployees } from "@/lib/queries/payroll";
import { compactName } from "@/lib/banking/salary-lines";
import { TDS_SECTION_RATES, tdsBase } from "@/lib/accounting/tds-rates";
import { tdsDecision, panFromGstin } from "@/lib/accounting/tds-deductor";
import { useBankAccounts } from "@/lib/queries/bank";
import { useVendors, ensureVendor } from "@/lib/queries/vendors";
import { useAddReimbursement } from "@/lib/queries/reimbursements";
import { toast } from "sonner";
import { uploadBillAttachment } from "@/lib/queries/vendor-bills";
import { useConfirm } from "@/components/providers/confirm-provider";
import { expenseCategoryError } from "@/lib/accounting/expense-category";
import { istToday } from "@/lib/dates/ist";
import { useEmployeeAdvances, EMPLOYEE_ADVANCE_METHOD } from "@/lib/queries/advances";

const CURRENCY_OPTIONS = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD"] as const;

const schema = z.object({
  /* ⚠️ Yahan `z.string().min(2)` tha, aur wo ek CHUP dead end banata tha (29 Aug 2026).
     Ye khaana screen par sirf simple mode me hai — `{!showItems && <FormField label="Category" …>}`.
     Bill upload karte hi form itemise mode me chala jata hai aur khaana gायab ho jata hai,
     par schema use phir bhi maangta tha. React Hook Form ek aise field par rukta tha jo
     render hi nahi hota: koi error, koi toast, koi network request — kuch nahi. Sirf Save
     dabao aur kuch na ho.

     Zod itni baat nahi keh sakta ("itemise me item se, warna form se"), isliye wo shart
     `lib/accounting/expense-category.ts` me hai aur onSubmit uspar rukta hai — ek AISE
     sandesh ke saath jo dikhta hai. */
  category:       z.string().optional(),
  vendor_name:    z.string().optional(),
  expense_date:   z.string().min(10, "Date required"),
  amount:         z.coerce.number().min(1, "Amount required"),
  gst_paid:       z.coerce.number().min(0).default(0),
  payment_method: z.string().optional(),
  description:    z.string().optional(),
  notes:          z.string().optional(),        // longer free-text comment / extra detail
  tds_section:    z.string().optional(),        // 26Q — TDS deducted on this payment
  tds_amount:     z.coerce.number().min(0).default(0),
});
type FormData = z.infer<typeof schema>;

export function AddExpenseDialog({
  onClose,
  expense,
  projectId,
  projectTitle,
  defaultCategory,
  advanceId: presetAdvanceId,
}: {
  onClose: () => void;
  /**
   * Paid out of a staff advance (R-101) — the Advances page opens this form with the
   * advance already picked. The person picks it themselves from "Paid by" otherwise.
   */
  advanceId?: string | null;
  /** Category a NEW expense starts on — e.g. "Advertising" from /marketing/spend. */
  defaultCategory?: string;
  expense?: Expense | null;
  /** When set, this expense is tagged as a cost of that project (per-project P&L). */
  projectId?: string | null;
  projectTitle?: string;
}) {
  const router = useRouter();
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const isEdit = Boolean(expense);
  const today  = istToday();
  const { data: bankAccounts } = useBankAccounts();
  const cashAccounts = (bankAccounts ?? []).filter((a) => a.account_type === "cash");
  const bankOnlyAccounts = (bankAccounts ?? []).filter((a) => a.account_type !== "cash");
  const [pettyCashAccountId, setPettyCashAccountId] = React.useState<string>("");
  /* Staff advances still open — "Paid by → Employee advance" lists them with what is left. */
  const { data: allAdvances } = useEmployeeAdvances();
  const [advanceId, setAdvanceId] = React.useState<string>(
    presetAdvanceId ?? (expense?.payment_method === EMPLOYEE_ADVANCE_METHOD ? expense?.prepaid_advance_id ?? "" : ""),
  );
  const openAdvances = React.useMemo(
    () => (allAdvances ?? []).filter((a) => a.status === "active" || a.id === advanceId),
    [allAdvances, advanceId],
  );
  const pickedAdvance = openAdvances.find((a) => a.id === advanceId) ?? null;
  // Source bank account for a bank/UPI/card/cheque payment (which bank the money left).
  const [bankAccountId, setBankAccountId] = React.useState<string>(expense?.bank_account_id ?? "");

  // Paid vs payable. Most expenses are already paid when recorded → default true.
  // "To pay" = a bill received on credit; it hits the P&L now (accrual) but must
  // NOT touch cash/bank until settled, so an unpaid expense skips the petty-cash
  // debit and stays out of the bank-reconcile candidates.
  const [paid, setPaid] = React.useState<boolean>(expense?.paid ?? true);
  // Third case: a third person (employee/friend) paid the company's expense from
  // their own pocket → the company OWES them (reimbursement payable). Routed
  // through add_reimbursement, which books the expense + the payable atomically.
  const [reimburse, setReimburse] = React.useState(false);
  const [reimbursePerson, setReimbursePerson] = React.useState("");
  const addReimb = useAddReimbursement();
  const [dueDate, setDueDate] = React.useState<string>(expense?.due_date ?? "");

  // Vendor master link — pick an existing supplier or type a new one (auto-added
  // to Vendors on save), so every OPEX supplier is a managed vendor too.
  const { data: vendors } = useVendors();
  const [vendorId, setVendorId] = React.useState<string | null>(expense?.vendor_id ?? null);
  const [vendorOpen, setVendorOpen] = React.useState(false);

  // Currency of the bill. Books are ₹, so a foreign bill needs an exchange rate;
  // amount/GST are entered in `currency` and converted to ₹ on save (rate=₹/unit).
  const [currency, setCurrency] = React.useState(expense?.currency ?? "INR");
  const [fxRate, setFxRate]     = React.useState(expense?.fx_rate && expense.fx_rate !== 1 ? String(expense.fx_rate) : "");
  const [fxError, setFxError]   = React.useState<string | null>(null);
  const isForeign = currency !== "INR";
  const rate = isForeign ? Number(fxRate || 0) : 1;
  /* Reverse charge on an imported service (Google Ireland, Meta, AWS…): the buyer pays
     the IGST himself in 3B 3.1(d) and claims it in 4(A)(3). Suggested on for a foreign-
     currency bill; the tax is 18% of the ₹ amount unless typed over (lib/gst/gstr3b.ts). */
  const [rcm, setRcm] = React.useState<boolean>(expense?.rcm ?? false);
  const [rcmEdited, setRcmEdited] = React.useState<boolean>(Boolean(expense?.rcm));
  const [rcmTax, setRcmTax] = React.useState<string>(expense?.rcm_tax ? String(expense.rcm_tax) : "");
  React.useEffect(() => { if (!rcmEdited && !expense) setRcm(isForeign); }, [isForeign, rcmEdited, expense]);
  const inrPreview = (n: number) => Math.round(n * (rate > 0 ? rate : 0));

  // How the expense is supported: proper GST tax invoice, a kaccha (informal /
  // non-GST) bill, or no bill at all (petty cash). Only a GST invoice carries
  // input tax credit — and only a GST-invoice vendor joins the Vendors master.
  // Default a NEW expense to "No bill" — most day-to-day entries are small
  // cash spends; a GST invoice is one click away when needed.
  /* From a staff advance (R-101) the bill is the proof of where the money went — start on
     "Kaccha bill" so "Upload bill" is on screen straight away. */
  const [billType, setBillType] = React.useState<string>(expense?.bill_type ?? (presetAdvanceId ? "kaccha" : "none"));
  const isGstBill = billType === "gst";
  // Itemise on demand — simple note by default; line items only when there's a
  // multi-line bill (or the AI fills them).
  const [showItems, setShowItems] = React.useState<boolean>((expense?.line_items?.length ?? 0) > 0);

  // Payroll / statutory postings (salary, employer ESI/PF, TDS) come from the
  // Payroll module — they have no bill or line items, so we hide the items
  // editor when editing one. (New expenses can't be salaries — the category is
  // filtered out — so this only matters on edit.)
  const isPayroll = Boolean(expense && (
    expense.category === "Salaries" ||
    expense.payment_method === "statutory" ||
    /\b(ESI|EPF|PF|Provident|Gratuity|Bonus|TDS)\b/i.test(expense.category)
  ));

  // Line items on the bill (e.g. an Anthropic / software invoice lists several).
  // Amounts stay in the bill's OWN currency, faithful to the document; the ₹
  // books use the converted `amount`. Same shape + behaviour as COGS bills.
  // Each line carries its OWN category so a mixed invoice auto-splits into one
  // expense per category on save. Blank category = falls back to the header one.
  type Line = { description: string; qty: string; unit_price: string; amount: string; category: string };
  const [lines, setLines] = React.useState<Line[]>(
    (expense?.line_items ?? []).map((li) => ({
      description: li.name ?? "",
      qty:         li.qty        != null ? String(li.qty)        : "",
      unit_price:  li.rate       != null ? String(li.rate)       : "",
      amount:      li.amount     != null ? String(li.amount)     : "",
      category:    expense?.category ?? "",
    })),
  );
  const addLine    = () => setLines((ls) => [...ls, { description: "", qty: "", unit_price: "", amount: "", category: "" }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));
  const setLine    = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  // Qty/Unit change → auto-fill Amount (qty × unit), still editable by hand.
  const setQtyUnit = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      const q = Number(next.qty), u = Number(next.unit_price);
      if (next.qty !== "" && next.unit_price !== "" && Number.isFinite(q) && Number.isFinite(u)) {
        next.amount = String(Math.round(q * u * 100) / 100);
      }
      return next;
    }));

  // ── AI bill reader — upload a stationery/software/rent invoice → Gemini
  //    extracts the fields → we PRE-FILL (operator verifies before saving).
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [reading, setReading] = React.useState(false);
  const [aiNote, setAiNote]   = React.useState<string | null>(null);
  const [aiError, setAiError] = React.useState<string | null>(null);
  // The uploaded bill file — kept and attached to the expense on save (proof),
  // whether or not the AI read is confirmed.
  const [attachFile, setAttachFile] = React.useState<File | null>(null);
  // Inline invoice preview — a thumbnail of the uploaded image so the bill is
  // visibly "verified" in the form (PDFs keep the filename link). Object URL is
  // revoked on change/unmount to avoid leaks.
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (attachFile && attachFile.type.startsWith("image/")) {
      const u = URL.createObjectURL(attachFile);
      setPreviewUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    setPreviewUrl(null);
    return undefined;
  }, [attachFile]);
  // What the AI extracted, held for the operator to CONFIRM before anything is
  // written into the form. Nothing auto-fills — a mis-read bill must never
  // silently push wrong amounts/items into a money entry. null = no pending read.
  type PendingExtract = {
    vendorName?: string;
    gstin?:      string;
    billNo?:     string;
    billDate?:   string;
    currency:    string;
    total?:      number;
    gst:         number;
    /* Kul ke SAATH batwara bhi (29 Aug 2026). Pehle sirf jod rakha jata tha aur teen
       aankde ek me mil kar khatam ho jate the — jabki AI unhe alag hi deta hai. Uska
       nateeja GST report me dikhta tha: har kharcha "intra-state" maan liya jata tha,
       aur Amazon ke IGST wale bill galat khaane me chale jate the. */
    igst?:       number;
    cgst?:       number;
    sgst?:       number;
    /** AI ki chuni hui category — list se milayi hui, warna undefined. */
    aiCategory?: string;
    billType:    "gst" | "kaccha";
    items:       { description: string; qty: string; unit_price: string; amount: string }[];
  };
  const [pending, setPending] = React.useState<PendingExtract | null>(null);
  // Vendor GSTIN read from the invoice — saved to the Vendors master on save so
  // the supplier's tax details are captured (the expenses row itself has none).
  const [aiGstin, setAiGstin] = React.useState<string | null>(null);
  /* Bill par likha GST ka batwara, confirm ke baad tak sambhala hua. `gst_paid` kul hi
     rehta hai — ye uske SAATH jata hai, uski jagah nahi. NULL ka matlab "bill par tha hi
     nahi", jo 0 ("naapa, shunya tha") se alag hai. Dekho lib/accounting/gst-heads.ts. */
  const [aiHeads, setAiHeads] = React.useState<{ igst: number | null; cgst: number | null; sgst: number | null } | null>(null);
  // After a bill read, whether the invoice's GSTIN/name matched an existing
  // vendor (link to it) or is new (add to the master on save). Drives a hint.
  const [vendorMatch, setVendorMatch] = React.useState<{ kind: "existing" | "new"; name: string } | null>(null);

  // Supplier invoice number + the existing-expenses list — used to catch a bill
  // that's already been entered (same bill uploaded / re-entered twice).
  const [billNo, setBillNo] = React.useState<string>(expense?.bill_no ?? "");
  const { data: dupList } = useExpenseDupList();
  const confirm = useConfirm();

  // Category is auto-picked from the "what was this for?" text — until the
  // operator changes it manually (then we stop overriding). On edit we respect
  // the saved category from the start.
  // A caller-chosen category counts as chosen — the keyword auto-pick must not flip it.
  const [categoryTouched, setCategoryTouched] = React.useState<boolean>(isEdit || Boolean(defaultCategory));
  const [categoryAuto, setCategoryAuto] = React.useState(false);

  // Open the just-uploaded bill (a local File, not yet stored) in a new tab.
  // An anchor-click is more reliable than window.open for blob: URLs (some
  // browsers open a blank tab for window.open(blob, _blank, noopener)).
  const openLocalFile = () => {
    if (!attachFile) return;
    const url = URL.createObjectURL(attachFile);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  async function handleBillFile(file: File) {
    setAiError(null); setAiNote(null); setPending(null);
    if (file.size > 8 * 1024 * 1024) { setAiError("File is too big (max 8 MB) — try a smaller photo."); return; }
    setAttachFile(file);   // keep it — attaches to the expense on save (proof)
    setReading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve((r.result as string).split(",")[1] ?? "");
        r.onerror = () => reject(new Error("read failed"));
        r.readAsDataURL(file);
      });
      const res = await fetch("/api/ai/extract-bill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileBase64: base64, mimeType: file.type }),
      });
      const json = await res.json();
      if (!res.ok) { setAiError(json.error ?? "Couldn't read the bill — fields haath se bhar do. 📎 bill attach ho jayega."); return; }
      const f = json.fields as Record<string, unknown>;
      const cur = String(f.currency ?? "INR").toUpperCase();
      /* Teeno ALAG bhi rakhe jate hain, sirf jod kar nahi. `gst` kul hai (form aur
         `gst_paid` usi par chalte hain), aur igst/cgst/sgst wo naapa hua batwara hai jo
         GST report ko "maan-na" band karne deta hai. */
      const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
      const eIgst = num(f.igst), eCgst = num(f.cgst), eSgst = num(f.sgst);
      const gst = eCgst + eSgst + eIgst;
      const items = Array.isArray(f.line_items) ? (f.line_items as Array<Record<string, unknown>>) : [];
      // Hold the read for the operator to CONFIRM — nothing fills the form yet.
      setPending({
        vendorName: f.vendor_name ? String(f.vendor_name) : undefined,
        gstin:      f.vendor_gstin ? String(f.vendor_gstin).toUpperCase() : undefined,
        billNo:     f.bill_no ? String(f.bill_no) : undefined,
        billDate:   f.bill_date   ? String(f.bill_date)   : undefined,
        currency:   cur,
        total:      f.total != null ? Number(f.total) : undefined,
        aiCategory: typeof f.expense_category === "string" && f.expense_category ? f.expense_category : undefined,
        igst:       eIgst || undefined,
        cgst:       eCgst || undefined,
        sgst:       eSgst || undefined,
        gst,
        billType:   gst > 0 ? "gst" : "kaccha",
        items: items.map((it) => ({
          description: String(it.description ?? ""),
          qty:         it.qty        != null ? String(it.qty)        : "",
          unit_price:  it.unit_price != null ? String(it.unit_price) : "",
          amount:      it.amount     != null ? String(it.amount)     : "",
        })),
      });
    } catch {
      setAiError("Upload failed — try again, ya fields haath se bhar do.");
    } finally {
      setReading(false);
    }
  }

  // Operator confirmed the read is correct → fill the form (header + items).
  function applyExtract() {
    if (!pending) return;
    if (pending.gstin) setAiGstin(pending.gstin);
    setBillNo(pending.billNo ?? "");
    // Match the invoice's GSTIN (then name) against the Vendors master:
    //  match   → link to that existing vendor (no duplicate),
    //  no match → a new vendor is added on save (carrying this GSTIN).
    /* AI ki category PEHLE. Wo poora bill dekh kar bolti hai — vendor, har line item, HSN —
       jabki keyword-table sirf naam par chalti hai aur product ke naam par tootti hai (ek
       gadda "Travel" ban gaya tha, kyunki uske naam me "Ruyi Gadi" tha). Keyword ab bhi
       fallback hai, aur chhote note par wahi behtar rehti hai. */
    if (pending.aiCategory) { setValue("category", pending.aiCategory); setCategoryAuto(true); }
    /* ── POORE RUPAYE. Bill par paise hote hain, khaana integer hai. ──────────
       `expenses.igst/cgst/sgst` integer hain — theek `gst_paid` ki tarah, jo hamesha se
       poore rupaye me hai. Bill par ₹295.63 likha hota hai, aur AI wahi lautata hai.

       Bina round kiye Postgres seedha mana kar deta hai:

           invalid input syntax for type integer: "295.63"

       Ye 30 Aug 2026 ko Pardeep ne screen par pakda. Us se pehle main teen baar khud Save
       chala chuka tha aur maan raha tha ki rukavat meri jaanch ka artefact hai — kyunki
       mere paas wo toast dikha hi nahi. Wo asli bug tha, aur mera hi tha: naye khaane usi
       raat maine jode the aur unhe `gst_paid` wala rounding dena bhool gaya.

       Paise ka udna yahan naya nuksaan nahi hai — `gst_paid` pehle se poore rupaye rakhta
       hai, aur GST return bhi rupaye me bharta hai. `expenseGstHeads` ka ±1 rupaye wala
       jhukav theek isi liye likha gaya tha. */
    const rupaye = (v: number | undefined) => (v ? Math.round(v) : 0);
    setAiHeads(
      pending.igst || pending.cgst || pending.sgst
        ? { igst: rupaye(pending.igst), cgst: rupaye(pending.cgst), sgst: rupaye(pending.sgst) }
        : null,
    );
    const gst = pending.gstin?.trim().toUpperCase();
    const nm  = pending.vendorName?.trim();
    const byGstin = gst ? (vendors ?? []).find((v) => (v.gstin ?? "").trim().toUpperCase() === gst) : undefined;
    const byName  = !byGstin && nm ? (vendors ?? []).find((v) => v.name.trim().toLowerCase() === nm.toLowerCase()) : undefined;
    const match = byGstin ?? byName;
    if (match) {
      setValue("vendor_name", match.name);
      setVendorId(match.id);
      setVendorMatch({ kind: "existing", name: match.name });
    } else {
      if (nm) setValue("vendor_name", nm);
      setVendorId(null);
      setVendorMatch(nm ? { kind: "new", name: nm } : null);
    }
    if (pending.billDate)   setValue("expense_date", pending.billDate);
    setBillType(pending.billType);
    setCurrency(pending.currency);
    if (pending.total != null) setValue("amount", pending.total);
    setValue("gst_paid", pending.gst);
    setLines(pending.items.map((it) => ({ ...it, category: "" })));   // category set per line by operator
    if (pending.items.length) setShowItems(true);   // AI found line items → show them
    if (pending.currency !== "INR") {
      setFxRate("");   // force today's rate before it hits the ₹ books
      setAiNote(`Bhar diya · bill ${pending.currency} me hai — neeche exchange rate (₹/${pending.currency}) daalo, phir Save. 📎 bill attach ho jayega.`);
    } else {
      setAiNote("Bhar diya — amounts bill se milaa ke Save karo. 📎 bill attach ho jayega.");
    }
    setPending(null);
  }

  // Operator says the read is wrong / wants to enter manually → discard the
  // extraction (NO items, NO amounts auto-added), but keep the bill attached.
  function discardExtract() {
    setPending(null);
    setAiNote(`Theek — fields aur items khud bhar do. 📎 "${attachFile?.name ?? "bill"}" expense ke saath attach ho jayega.`);
  }

  const {
    register, handleSubmit, watch, setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: expense
      ? {
          expense_date:   expense.expense_date,
          category:       expense.category,
          vendor_name:    expense.vendor_name ?? "",
          // Foreign expense: show amounts in the bill's currency (₹ ÷ rate).
          amount:         expense.currency !== "INR" && expense.fx_rate ? Math.round((expense.amount / expense.fx_rate) * 100) / 100 : expense.amount,
          gst_paid:       expense.currency !== "INR" && expense.fx_rate ? Math.round((expense.gst_paid / expense.fx_rate) * 100) / 100 : expense.gst_paid,
          payment_method: expense.payment_method ?? "bank_transfer",
          description:    expense.description ?? "",
          notes:          expense.notes ?? "",
          tds_section:    expense.tds_section ?? "",
          tds_amount:     expense.tds_amount ?? 0,
        }
      : {
          expense_date: today,
          category: defaultCategory ?? (presetAdvanceId ? "Staff Welfare" : "Hosting"),
          payment_method: presetAdvanceId ? EMPLOYEE_ADVANCE_METHOD : "bank_transfer",
          amount: 0,
          gst_paid: 0,
          tds_amount: 0,
        },
  });

  // Auto-pick the category from the item rows + vendor name (one category per
  // bill). It picks ONCE — the first confident match freezes so adding more
  // items doesn't keep flipping the category. Stops entirely once the operator
  // changes it themselves; they can always override.
  const itemText = lines.map((l) => l.description).filter(Boolean).join(" ");
  const noteText = watch("description") ?? "";
  const vendorNameWatch = watch("vendor_name") ?? "";

  /* Marketing spend carries its channel, so Marketing → ROAS & CAC can set it against the
     leads that channel brought in. Offered from the vendor's name until the operator picks. */
  const isMarketing = isMarketingCategory(watch("category"));
  const [channel, setChannel] = React.useState<string>(expense?.channel ?? "");
  const [channelTouched, setChannelTouched] = React.useState<boolean>(Boolean(expense?.channel));
  /* Marketing campaign (migration 20260926240000) — puts this spend against a budget. */
  const campaignOptions = useCampaignOptions();
  const [campaignId, setCampaignId] = React.useState<string>(expense?.campaign_id ?? "");
  React.useEffect(() => {
    if (!isMarketing || channelTouched) return;
    const s = suggestAdChannel(`${vendorNameWatch} ${noteText} ${itemText}`);
    if (s) setChannel(s);
  }, [isMarketing, channelTouched, vendorNameWatch, noteText, itemText]);

  /* Commission to an outside agent: the payee is required, and one person's commission for
     the year decides s.194H (lib/accounting/commission-tds.ts). */
  const isCommission = watch("category") === COMMISSION_CATEGORY;
  const { data: commissionSoFar } = useCommissionToPayeeThisFy(
    isCommission ? vendorNameWatch : "",
    watch("expense_date") || localDateISO(new Date()),
    expense?.id ?? null,
  );
  /* TDS decides itself (lib/accounting/tds-deductor.ts, 27 Sep 2026): the section's
     threshold against what this payee got this FY, the rate from the vendor's PAN (1% for
     an individual contractor, 20% with no PAN), 194Q only above ₹50L — until the operator
     types an amount; an existing entry's recorded TDS is never overwritten on open. */
  const [tdsEdited, setTdsEdited] = React.useState<boolean>(Boolean(expense && (expense.tds_amount ?? 0) > 0));
  const tdsSectionNow = watch("tds_section") || "";
  const tdsBaseNow = tdsBase(Number(watch("amount")) || 0, isGstBill ? Number(watch("gst_paid")) || 0 : 0);
  const tdsRate = TDS_SECTION_RATES[tdsSectionNow] ?? null;
  const tdsVendor = vendorId ? (vendors ?? []).find((v) => v.id === vendorId) ?? null : null;
  const { data: vendorTdsSoFar } = useVendorTdsThisFy(vendorId, vendorNameWatch, tdsSectionNow, watch("expense_date") || localDateISO(new Date()), expense?.id ?? null);
  const tdsView = tdsSectionNow && vendorTdsSoFar
    ? tdsDecision({ section: tdsSectionNow, base: tdsBaseNow, fyBaseSoFar: vendorTdsSoFar.base, fyBaseWithoutTds: vendorTdsSoFar.baseWithoutTds, pan: tdsVendor?.pan ?? panFromGstin(tdsVendor?.gstin) })
    : null;
  const tdsSuggested = tdsView ? tdsView.tds : null;
  React.useEffect(() => {
    if (tdsEdited || tdsSuggested === null) return;
    setValue("tds_amount", tdsSuggested);
  }, [tdsEdited, tdsSuggested, setValue]);

  /* Same letters as an employee's name ("abhishek" = "Abhishek", "Hites H Babu" = "Hitesh Babu"). */
  const { data: employeeList } = useEmployees();
  const payeeEmployee = React.useMemo(() => {
    const key = compactName(vendorNameWatch);
    if (!isCommission || key.length < 3) return null;
    return (employeeList ?? []).find((e) => e.is_active !== false && compactName(e.name) === key) ?? null;
  }, [isCommission, vendorNameWatch, employeeList]);
  const commissionView = isCommission && commissionSoFar && vendorNameWatch.trim().length >= 2
    ? commissionTdsView({ amount: Number(watch("amount")) || 0, earlier: commissionSoFar.earlier, earlierWithoutTds: commissionSoFar.earlierWithoutTds })
    : null;
  // Category source = the note in simple mode, the item rows in itemised mode.
  const catText = showItems ? itemText : noteText;
  React.useEffect(() => {
    if (categoryTouched || categoryAuto) return;
    /* Itemise mode me `catText` bill ki item-line se aata hai — wo PRODUCT ka naam hai,
       operator ka likha note nahi. Us farq ko bataana zaroori hai: ek 180-akshar ke Amazon
       title me "Travel" ya "Gadi" jaise shabd product ka varnan karte hain, kharche ka
       nahi. Wajah lib/queries/expenses.ts me likhi hai. */
    const s = suggestCategory(`${catText} ${vendorNameWatch}`,
      showItems ? { source: "product" } : undefined);
    if (s) { setValue("category", s); setCategoryAuto(true); }
  }, [catText, vendorNameWatch, categoryTouched, categoryAuto, setValue]);

  // COGS-vs-OPEX guardrail: does the vendor / category / note look like a
  // product this reseller RESELLS (so it belongs in COGS Bills, not Expenses)?
  const resaleHint = React.useMemo(() => {
    const hay = `${vendorNameWatch} ${watch("category") ?? ""} ${catText}`.toLowerCase();
    return /(google ?workspace|g ?suite|workspace|microsoft ?365|\bm365\b|office ?365|\bo365\b|\bzoho\b|\bazure\b|\baws\b|google ?cloud|\bgcp\b|cloud ?hosting|reseller|\bcsp\b)/.test(hay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorNameWatch, catText, watch("category")]);

  // Itemised totals + the category split preview.
  /* `category` schema me ab optional hai (wajah schema par likhi hai), isliye yahan
     saaf khaali string — `undefined` neeche har jagah ghusta hai jahan string chahiye. */
  const headerCategory = watch("category") ?? "";
  const itemiseActive = showItems && lines.some((l) => l.description.trim() || l.amount);
  const lineSubtotalNum = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const splitGroups = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) {
      if (!(l.description.trim() || l.amount)) continue;
      const cat = l.category || headerCategory;
      m.set(cat, (m.get(cat) ?? 0) + Number(l.amount || 0));
    }
    return Array.from(m.entries()).map(([category, amount]) => ({ category, amount }));
  }, [lines, headerCategory]);
  // When itemising, the total Amount is the items' sum — keep the field in sync.
  React.useEffect(() => {
    if (itemiseActive) setValue("amount", lineSubtotalNum || 0);
  }, [itemiseActive, lineSubtotalNum, setValue]);

  async function onSubmit(values: FormData) {
    /* Category ki shart yahan lagti hai, schema me nahi — wajah schema par likhi hai.
       Sandesh TOAST par jata hai, kisi field ke neeche nahi: itemise mode me wo field
       screen par hoti hi nahi, aur ek anddekha error hi ye poora bug tha. */
    const catErr = expenseCategoryError({
      itemised: itemiseActive,
      formCategory: values.category,
      itemCategories: lines.map((l) => l.category),
    });
    if (catErr) {
      toast.error(catErr, { description: "Pick a category, then save again. Nothing was saved." });
      return;
    }

    // ── Someone else paid our expense → record as a REIMBURSEMENT (payable to
    //    that person). add_reimbursement books the expense + the payable together,
    //    so we do NOT also create an expense here. ──
    if (reimburse) {
      const person = reimbursePerson.trim();
      if (!person) {
        toast.error("Who paid for this?", { description: "Type that person's name in \"Kisne diya?\" — we owe them this money back. Nothing was saved." });
        return;
      }
      const amt = Math.round((values.amount || 0) * rate);
      if (amt <= 0) {
        toast.error("Enter the amount.", { description: "The amount they paid must be more than ₹0. Nothing was saved." });
        return;
      }
      await addReimb.mutateAsync({
        person,
        purpose:    values.notes?.trim() || values.description?.trim() || (values.category ?? ""),
        category:   values.category ?? "",
        amount:     amt,
        gst:        isGstBill ? Math.round((values.gst_paid || 0) * rate) : 0,
        incurredOn: values.expense_date,
      });
      onClose();
      return;
    }

    const fromAdvance = paid && values.payment_method === EMPLOYEE_ADVANCE_METHOD;
    if (fromAdvance && !advanceId) {
      toast.error("Pick whose advance this was paid from.", { description: "The bill is taken off that person's advance balance. Choose them under \"Paid by\"." });
      return;
    }

    const payee = values.vendor_name?.trim() || "";
    /* A commission with no payee cannot be totalled per person, so s.194H cannot be checked —
       and the question "who did we pay commission to?" has no answer. */
    if (values.category === COMMISSION_CATEGORY && !payee) {
      toast.error("Who was the commission paid to?", { description: "Type their name in \"Kisko diya\" — TDS under s.194H is checked per person. Nothing was saved." });
      return;
    }
    // Only GST-invoice suppliers belong in the Vendors master. So: an already-
    // picked vendor keeps its link; a NEW typed payee is added to Vendors only
    // when this is a GST bill (GST paid entered). Non-GST / one-off payees stay
    // as a free-text name and don't clutter the supplier master.
    // Only a GST invoice adds a NEW payee to the Vendors master + carries GST.
    const vId = payee
      ? (vendorId ?? (isGstBill ? await ensureVendor({ name: payee, gstin: aiGstin ?? undefined, defaultCategory: values.category }) : null))
      : null;

    // Foreign bill must have an exchange rate before it hits the ₹ books.
    if (isForeign && rate <= 0) {
      setFxError(`Enter today's exchange rate (₹ per 1 ${currency}) to save — the ₹ books need it.`);
      return;
    }
    setFxError(null);
    const inr = (n: number) => Math.round(n * rate);   // convert entered currency → ₹ (rate 1 for INR)

    // Attach the uploaded bill (proof) — non-fatal if the upload hiccups; the
    // expense still saves. Keep any existing attachment on edit if no new file.
    let attachment_url: string | null = expense?.attachment_url ?? null;
    if (attachFile) {
      try { attachment_url = await uploadBillAttachment(attachFile); }
      catch { /* keep saving the expense even if the file upload fails */ }
    }
    // Marketing channel (0232) — only on marketing rows, NULL everywhere else.
    const channelFor = (cat: string) => (isMarketingCategory(cat) ? (channel || null) : null);
    const campaignFor = (cat: string) => (isMarketingCategory(cat) ? (campaignId || null) : null);
    const shared = {
      /* Bill se naapa hua GST batwara. Iske bina GST report har kharche ko intra-state
         MAAN leti hai (aadha CGST, aadha SGST, IGST shunya) — aur Amazon jaise
         doosre-rajya ke bill par wo galat khaana hai. Dekho lib/accounting/gst-heads.ts. */
      igst: aiHeads?.igst ?? null,
      cgst: aiHeads?.cgst ?? null,
      sgst: aiHeads?.sgst ?? null,
      vendor_name:  payee || null,
      vendor_id:    vId,
      currency,
      fx_rate:      rate,
      bill_type:    billType,
      bill_no:      billNo.trim() || null,
      attachment_url,
      expense_date: values.expense_date,
      payment_method: values.payment_method || null,
      // Paid → stamp when (bill date is a fine proxy for an immediate spend);
      // payable → carry the due date and leave paid_date empty.
      paid,
      paid_date: paid ? values.expense_date : null,
      due_date:  paid ? null : (dueDate || null),
      // Tag as a project cost (per-project P&L). Preset from the project page,
      // else preserve whatever the expense already had on edit.
      project_id: projectId ?? expense?.project_id ?? null,
      // TDS deducted on this payment (26Q, deductor side). Stored in ₹ as typed.
      tds_section: values.tds_section?.trim() || null,
      rcm,
      rcm_tax: rcm ? (rcmTax.trim() !== "" ? Math.max(0, Math.round(Number(rcmTax) || 0)) : Math.round(inr(Number(values.amount) || 0) * 0.18)) : 0,
      tds_amount:  Math.round(values.tds_amount || 0),
      // Source bank account for a bank/UPI/card/cheque payment (not cash).
      bank_account_id: paid && values.payment_method !== "cash" && !fromAdvance ? (bankAccountId || null) : null,
      /* Paid from a staff advance: the database takes it off that advance's balance and
         refuses more than is left (trigger, migration 20261001150000). */
      prepaid_advance_id: fromAdvance ? advanceId : (expense?.payment_method === EMPLOYEE_ADVANCE_METHOD ? null : expense?.prepaid_advance_id ?? null),
      // Longer free-text comment / extra detail (optional).
      notes: values.notes?.trim() || null,
    };
    // Cash only leaves petty cash once actually PAID — an unpaid bill must not.
    const pettyCash = paid && values.payment_method === "cash" ? (pettyCashAccountId || null) : null;

    // ── Category-wise lines (itemised). Each line's category (blank → header).
    //    A mixed bill auto-splits into one expense per category on save. ──
    const catLines = lines
      .map((l) => ({
        name:     l.description.trim(),
        amount:   Number(l.amount || 0),
        category: l.category || values.category || "",
        qty:      l.qty ? Number(l.qty) : undefined,
        rate:     l.unit_price ? Number(l.unit_price) : undefined,
      }))
      .filter((l) => l.name || l.amount !== 0);
    const distinctCats = new Set(catLines.map((l) => l.category));
    // Split only makes sense for a NEW itemised bill spanning >1 category.
    const isSplit = !expense && showItems && catLines.length > 0 && distinctCats.size > 1;

    if (isSplit) {
      // Apportion the (currency) GST across categories; each group → one expense.
      const groups = splitLinesByCategory(catLines, isGstBill ? values.gst_paid : 0);
      const dupCats = groups
        .filter((g) => findDuplicateExpense({ vendorId: vId, vendorName: payee, billNo: shared.bill_no, category: g.category }, (dupList ?? []) as never))
        .map((g) => g.category);
      if (dupCats.length) {
        const ok = await confirm({
          title: "Kuch entries pehle se lagti hain",
          body: `Is bill (${shared.bill_no ? `#${shared.bill_no}` : payee}) mein in category ki entry already hai: ${dupCats.join(", ")}. Phir bhi banayein?`,
          danger: true, confirmLabel: "Haan, banao", cancelLabel: "Nahi",
        });
        if (!ok) return;
      }
      for (const [gi, g] of groups.entries()) {
        await create.mutateAsync({
          ...shared,
          category:   g.category,
          channel:    channelFor(g.category),
          campaign_id: campaignFor(g.category),
          line_items: g.items,
          amount:     inr(g.amount + (isGstBill ? g.gst : 0)),   // subtotal + its GST share
          gst_paid:   isGstBill ? inr(g.gst) : 0,
          /* Ek bill kai category me bant raha hai, aur har leg ko GST ka ek HISSA mila
             hai. Poora batwara har leg par chipka dena use teen-guna gin lega. Aur use
             anupaat me baant kar ek naya aankda banana bhi theek nahi — wo bill par likha
             hi nahi hai. Isliye yahan NULL: report use saaf "maana hua" kahegi, jo sach
             hai. Ek hi leg wala bill (aam soorat, aur Amazon wali) upar se batwara
             poora leta hai. */
          igst: null, cgst: null, sgst: null,
          description: g.items.map((it) => it.name).filter(Boolean).join(", ") || null,
          pettyCashAccountId: pettyCash,   // each leg deducts its share → total correct
          // TDS is one deduction for the whole bill — attach it to the first leg only.
          tds_section: gi === 0 ? shared.tds_section : null,
          tds_amount:  gi === 0 ? shared.tds_amount : 0,
        });
      }
      onClose();
      return;
    }

    // ── Single expense (simple, or itemised single-category). ──
    // Itemise: amount = lines subtotal + GST; simple: the typed "incl GST" amount.
    const lineSubtotal = catLines.reduce((s, l) => s + l.amount, 0);
    const gstAmt = isGstBill ? inr(values.gst_paid) : 0;
    const amountInr = showItems && catLines.length > 0
      ? inr(lineSubtotal) + gstAmt
      : inr(values.amount);
    const line_items = catLines.map((l) => ({ name: l.name, qty: l.qty, rate: l.rate, amount: l.amount }));
    /* Upar wali jaanch (`expenseCategoryError`) guarantee kar chuki hai ki in dono me se
       ek to hai — warna hum yahan pahunchte hi nahi. */
    const category = (showItems && catLines.length > 0 ? (catLines[0].category || values.category) : values.category) ?? "";
    const derivedDescription = line_items.map((l) => l.name).filter(Boolean).join(", ") || values.description?.trim() || null;

    // Duplicate guard — same vendor + bill no. + category (or vendor+date+amount).
    const dup = findDuplicateExpense(
      { vendorId: vId, vendorName: payee, billNo: shared.bill_no, billDate: values.expense_date, amountInr, category },
      (dupList ?? []) as never,
      expense?.id,
    );
    if (dup) {
      const ok = await confirm({
        title: "Ye bill pehle se entered lagta hai",
        body: `${payee || "Is vendor"} ka ${shared.bill_no ? `bill #${shared.bill_no}` : `${formatDate(dup.expense_date)} · ${rupee(dup.amount)}`} — isi category (${category}) mein already record hai. Duplicate entry P&L + input GST dono double kar degi. (Alag category ka hissa ho to category badal ke save karo.) Phir bhi ek aur banayein?`,
        danger: true, confirmLabel: "Haan, phir bhi save", cancelLabel: "Nahi, rehne do",
      });
      if (!ok) return;
    }

    if (expense) {
      await update.mutateAsync({
        id: expense.id,
        patch: { ...shared, category, channel: channelFor(category), campaign_id: campaignFor(category), line_items, amount: amountInr, gst_paid: gstAmt, description: derivedDescription },
      });
      onClose();
      return;
    }
    await create.mutateAsync({
      ...shared,
      category, channel: channelFor(category), campaign_id: campaignFor(category), line_items, amount: amountInr, gst_paid: gstAmt,
      description: derivedDescription,
      pettyCashAccountId: pettyCash,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle>{projectId ? (isEdit ? "Edit project cost" : "Add project cost") : (isEdit ? "Edit expense" : "Add expense")}</DialogTitle>
          <DialogDescription>
            {projectId
              ? "A cost of this project — labour, subcontract, tools, etc. It counts against the project's profit and in your overall P&L."
              : "A running-the-business cost — rent, software, stationery, etc. (Products you resell → COGS Bills.)"}
          </DialogDescription>
        </DialogHeader>

        {projectId && projectTitle && (
          <div className="rounded-lg border border-hairline bg-paper-2/50 px-3 py-2 text-xs text-ink-2 inline-flex items-center gap-1.5">
            <Icon name="package" size={13} className="text-ink-3" />
            Cost for project: <span className="font-medium text-ink">{projectTitle}</span>
          </div>
        )}

        {/* The mutation already shows the reason (e.g. "Only ₹4800 is left …"); catching here
            stops the same refusal also landing in the console as an uncaught promise. */}
        <form onSubmit={handleSubmit(async (v) => { try { await onSubmit(v); } catch { /* toast shown by the mutation */ } })} className="space-y-4">
          {/* ── STEP 1: What kind of bill? This shapes the whole form. ── */}
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Is kharche ka bill?</p>
            <div className="grid grid-cols-3 gap-1.5">
              {([["none", "No bill / cash"], ["kaccha", "Kaccha bill"], ["gst", "GST invoice"]] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => {
                    setBillType(val);
                    if (val !== "gst") { setValue("gst_paid", 0); setVendorId(null); setCurrency("INR"); setFxError(null); }
                  }}
                  className={cn(
                    "rounded-md border px-2 py-2 text-[12px] font-medium transition-colors text-center",
                    billType === val ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className={cn("mt-1.5 text-xs leading-snug", isGstBill ? "text-ink-3" : "text-amber-ink")}>
              {billType === "gst"
                ? "GST tax invoice — input GST claimable, vendor saved to your Vendors master."
                : billType === "kaccha"
                ? "Informal / non-GST bill — deductible, but no input GST credit."
                : "No bill (petty cash etc.) — deductible, but no input GST credit."}
            </p>
          </div>

          {!isEdit && (
            <p className="text-xs text-ink-3 leading-relaxed">
              Salary de rahe ho?{" "}
              <button type="button" onClick={() => { onClose(); router.push("/accounting/payroll" as never); }}
                className="text-amber-ink font-medium underline hover:no-underline">Payroll &amp; Leave me book karo →</button>{" "}
              taaki payslip + statutory sahi rahe.
            </p>
          )}

          {/* ── STEP 2: Upload the bill (only when there IS one). AI fills → confirm. ── */}
          {billType !== "none" && (
            <div className="rounded-md border border-dashed border-amber/50 bg-amber-soft/15 p-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon name="sparkles" size={16} className="text-amber-ink shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-ink">Bill upload karo — AI khud bhar dega</p>
                    <p className="text-xs text-ink-3">Photo/PDF — AI fields + items nikaal dega, aap confirm karke Save karo</p>
                  </div>
                </div>
                <Button type="button" variant="primary" size="sm" icon="upload" loading={reading} onClick={() => fileRef.current?.click()}>
                  {reading ? "Reading…" : "Upload bill"}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBillFile(f); e.target.value = ""; }}
                />
              </div>
              {aiNote && <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald"><Icon name="check_circle" size={12} className="mt-0.5 shrink-0" /> {aiNote}</p>}
              {aiError && <p className="mt-2 flex items-start gap-1.5 text-xs text-rose"><Icon name="alert" size={12} className="mt-0.5 shrink-0" /> {aiError}</p>}

              {/* Confirmation gate — AI read something; confirm before it fills. */}
              {pending && (() => {
                const fmt = (n: number) => pending.currency !== "INR" ? (formatForeignAmount(pending.currency, n) ?? `${pending.currency} ${n}`) : rupee(n);
                const pg = pending.gstin?.trim().toUpperCase();
                const pv = pending.vendorName?.trim().toLowerCase();
                const existing = (vendors ?? []).find(
                  (v) => (pg && (v.gstin ?? "").trim().toUpperCase() === pg) || (pv && v.name.trim().toLowerCase() === pv),
                );
                const shownGstin = pending.gstin || existing?.gstin || null;
                const dupInReview = findDuplicateExpense(
                  { vendorId: existing?.id ?? vendorId, vendorName: pending.vendorName, billNo: pending.billNo, billDate: pending.billDate, amountInr: pending.currency === "INR" ? (pending.total ?? null) : null },
                  (dupList ?? []) as never,
                  expense?.id,
                );
                return (
                  <div className="mt-2.5 rounded-md border border-amber/40 bg-paper p-3">
                    <p className="text-[12px] font-medium text-ink mb-2">AI ne ye padha — sahi hai? Confirm karo tabhi bharega.</p>
                    {dupInReview && (
                      <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-soft/60 px-2.5 py-2 text-xs text-amber-ink">
                        <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
                        <span>Isi bill{` (${pending.billNo ? `#${pending.billNo}` : `${formatDate(dupInReview.expense_date)} · ${rupee(dupInReview.amount)}`})`} ki ek entry pehle se hai. Agar ye <b>alag category ka hissa</b> hai to theek — warna duplicate ho jayega.</span>
                      </div>
                    )}
                    {/* ── Label ke SAATH value, dono kinaron par nahi (29 Aug 2026) ──────
                        Har row `flex justify-between` thi. Chaudi screen par wo label ko
                        bilkul baayen aur value ko bilkul daayen phenk deti thi. Pardeep ne
                        pakda; naapa to haal ye tha:

                            Vendor    1,089px khaali    Coca Industries
                            GSTIN     1,143px           23EZFPS9892N2Z7
                            Bill no.  1,185px           TLTK-4450

                        Poore ek hazaar pixel se zyada khaali jagah — aankh label aur uski
                        value ko jod hi nahi paati. Aur ye panel ka poora kaam hi yahi hai:
                        aadmi ise PADHKAR confirm karta hai, aur uske baad ye aankde seedha
                        uski books me jaate hain. Jo jodi padhi na ja sake, wo jaanchi bhi
                        nahi ja sakti.

                        Ab do-column grid: label utni hi chaudi jitna uska text, value
                        uske theek baad. `max-w-xl` isliye ki dialog chahe kitna bhi chauda
                        ho, padhne ki chaudai ek hi rehti hai.

                        `<dl>/<dt>/<dd>` isliye ki ye sach me ek definition list hai —
                        screen reader ko bhi wahi jodi milti hai jo aankh ko. */}
                    <dl className="grid max-w-xl grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px] text-ink-2">
                      <dt className="text-ink-3">Vendor</dt>
                      <dd className="min-w-0 text-ink flex items-center gap-1.5 flex-wrap">
                        <span className="break-words">{pending.vendorName || "—"}</span>
                        {existing
                          ? <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald/10 text-emerald px-1.5 py-0.5 text-3xs font-medium"><Icon name="check_circle" size={10} /> Existing</span>
                          : (pending.vendorName && <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-soft text-amber-ink px-1.5 py-0.5 text-3xs font-medium"><Icon name="plus" size={10} /> New</span>)}
                      </dd>
                      {shownGstin && <><dt className="text-ink-3">GSTIN</dt><dd className="min-w-0 font-mono text-ink break-all">{shownGstin}</dd></>}
                      {pending.billNo && <><dt className="text-ink-3">Bill no.</dt><dd className="min-w-0 font-mono text-ink break-all">{pending.billNo}</dd></>}
                      <dt className="text-ink-3">Bill date</dt>
                      <dd className="min-w-0">{pending.billDate || "—"}</dd>
                      <dt className="text-ink-3">Total{pending.currency !== "INR" ? ` (${pending.currency})` : ""}</dt>
                      <dd className="min-w-0 font-mono text-ink">{pending.total != null ? fmt(pending.total) : "—"}{pending.gst > 0 ? ` · GST ${fmt(pending.gst)}` : ""}</dd>
                    </dl>
                    {pending.items.length > 0 && (
                      <div className="mt-2 border-t border-hairline pt-2">
                        <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{pending.items.length} item{pending.items.length > 1 ? "s" : ""}</p>
                        {/* `min-w-0` ke bina `truncate` kuch nahi karta: flex ka bachcha apne
                            content se chhota hota hi nahi, aur wo lamba naam poore panel ko
                            bahar dhakel deta hai — yahi 56px ka overflow tha (Amazon ka
                            product naam 180+ akshar ka hota hai).

                            `title` isliye ki jo kata wo hover par poora mile — a11y §4. */}
                        <ul className="space-y-0.5 max-h-28 overflow-y-auto">
                          {pending.items.map((it, i) => (
                            <li key={i} className="flex justify-between gap-2 text-xs">
                              <span className="min-w-0 truncate text-ink-2" title={it.description || undefined}>
                                {it.description || "—"}{it.qty ? ` × ${it.qty}` : ""}
                              </span>
                              <span className="font-mono text-ink-3 shrink-0">{it.amount ? fmt(Number(it.amount)) : "—"}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button type="button" variant="primary" size="sm" icon="check" onClick={applyExtract}>Haan, sahi hai — bhar do</Button>
                      <Button type="button" variant="default" size="sm" onClick={discardExtract}>Galat — main khud bharunga</Button>
                    </div>
                    <p className="mt-2 text-xs text-ink-3">Kaise bhi karo, 📎 <button type="button" onClick={openLocalFile} className="text-amber-ink underline hover:no-underline">{attachFile?.name}</button> bill attach ho jayega. (click karke dekho)</p>
                    {previewUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewUrl} alt="Invoice preview" onClick={openLocalFile}
                        className="mt-2 max-h-40 w-auto rounded-md border border-hairline cursor-zoom-in" />
                    )}
                  </div>
                );
              })()}

              {attachFile && !pending && (
                <div className="mt-2">
                  <p className="flex items-center gap-1.5 text-xs text-ink-2">
                    <Icon name="file" size={12} />
                    <button type="button" onClick={openLocalFile} className="text-amber-ink underline hover:no-underline">{attachFile.name}</button>
                    — expense ke saath attach hoga
                  </p>
                  {previewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="Invoice preview" onClick={openLocalFile}
                      className="mt-2 max-h-40 w-auto rounded-md border border-hairline cursor-zoom-in" />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 4: What & how much ── */}
          <section className="rounded-lg border border-hairline bg-paper-2/30 p-3 space-y-3">
            <div className={cn("grid gap-3", showItems ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
              {/* Single category only in simple mode — in itemise mode each line
                  carries its own category, so a top-level one is redundant. */}
              {!showItems && (
                <FormField label="Category" required htmlFor="category">
                  <Select value={watch("category")} onValueChange={(v) => { setValue("category", v); setCategoryTouched(true); setCategoryAuto(false); }}>
                    <SelectTrigger id="category"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      {EXPENSE_CATEGORIES
                        .filter((c) => c !== "Salaries" || expense?.category === "Salaries")
                        .map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {categoryAuto && !categoryTouched && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-ink">
                      <Icon name="sparkles" size={10} /> Auto-chuni — galat ho to badal do.
                    </p>
                  )}
                  {isMarketing && (
                    <div className="mt-2">
                      <label htmlFor="ad-channel" className="text-xs font-medium text-ink-2">Channel (kis marketing ke liye)</label>
                      <Select value={channel || "none"} onValueChange={(v) => { setChannel(v === "none" ? "" : v); setChannelTouched(true); }}>
                        <SelectTrigger id="ad-channel" className="mt-1"><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Pata nahi / general</SelectItem>
                          {AD_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <p className="mt-1 text-xs text-ink-3 leading-snug">
                        Marketing → ROAS &amp; CAC isi se ad kharch ko us channel ki leads ke saath milata hai. Bina channel ke ye kharch wahan nahi gina jaata.
                      </p>
                      {(campaignOptions.data ?? []).length > 0 && (
                        <div className="mt-2">
                          <label htmlFor="ad-campaign" className="text-xs font-medium text-ink-2">Campaign (optional)</label>
                          <Select value={campaignId || "none"} onValueChange={(v) => setCampaignId(v === "none" ? "" : v)}>
                            <SelectTrigger id="ad-campaign" className="mt-1"><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Kisi campaign ka nahi</SelectItem>
                              {(campaignOptions.data ?? []).filter((c) => !c.cancelled || c.id === campaignId).map((c) => (
                                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}
                  {isCommission && (
                    <p className="mt-1 text-xs text-ink-3 leading-snug">
                      Bahar ke agent / broker ka commission. Neeche <b>&quot;Kisko diya&quot;</b> mein naam zaroor bharo — us vyakti ka
                      saal ka jod aur 194H TDS isi se tay hota hai. Apne employee ka incentive Payroll mein jaata hai.
                    </p>
                  )}
                </FormField>
              )}
              <FormField label="Date" required htmlFor="expense_date">
                <Input id="expense_date" type="date" error={errors.expense_date?.message} {...register("expense_date")} />
              </FormField>
            </div>

            {/* COGS vs OPEX guardrail — if the vendor/category/note looks like a
                product you RESELL (Workspace / M365 / Zoho / cloud), nudge toward
                COGS Bills so the P&L stays right. Gentle + non-blocking. */}
            {resaleHint && (
              <div className="flex items-start gap-2 rounded-md border border-amber/40 bg-amber-soft/40 p-2.5 text-[12px] text-amber-ink">
                <Icon name="info" size={14} className="mt-0.5 shrink-0" />
                <span>
                  Ye customer ko <b>resell</b> kar rahe ho? To ise <b>COGS Bills</b> me daalo (COGS), Expenses me nahi — tabhi P&amp;L sahi banega. Apne use ke liye hai to ignore karo.
                </span>
              </div>
            )}

            {/* What for — a simple note by default; switch to line items for a
                multi-line bill. Both feed the category + the saved description. */}
            {!showItems ? (
              <FormField label="Kis liye? (short note)" htmlFor="description">
                <Input id="description" placeholder="e.g. Team lunch · cab to client · courier · office snacks" {...register("description")} />
              </FormField>
            ) : !isPayroll ? (
              <div className="rounded-md border border-hairline bg-paper/60 p-2.5">
                <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">
                  Items — har item ki category{isForeign ? ` · amount ${currency} me` : ""}
                </p>
                <div className="space-y-2">
                  {lines.map((l, i) => (
                    <div key={i} className="rounded-md border border-hairline bg-paper p-2 space-y-2">
                      {/* Line 1: what it is + remove */}
                      <div className="flex items-center gap-2">
                        <Input aria-label="Item description" wrapperClassName="flex-1" placeholder="e.g. Laptop / A4 paper"
                          value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                        <button type="button" onClick={() => removeLine(i)} aria-label="Remove item"
                          className="shrink-0 text-ink-3 hover:text-rose p-1">
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                      {/* Line 2: qty × unit = amount · category */}
                      <div className="grid grid-cols-12 gap-2 items-center">
                        <Input aria-label="Qty" wrapperClassName="col-span-3 sm:col-span-2" className="text-right" type="number" min={0} step="any" placeholder="Qty"
                          value={l.qty} onChange={(e) => setQtyUnit(i, { qty: e.target.value })} />
                        <span className="col-span-1 text-center text-ink-3 text-xs">×</span>
                        <Input aria-label="Price" wrapperClassName="col-span-4 sm:col-span-2" className="text-right" type="number" step="any" placeholder={`Price ${isForeign ? currency : "₹"}`}
                          value={l.unit_price} onChange={(e) => setQtyUnit(i, { unit_price: e.target.value })} />
                        {/* Amount = qty×price (auto), editable; negatives allowed for credit lines */}
                        <Input aria-label="Amount" wrapperClassName="col-span-4 sm:col-span-3" className="text-right font-medium" type="number" step="any" placeholder={`Amount ${isForeign ? currency : "₹"}`}
                          value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />
                        <select aria-label="Category"
                          className="col-span-12 sm:col-span-4 h-9 rounded-md border border-hairline bg-paper px-2 text-[13px] text-ink"
                          value={l.category || headerCategory}
                          onChange={(e) => setLine(i, { category: e.target.value })}
                        >
                          {EXPENSE_CATEGORIES
                            .filter((c) => c !== "Salaries")
                            .map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </div>
                  ))}
                  <Button type="button" variant="ghost" size="sm" icon="plus" onClick={addLine}>Add item</Button>
                </div>

                {/* Split preview — >1 category ⇒ auto-split into that many entries. */}
                {splitGroups.length > 1 && (
                  <div className="mt-2 rounded-md bg-amber-soft/40 px-2.5 py-2 text-xs text-amber-ink leading-snug">
                    <b>{splitGroups.length} categories</b> → Save par {splitGroups.length} alag entries banengi (ek hi bill se judi):
                    <span className="block mt-0.5 text-ink-2">
                      {splitGroups.map((g) => `${g.category} ${isForeign ? "" : "₹"}${g.amount.toLocaleString("en-IN")}`).join("  ·  ")}
                    </span>
                  </div>
                )}
              </div>
            ) : null}

            {/* Toggle simple note ↔ itemised (hidden for payroll postings). */}
            {!isPayroll && (
              <button type="button" onClick={() => setShowItems((v) => !v)}
                className="text-xs text-amber-ink hover:underline">
                {showItems ? "− Simple note pe wapas" : "+ Itemise (bill ke line items daalo)"}
              </button>
            )}

            {/* Amount + GST (+ currency/FX only for a GST/OIDAR invoice). */}
            {isGstBill ? (
              <>
                <div className="grid grid-cols-12 gap-3">
                  <FormField label="Currency" htmlFor="currency" className="col-span-4 sm:col-span-3">
                    <Select value={currency} onValueChange={(v) => { setCurrency(v); if (v === "INR") setFxError(null); }}>
                      <SelectTrigger id="currency"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CURRENCY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label={itemiseActive ? `Subtotal (${isForeign ? currency : "₹"}) — items ka jod` : `Amount (${isForeign ? currency : "₹"}) incl GST`} required htmlFor="amount" className="col-span-8 sm:col-span-5">
                    <Input id="amount" type="number" min={1} step="any" readOnly={itemiseActive} error={errors.amount?.message} {...register("amount")} />
                  </FormField>
                  <FormField label={`${itemiseActive ? "GST" : "of which GST"} (${isForeign ? currency : "₹"})`} htmlFor="gst_paid" className="col-span-12 sm:col-span-4">
                    <Input id="gst_paid" type="number" min={0} step="any" {...register("gst_paid")} />
                  </FormField>
                </div>
                {isForeign && (
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <FormField label={`Exchange rate (₹ per 1 ${currency})`} required htmlFor="fx_rate">
                      <Input id="fx_rate" type="number" min={0} step="any" placeholder="e.g. 83.50"
                        value={fxRate} error={fxError ?? undefined}
                        onChange={(e) => { setFxRate(e.target.value); if (fxError) setFxError(null); }} />
                    </FormField>
                    {rate > 0 && Number(watch("amount")) > 0 && (
                      <p className="text-[12px] text-emerald pb-2">= ₹{Math.round(Number(watch("amount")) * rate).toLocaleString("en-IN")} in books{Number(watch("gst_paid")) > 0 ? ` · ₹${Math.round(Number(watch("gst_paid")) * rate).toLocaleString("en-IN")} GST` : ""}</p>
                    )}
                  </div>
                )}
                {!isForeign && (
                  <p className="text-xs text-ink-3">GST is the input tax credit portion of the amount above — claimable in your GST return.</p>
                )}
              </>
            ) : (
              <FormField label={itemiseActive ? "Amount (₹) — items ka jod" : "Amount (₹)"} required htmlFor="amount">
                <Input id="amount" type="number" min={1} step="any" readOnly={itemiseActive} error={errors.amount?.message} {...register("amount")} />
              </FormField>
            )}

            {/* Reverse charge — imported services. */}
            <label className="flex items-start gap-2 rounded-md border border-hairline p-2.5 cursor-pointer">
              <input type="checkbox" checked={rcm} onChange={(e) => { setRcm(e.target.checked); setRcmEdited(true); }} className="mt-0.5 rounded border-hairline" />
              <span className="text-xs text-ink-2">
                <b className="text-ink">Reverse charge (RCM)</b> — videshi vendor ka bill (Google Ireland, Meta, AWS, OpenAI): GST unhone nahi lagaya, IGST hum khud 3B mein cash se bharte hain aur usi mahine credit lete hain.
                {rcm && (
                  <span className="mt-1.5 flex items-center gap-2">
                    <span>IGST @18% ₹</span>
                    <Input type="number" min={0} value={rcmTax} onChange={(e) => setRcmTax(e.target.value)} placeholder={String(Math.round(inrPreview(Number(watch("amount")) || 0) * 0.18))} className="w-32" />
                    <span className="text-xs text-ink-3">khaali = 18% apne-aap</span>
                  </span>
                )}
              </span>
            </label>

            {/* TDS deducted (26Q) — optional; for rent / professional / contractor payments. */}
            <div className="grid grid-cols-12 gap-3">
              <FormField label="TDS deducted?" htmlFor="tds_section" className="col-span-5 sm:col-span-5">
                <Select value={watch("tds_section") || "none"} onValueChange={(v) => { setValue("tds_section", v === "none" ? "" : v); setTdsEdited(false); }}>
                  <SelectTrigger id="tds_section"><SelectValue placeholder="No TDS" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No TDS</SelectItem>
                    <SelectItem value="194C">194C · Contractor</SelectItem>
                    <SelectItem value="194J">194J · Professional / technical</SelectItem>
                    <SelectItem value="194I">194I · Rent</SelectItem>
                    <SelectItem value="194H">194H · Commission / brokerage</SelectItem>
                    <SelectItem value="194A">194A · Interest</SelectItem>
                    <SelectItem value="194Q">194Q · Purchase of goods</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              {(watch("tds_section") || "") !== "" && (
                <FormField label="TDS amount (₹)" htmlFor="tds_amount" className="col-span-7 sm:col-span-4">
                  <Input id="tds_amount" type="number" min={0} step="any" {...register("tds_amount", { onChange: () => setTdsEdited(true) })} />
                </FormField>
              )}
            </div>
            {(watch("tds_section") || "") !== "" && (
              <p className="text-xs text-ink-3">
                {tdsView ? (
                  <>
                    <span className={tdsView.noPan && tdsView.applies ? "text-rose" : tdsView.applies ? "text-ink-2" : "text-emerald"}>{tdsView.reason}</span>
                    {tdsView.applies && !tdsEdited ? ` ${tdsView.ratePct}% of ${rupee(tdsBaseNow)}${isGstBill && (Number(watch("gst_paid")) || 0) > 0 ? " (GST ke bina)" : ""} = ${rupee(tdsView.tds)} apne-aap bhara, badal sakte ho.` : ""}
                    {tdsView.applies && tdsRate?.note ? ` ${tdsRate.note}` : ""}{" "}
                  </>
                ) : tdsRate && !tdsEdited
                  ? <>{tdsRate.ratePct}% of {rupee(tdsBaseNow)} — apne-aap bhara, badal sakte ho. </>
                  : null}
                Record the TDS you deducted while paying this vendor — it feeds your quarterly 26Q return.
              </p>
            )}
          </section>

          {/* ── STEP 5: Paid already, or still to pay? ── */}
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Paisa de diya?</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
              <button type="button" onClick={() => { setPaid(true); setReimburse(false); }}
                className={cn("rounded-md border px-3 py-2 text-sm text-left transition-colors",
                  paid && !reimburse ? "border-amber bg-amber-soft/60 text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}>
                <span className="font-medium">Haan, de diya</span>
                <span className="block text-xs text-ink-3">Company ne pay kiya (cash/UPI/bank)</span>
              </button>
              {!isEdit && (
                <button type="button" onClick={() => { setReimburse(true); }}
                  className={cn("rounded-md border px-3 py-2 text-sm text-left transition-colors",
                    reimburse ? "border-amber bg-amber-soft/60 text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}>
                  <span className="font-medium">Kisi aur ne diya</span>
                  <span className="block text-xs text-ink-3">Reimbursement — company use wapas degi</span>
                </button>
              )}
              <button type="button" onClick={() => { setPaid(false); setReimburse(false); }}
                className={cn("rounded-md border px-3 py-2 text-sm text-left transition-colors",
                  !paid && !reimburse ? "border-amber bg-amber-soft/60 text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}>
                <span className="font-medium">Nahi, baad me</span>
                <span className="block text-xs text-ink-3">Udhaar — vendor ko dena baaki</span>
              </button>
            </div>
          </div>

          {reimburse ? (
            <FormField label="Kisne diya? (person)" htmlFor="reimburse_person">
              <Input id="reimburse_person" placeholder="e.g. Prateek / Darshan / self"
                value={reimbursePerson} onChange={(e) => setReimbursePerson(e.target.value)} />
              <p className="text-xs text-ink-3 mt-1">
                Kharcha company ka hai (P&amp;L me jayega), par paisa <b>{reimbursePerson.trim() || "is vyakti"}</b> ne apne pocket se diya —
                company ab unhe wapas degi (Reimbursements me &quot;payable&quot; ban jayega, baad me Settle karo).
              </p>
            </FormField>
          ) : paid ? (
            <FormField label="Paid by" htmlFor="payment_method">
              <Select value={watch("payment_method")} onValueChange={(v) => setValue("payment_method", v)}>
                <SelectTrigger id="payment_method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{m.replace(/_/g, " ")}</SelectItem>
                  ))}
                  {(openAdvances.length > 0 || watch("payment_method") === EMPLOYEE_ADVANCE_METHOD) && (
                    <SelectItem value={EMPLOYEE_ADVANCE_METHOD}>employee advance</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </FormField>
          ) : (
            <FormField label="Kab tak dena hai? (due date — optional)" htmlFor="due_date">
              <Input id="due_date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              <p className="text-xs text-ink-3 mt-1">P&amp;L mein aaj hi count hoga; bank/cash tab minus hoga jab &quot;Mark paid&quot; karoge.</p>
            </FormField>
          )}

          {/* Paid from a staff advance → whose, and how much is left (R-101). */}
          {paid && !reimburse && watch("payment_method") === EMPLOYEE_ADVANCE_METHOD && (
            <FormField label="Whose advance?" required htmlFor="employee_advance">
              <Select value={advanceId || "none"} onValueChange={(v) => setAdvanceId(v === "none" ? "" : v)}>
                <SelectTrigger id="employee_advance"><SelectValue placeholder="Pick an advance" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Pick an advance</SelectItem>
                  {openAdvances.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.employee_name} · ₹{a.remaining_balance.toLocaleString("en-IN")} left
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-ink-3 mt-1">
                {pickedAdvance
                  ? <>Taken from the money already with <b>{pickedAdvance.employee_name}</b>. No bank or cash moves now.</>
                  : openAdvances.length === 0
                    ? "No open advance. Give one on Accounting → Advances first."
                    : "Money already given to a staff member in advance."}
              </p>
            </FormField>
          )}

          {/* Bank/UPI/card/cheque → which bank account did the money leave from? */}
          {paid && !reimburse && watch("payment_method") !== "cash" && watch("payment_method") !== "statutory" && watch("payment_method") !== EMPLOYEE_ADVANCE_METHOD && bankOnlyAccounts.length > 0 && (
            <FormField label="From which account?" htmlFor="bank_account">
              <Select value={bankAccountId || "none"} onValueChange={(v) => setBankAccountId(v === "none" ? "" : v)}>
                <SelectTrigger id="bank_account"><SelectValue placeholder="Select bank account" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not sure / pick later</SelectItem>
                  {bankOnlyAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}{a.bank_name ? ` · ${a.bank_name}` : ""}{a.account_number_last4 ? ` ••${a.account_number_last4}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-ink-3 mt-1">Kis bank se paisa gaya. Banking me isi account ki statement line se reconcile ho jayega.</p>
            </FormField>
          )}

          {paid && !reimburse && !isEdit && watch("payment_method") === "cash" && cashAccounts.length > 0 && (
            <FormField label="Paid from petty cash" htmlFor="petty_cash">
              <Select value={pettyCashAccountId || "none"} onValueChange={(v) => setPettyCashAccountId(v === "none" ? "" : v)}>
                <SelectTrigger id="petty_cash"><SelectValue placeholder="Don't deduct from petty cash" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Don&apos;t deduct from petty cash</SelectItem>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-ink-3 mt-1">Cash-in-hand se ye amount minus ho jayega.</p>
            </FormField>
          )}

          {/* ── Who — vendor / payee (optional; lives at the end since it's the
              last thing you fill after the money details). GSTIN for GST bills. ── */}
          <FormField
            label={isCommission ? "Kisko diya (commission paane wala)" : isGstBill ? "Vendor (GST invoice)" : "Paid to (optional)"}
            required={isCommission}
            htmlFor="vendor_name"
          >
            <div className="relative">
              <Input
                id="vendor_name"
                autoComplete="off"
                placeholder={isCommission ? "e.g. Ramesh Kumar" : "e.g. Anthropic / Airtel / Office Landlord"}
                {...register("vendor_name", { onChange: () => { setVendorId(null); setVendorMatch(null); setVendorOpen(true); } })}
                onFocus={() => setVendorOpen(true)}
                onBlur={() => setTimeout(() => setVendorOpen(false), 130)}
              />
              {vendorOpen && ((vendors ?? []).length > 0 || (isCommission && (employeeList ?? []).length > 0)) && (() => {
                const query = (watch("vendor_name") || "").trim().toLowerCase();
                const matches = (vendors ?? []).filter((v) => !query || v.name.toLowerCase().includes(query)).slice(0, 8);
                /* For a commission, our own employees are offered too — tagged, so "abhish" already
                   shows "Abhishek · Employee" and the warning below is one click away, not a
                   fully-typed name away. */
                const empMatches = isCommission
                  ? (employeeList ?? []).filter((e) => e.is_active !== false && (!query || e.name.toLowerCase().includes(query))).slice(0, 6)
                  : [];
                if (matches.length === 0 && empMatches.length === 0) return null;
                return (
                  <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
                    {empMatches.map((e) => (
                      <button key={`emp-${e.id}`} type="button"
                        onMouseDown={(ev) => { ev.preventDefault(); setValue("vendor_name", e.name); setVendorId(null); setVendorMatch(null); setVendorOpen(false); }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2">
                        <span className="text-ink truncate">{e.name}</span>
                        <span className="shrink-0 rounded bg-rose/10 px-1.5 py-0.5 text-3xs font-semibold text-rose">Employee · Payroll</span>
                      </button>
                    ))}
                    {matches.map((v) => (
                      <button key={v.id} type="button"
                        onMouseDown={(e) => { e.preventDefault(); setValue("vendor_name", v.name); setVendorId(v.id); setVendorMatch({ kind: "existing", name: v.name }); setVendorOpen(false); }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2">
                        <span className="text-ink truncate">{v.name}</span>
                        {v.gstin && <span className="text-xs text-ink-3 font-mono shrink-0">{v.gstin}</span>}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            {vendorMatch && (
              vendorMatch.kind === "existing" ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-emerald">
                  <Icon name="check_circle" size={12} /> Existing vendor mil gaya{aiGstin ? " (GSTIN se)" : ""} — isi se link hoga.
                </p>
              ) : isGstBill ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-ink">
                  <Icon name="plus" size={12} /> Naya vendor &ldquo;{vendorMatch.name}&rdquo;{aiGstin ? ` (GSTIN ${aiGstin})` : ""} — Save par Vendors master me add hoga.
                </p>
              ) : (
                <p className="mt-1 text-xs text-ink-3">Naya payee — kaccha/no-bill hone se Vendors master me add nahi hoga.</p>
              )
            )}
            {/* The payee is one of OUR employees: their commission is salary (incentive, TDS 192),
                not an agent's commission (194H) — a ₹5L "commission to abhishek" was booked here
                on 26 Sep 2026 and had to be moved to Payroll. */}
            {isCommission && payeeEmployee && (
              <div className="mt-1.5 rounded-md border border-rose/40 bg-rose/5 px-2.5 py-2 text-xs text-ink-2 space-y-1">
                <p>
                  <b>{payeeEmployee.name}</b> aapka employee hai. Employee ka commission / incentive <b>salary</b> ka hissa hai —
                  Payroll mein uski salary ke saath &quot;Incentive&quot; mein daalo (TDS 192, Form 16 mein aayega). Yahan agent ki tarah
                  (194H) book karne se TDS aur Form 16 dono galat honge.
                </p>
                <button type="button" onClick={() => { onClose(); router.push("/accounting/payroll" as never); }}
                  className="font-semibold text-rose underline underline-offset-2">
                  Payroll mein incentive daalo →
                </button>
              </div>
            )}
            {/* One person's commission for the year, and s.194H — lib/accounting/commission-tds.ts. */}
            {isCommission && commissionView && !payeeEmployee && (
              <div className="mt-1.5 rounded-md border border-hairline bg-paper-2/40 px-2.5 py-2 text-xs text-ink-2 space-y-1">
                <p>
                  Is FY mein <b>{vendorNameWatch.trim()}</b> ko ab tak <b>{rupee(commissionView.earlier)}</b> commission ·
                  is entry ke saath <b>{rupee(commissionView.yearTotal)}</b>
                  {" "}({commissionView.crosses ? "₹20,000 ki seema paar" : `₹20,000 ki seema tak ${rupee(Math.max(0, TDS_194H_THRESHOLD - commissionView.yearTotal))} baaki`}).
                </p>
                {commissionView.crosses && (watch("tds_section") || "") !== "194H" && (
                  <div className="flex flex-wrap items-center gap-2 text-amber-ink">
                    <span>194H TDS (2%) katna chahiye{commissionView.earlierUntaxed > 0 ? ` — pehle ke ${rupee(commissionView.earlierUntaxed)} par bhi` : ""}.</span>
                    <button
                      type="button"
                      onClick={() => { setValue("tds_section", "194H"); setValue("tds_amount", commissionView.tdsOnThis); }}
                      className="font-semibold underline underline-offset-2"
                    >
                      194H · {rupee(commissionView.tdsOnThis)} lagao
                    </button>
                  </div>
                )}
                <p className="text-xs text-ink-3">Seema ek vyakti ko poore saal ke commission par lagti hai. Bhugtaan se pehle CA se confirm kar lena.</p>
              </div>
            )}
          </FormField>

          {/* Bill no — only a GST invoice has a number worth tracking (dedup). */}
          {isGstBill && (
            <FormField label="Bill / invoice no. (optional)" htmlFor="bill_no">
              <Input id="bill_no" placeholder="e.g. INV-2026-0042" value={billNo} onChange={(e) => setBillNo(e.target.value)} />
              <p className="text-xs text-ink-3 mt-1">
                Ek hi invoice mein alag-alag category ka saaman? Har category ki <b>alag entry</b> banao — <b>same bill no.</b> daalo. Wo ek hi invoice ke hisse maane jayenge (duplicate warning nahi aayegi).
              </p>
            </FormField>
          )}

          {/* Comment — longer free-text detail about this expense. */}
          <FormField label="Comment (optional)" htmlFor="notes">
            <Textarea
              id="notes"
              rows={2}
              placeholder="e.g. Ranjeet ka birthday gift — company ne Prateek ke a/c me bheja, Prateek ne cash Ranjeet ko diya"
              {...register("notes")}
            />
            <p className="text-xs text-ink-3 mt-1">Koi bhi extra detail — kis liye, kiske through, koi note. Report/detail me dikhega.</p>
          </FormField>

          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting}>{isEdit ? "Save changes" : "Save expense"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
