"use client";

/**
 * Google bill check (R-164, 5 Oct 2026). Upload (or paste) Google's monthly Workspace invoice (the one Google
 * sends Net2Secure for Anutech's domains) and see, domain by domain, who the customer is, what
 * Google charged, what we bill, and where money leaks. The bill is not saved; Add / Add all missing
 * create the customer + Google subscription (components/features/reconcile/add-from-bill.tsx).
 * The pure rules and their tests: lib/reconcile/google-bill.ts.
 */
import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { downloadCSV } from "@/lib/csv";
import { toast } from "sonner";
import { rupee } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useConfirm } from "@/components/providers/confirm-provider";
import { AddFromBillDialog, createFromBill } from "@/components/features/reconcile/add-from-bill";
import { parseGoogleBill, checkBill, expectedPartnerBill, nameFromDomain, type SubLite, type CustomerLite, type RowStatus, type CheckRow } from "@/lib/reconcile/google-bill";

const inr = (n: number) => rupee(n, { decimals: 2 });
const STATUS: Record<RowStatus, { label: string; kind: "danger" | "warning" | "success" | "info" }> = {
  no_customer: { label: "No customer", kind: "danger" },
  no_subscription: { label: "No subscription", kind: "danger" },
  needs_setup: { label: "Set price & users", kind: "info" },
  loss: { label: "Below cost", kind: "warning" },
  ok: { label: "OK", kind: "success" },
};

/**
 * Text of a PDF, one line per row as it reads on the page (5 Oct 2026, Pardeep: "pdf file upload
 * ka option do"). Items on the same baseline are joined left to right — the domain table comes
 * out as "accesstel.in C04e9zwp8 529.20", which is what parseGoogleBill reads. Same pdfjs set-up
 * as the document viewer; nothing leaves the browser.
 */
async function pdfToText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (!it.str || !it.transform) continue;
      const y = Math.round(it.transform[5]);
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out += rows.get(y)!.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim() + "\n";
    }
  }
  return out;
}

function useBooks() {
  return useQuery({
    queryKey: ["google-bill-check", "books"],
    queryFn: async () => {
      const supabase = createClient();
      const [subs, custs] = await Promise.all([
        supabase.from("subscriptions").select("id, customer_id, customer_name, domain, vendor, status, seats, vendor_seats, mrr, plan").eq("vendor", "google").limit(5000),
        supabase.from("customers").select("id, name, domain").not("domain", "is", null).limit(10000),
      ]);
      if (subs.error) throw new Error(subs.error.message);
      if (custs.error) throw new Error(custs.error.message);
      return { subs: (subs.data ?? []) as SubLite[], customers: (custs.data ?? []) as CustomerLite[] };
    },
    staleTime: 60_000,
  });
}

export default function GoogleBillCheckPage() {
  const books = useBooks();
  const qc = useQueryClient();
  const { data: me } = useCurrentUser();
  const confirm = useConfirm();
  const canAdd = !!me?.role && ["owner", "manager", "billing", "accountant"].includes(me.role);
  const [addRow, setAddRow] = React.useState<CheckRow | null>(null);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const refreshBooks = () => { void qc.invalidateQueries({ queryKey: ["google-bill-check", "books"] }); void qc.invalidateQueries({ queryKey: ["subscriptions"] }); void qc.invalidateQueries({ queryKey: ["customers"] }); };
  const [text, setText] = React.useState("");
  const [partnerBill, setPartnerBill] = React.useState("");
  const [perSeatYear, setPerSeatYear] = React.useState("10");
  /** null = use the subscription seat count; a typed number overrides it. */
  const [seatsInput, setSeatsInput] = React.useState<string | null>(null);
  const [showOk, setShowOk] = React.useState(false);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function loadFile(f: File | undefined | null) {
    if (!f) return;
    setReadError(null);
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    if (!isPdf && !/\.(txt|csv)$/i.test(f.name)) { setReadError("Choose the Google invoice PDF."); return; }
    setReading(true);
    try {
      setText(isPdf ? await pdfToText(f) : await f.text());
      setFileName(f.name);
    } catch {
      setReadError("Could not read this PDF. If it is password-protected, open it and paste the text instead.");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const bill = React.useMemo(() => (text.trim() ? parseGoogleBill(text) : null), [text]);
  const check = React.useMemo(() => (bill && bill.lines.length && books.data ? checkBill(bill.lines, books.data.subs, books.data.customers) : null), [bill, books.data]);
  const subtotal = bill?.subtotal ?? bill?.linesTotal ?? 0;
  const seats = seatsInput !== null && seatsInput.trim() !== "" ? Math.max(0, Math.round(Number(seatsInput) || 0)) : (check?.totals.seats ?? 0);
  const partner = check ? expectedPartnerBill(subtotal, seats, Number(perSeatYear) || 0) : null;
  const partnerGap = partner && partnerBill.trim() ? Math.round((Number(partnerBill.replace(/[₹,\s]/g, "")) - partner.expected) * 100) / 100 : null;
  const linesOff = bill && bill.subtotal !== null ? Math.round((bill.linesTotal - bill.subtotal) * 100) / 100 : 0;

  const visibleRows = check ? check.rows.filter((r) => showOk || r.status !== "ok") : [];
  const usersLabel = (n: number) => `${n} user${n === 1 ? "" : "s"}`;
  // A subscription with no price yet has no margin to show — "−₹529" there would read as a loss.
  const marginText = (r: CheckRow) => (r.status === "needs_setup" ? "—" : inr(r.margin));
  const marginClass = (r: CheckRow) => (r.status === "needs_setup" ? "text-ink-3" : r.margin < 0 ? "text-rose" : "text-emerald");
  const RowAction = ({ r }: { r: CheckRow }) => {
    if (canAdd && r.status === "no_customer") return <div className="mt-2 md:mt-0"><Button size="sm" variant="outline" onClick={() => setAddRow(r)}>Add</Button></div>;
    if (canAdd && r.status === "no_subscription") return <div className="mt-2 md:mt-0"><Button size="sm" variant="outline" onClick={() => setAddRow(r)}>Add subscription</Button></div>;
    if (r.status === "needs_setup" && r.customerRef) return <div className="mt-2 md:mt-0"><Link href={`/customers/${r.customerRef}` as never} className="text-xs font-semibold text-primary hover:underline">Set price &amp; users →</Link></div>;
    return null;
  };

  async function addAllMissing() {
    if (!check || !me?.tenantId) return;
    const missing = check.rows.filter((r) => r.status === "no_customer");
    const ok = await confirm({
      title: `Add ${missing.length} customers and subscriptions?`,
      body: `One customer per domain (named after it — rename later) and a Google subscription with this month's Google cost saved as the cost price.\nUsers (1) and your selling price are not on Google's bill, so they are left for you: each row will show "Set price & users".
Their state is not on the bill either — they appear in Customers → "State missing" until you pick it (a GST invoice needs it).`,
      confirmLabel: `Add ${missing.length}`,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const res = await createFromBill(me.tenantId, missing.map((r) => ({
        domain: r.domain, googleCost: r.googleCost, customerName: nameFromDomain(r.domain), plan: "Google Workspace", users: 1, sellPerUserMonth: null,
      })));
      toast.success(`Added ${res.customers} customers and ${res.subscriptions} subscriptions`, { description: "Set users and price on each — the rows now say 'Set price & users'. Pick each customer's state in Customers → 'State missing' before invoicing." });
      refreshBooks();
    } catch (e) {
      toast.error((e as Error).message, { description: "Some rows may have been added. Refresh — the list shows what is still missing." });
      refreshBooks();
    } finally {
      setBulkBusy(false);
    }
  }

  function exportCsv() {
    if (!check) return;
    downloadCSV(`google-bill-check-${bill?.invoiceNo ?? "invoice"}.csv`,
      ["Domain", "Google customer ID", "Customer", "Status", "Google cost (₹)", "We bill /month (₹)", "Margin (₹)", "Seats", "Plans"],
      check.rows.map((r) => [r.domain, r.customerId, r.customerName ?? "", STATUS[r.status].label, r.googleCost, r.ourMonthly, r.margin, r.seats, r.plans.join(" + ")]));
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto">
      <div className="mb-5">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Google bill check</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-2xl">
          Upload Google&apos;s monthly Workspace invoice PDF. Every domain is matched to a customer, so you see what Google charged, what you bill, and where money leaks. The bill itself is not saved; Add creates the missing customer and subscription.
        </p>
      </div>

      <Card className="p-4 mb-5 space-y-3">
        <input ref={fileRef} type="file" accept="application/pdf,.pdf,.txt,.csv" className="hidden" onChange={(e) => void loadFile(e.target.files?.[0])} />
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void loadFile(e.dataTransfer.files?.[0]); }}
          className={`rounded-xl border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${dragging ? "border-primary bg-primary-soft/30" : "border-hairline hover:border-primary/50 hover:bg-paper-2"}`}
        >
          <Icon name="upload" size={22} className="mx-auto text-ink-3" />
          <div className="text-sm font-semibold text-ink mt-1.5">{reading ? "Reading the PDF…" : fileName ? `${fileName} — choose another` : "Upload Google's invoice PDF"}</div>
          <div className="text-xs text-ink-3 mt-0.5">Drop it here or click to choose. It is read in your browser — nothing is uploaded or saved.</div>
        </div>
        {readError && <p className="text-xs text-rose">{readError}</p>}
        <details className="text-xs text-ink-3" open={!!text && !fileName}>
          <summary className="cursor-pointer">Or paste the text (PDF → Ctrl + A → Ctrl + C)</summary>
        <textarea id="gbc-text" aria-label="Google invoice text" value={text} onChange={(e) => { setText(e.target.value); setFileName(null); }} rows={6}
          placeholder={"Invoice number: 5702996051\n…\naccesstel.in C04e9zwp8 529.20\n…"}
          className="mt-2 w-full rounded-lg border border-hairline bg-paper p-3 text-xs font-mono text-ink focus:outline-none focus:ring-2 focus:ring-primary" />
        </details>
        {bill && (
          <div className="text-xs text-ink-2 flex flex-wrap gap-x-4 gap-y-1">
            <span>Invoice <b>{bill.invoiceNo ?? "—"}</b></span>
            <span>{bill.periodLabel ?? "period not found"}</span>
            <span><b>{bill.lines.length}</b> domains read</span>
            {bill.subtotal !== null && <span>Subtotal {inr(bill.subtotal)} · GST {inr(bill.gst ?? 0)} · Total {inr(bill.total ?? 0)}</span>}
            {bill.subtotal !== null && Math.abs(linesOff) > 0.05 && (
              <span className="text-rose font-semibold">Domain lines add up to {inr(bill.linesTotal)} — {inr(Math.abs(linesOff))} {linesOff < 0 ? "missing (a page not pasted?)" : "extra"}</span>
            )}
            {bill.unread.length > 0 && <span className="text-amber-ink">{bill.unread.length} line(s) not read: {bill.unread.slice(0, 2).join(" · ")}</span>}
          </div>
        )}
      </Card>

      {bill && bill.lines.length === 0 && (
        <Card className="p-3 mb-4 text-sm text-amber-ink">
          No domain lines found. Paste the whole PDF (Ctrl + A in the PDF first) — the lines look like
          <span className="font-mono"> accesstel.in C04e9zwp8 529.20</span>.
        </Card>
      )}

      {books.isError && <Card className="p-3 mb-4 text-sm text-rose">Could not load subscriptions: {(books.error as Error).message}</Card>}

      {check && partner && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Tile label="Google charged" value={inr(check.totals.googleCost)} note={`${bill!.lines.length} domains`} />
            <Tile label="You bill these domains" value={inr(check.totals.ourMonthly)} note="per month, from subscriptions" />
            <Tile label="Margin" value={inr(check.totals.margin)} tone={check.totals.margin < 0 ? "rose" : "emerald"} note={`${check.totals.lossCount} below cost`} />
            <Tile label="Leakage" value={inr(check.totals.leakage)} tone={check.totals.leakage > 0 ? "rose" : undefined} note={`${check.totals.leakageCount} domains with no billing`} />
          </div>

          <Card className="p-4 mb-5">
            <div className="text-sm font-semibold text-ink mb-2">Net2Secure bill check</div>
            <div className="flex flex-wrap items-end gap-4 text-sm">
              <label className="flex flex-col gap-1 text-xs text-ink-3">Margin per user per year (₹)
                <input value={perSeatYear} onChange={(e) => setPerSeatYear(e.target.value)} inputMode="decimal" className="w-28 rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink" />
              </label>
              {/* Seats: the PDF has none, so the default is OUR seat count on the domains that
                  matched — 0 when nothing matched (staging, or customers not set up). Editable, so the
                  number on Net2Secure's bill can be checked as-is (5 Oct 2026, "0 seats kyo"). */}
              <label className="flex flex-col gap-1 text-xs text-ink-3">Users (seats)
                <input value={seatsInput ?? String(check.totals.seats)} onChange={(e) => setSeatsInput(e.target.value.trim() === "" ? null : e.target.value)} inputMode="numeric"
                  className={`w-28 rounded-md border bg-paper px-2 py-1.5 text-sm text-ink ${seats === 0 ? "border-amber" : "border-hairline"}`} />
              </label>
              <div className="text-xs text-ink-3">
                Expected = Google subtotal {inr(subtotal)} + {seats} users × ₹{perSeatYear || 0} ÷ 12 ({inr(partner.margin)})
                <div className="text-base font-semibold text-ink mt-0.5">{inr(partner.expected)} + GST</div>
              </div>
              <label className="flex flex-col gap-1 text-xs text-ink-3">Net2Secure billed (before GST)
                <input value={partnerBill} onChange={(e) => setPartnerBill(e.target.value)} inputMode="decimal" placeholder="e.g. 563110.28" className="w-40 rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink" />
              </label>
              {partnerGap !== null && (
                <Badge kind={Math.abs(partnerGap) <= 1 ? "success" : partnerGap > 0 ? "danger" : "info"}>
                  {Math.abs(partnerGap) <= 1 ? "Matches" : partnerGap > 0 ? `Billed ${inr(partnerGap)} more than expected` : `Billed ${inr(-partnerGap)} less than expected`}
                </Badge>
              )}
            </div>
            <p className={`text-2xs mt-2 ${seats === 0 ? "text-amber-ink font-semibold" : "text-ink-3"}`}>
              {seats === 0
                ? `Users is 0: none of the ${bill!.lines.length} domains matched a Google subscription in ResellerOS, so no margin is added. Type the user count from Net2Secure's bill, or set up the customers' subscriptions.`
                : seatsInput !== null
                  ? "Using the users you typed. Clear the box to go back to your subscription count."
                  : `Users = your subscription seats on the ${check.rows.filter((r) => r.seats > 0).length} matched domains (Google's PDF has no seat counts). Ask Net2Secure for Google's invoice CSV for an exact per-user check.`}
            </p>
          </Card>

          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-ink">By domain</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowOk((v) => !v)}>{showOk ? "Hide OK rows" : `Show OK rows (${check.rows.filter((r) => r.status === "ok").length})`}</Button>
              {canAdd && check.rows.some((r) => r.status === "no_customer") && (
                <Button size="sm" variant="primary" icon="plus" loading={bulkBusy} onClick={() => void addAllMissing()}>
                  Add all missing ({check.rows.filter((r) => r.status === "no_customer").length})
                </Button>
              )}
              <Button size="sm" variant="outline" icon="download" onClick={exportCsv}>Download CSV</Button>
            </div>
          </div>
          {/* Phone: one card per domain — the 7-column table was clipped at 375px (5 Oct 2026). */}
          <ul className="md:hidden space-y-2 mb-6">
            {visibleRows.map((r) => (
              <li key={r.domain + r.customerId}>
                <Card className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-ink truncate">{r.domain}</div>
                      <div className="text-2xs text-ink-3 truncate">
                        {r.customerRef ? <Link href={`/customers/${r.customerRef}` as never} className="hover:underline">{r.customerName}</Link> : "No customer yet"}
                        {r.plans.length > 0 && ` · ${r.plans.join(" + ")} · ${usersLabel(r.seats)}`}
                      </div>
                    </div>
                    <Badge size="sm" kind={STATUS[r.status].kind} className="shrink-0">{STATUS[r.status].label}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                    <div><div className="text-ink-3">Google</div><div className="tabular-nums font-medium">{inr(r.googleCost)}</div></div>
                    <div><div className="text-ink-3">You bill</div><div className="tabular-nums font-medium">{r.ourMonthly ? inr(r.ourMonthly) : "—"}</div></div>
                    <div><div className="text-ink-3">Margin</div><div className={`tabular-nums font-semibold ${marginClass(r)}`}>{marginText(r)}</div></div>
                  </div>
                  <RowAction r={r} />
                </Card>
              </li>
            ))}
          </ul>
          <Card className="hidden md:block overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-3 text-left">
                <tr className="border-b border-hairline">
                  <th className="px-3 py-2 font-semibold">Domain</th><th className="px-3 py-2 font-semibold">Customer</th><th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold text-right">Google</th><th className="px-3 py-2 font-semibold text-right">You bill</th><th className="px-3 py-2 font-semibold text-right">Margin</th><th className="px-3 py-2"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {visibleRows.map((r) => (
                  <tr key={r.domain + r.customerId}>
                    <td className="px-3 py-2"><div className="font-medium text-ink">{r.domain}</div><div className="text-2xs text-ink-3 font-mono">{r.customerId}</div></td>
                    <td className="px-3 py-2">
                      {r.customerRef ? <Link href={`/customers/${r.customerRef}` as never} className="text-ink hover:underline">{r.customerName}</Link> : <span className="text-ink-3">—</span>}
                      {r.plans.length > 0 && <div className="text-2xs text-ink-3">{r.plans.join(" + ")} · {usersLabel(r.seats)}</div>}
                    </td>
                    <td className="px-3 py-2"><Badge size="sm" kind={STATUS[r.status].kind}>{STATUS[r.status].label}</Badge></td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(r.googleCost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.ourMonthly ? inr(r.ourMonthly) : "—"}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${marginClass(r)}`}>{marginText(r)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap"><RowAction r={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {check.notOnBill.length > 0 && (
            <>
              <h2 className="text-sm font-semibold text-ink mb-1">You bill these, but Google did not charge them</h2>
              <p className="text-xs text-ink-3 mb-2">Moved to another reseller, suspended, or the domain in ResellerOS is spelt differently. Check each.</p>
              <Card className="mb-8">
                <ul className="divide-y divide-hairline text-sm">
                  {check.notOnBill.map((n) => (
                    <li key={n.domain} className="flex items-center gap-3 px-3 py-2">
                      <Icon name="alert" size={14} className="text-amber-ink shrink-0" />
                      <span className="flex-1 min-w-0 truncate"><b>{n.customerName}</b> · {n.domain}</span>
                      <span className="text-xs text-ink-3">{n.seats} seats</span>
                      <span className="tabular-nums">{inr(n.ourMonthly)}/mo</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </>
      )}
      {addRow && me?.tenantId && books.data && (
        <AddFromBillDialog row={addRow} customers={books.data.customers} tenantId={me.tenantId} onClose={() => setAddRow(null)} onDone={refreshBooks} />
      )}
    </div>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "rose" | "emerald" }) {
  return (
    <Card className="p-3">
      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`text-xl font-semibold tabular-nums mt-0.5 ${tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink"}`}>{value}</div>
      {note && <div className="text-2xs text-ink-3 mt-0.5">{note}</div>}
    </Card>
  );
}
