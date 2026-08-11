/**
 * Vendor Bills — bills RECEIVED from suppliers (Google CSP, MS Partner,
 * Zoho Partner). Source of COGS for the P&L report + input tax credit
 * for GST input reports.
 *
 * Layout
 *   ┌ KPI strip ─────────────────────────────────────────┐
 *   │  This month bills │ Unpaid │ Input GST │ Categories│
 *   ├ Filter strip ──────────────────────────────────────┤
 *   │  Date range · Category filter · Status filter      │
 *   ├ Bills table / mobile cards ────────────────────────┤
 *   │  Vendor · Bill # · Date · Total · Status · Actions │
 *   └────────────────────────────────────────────────────┘
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate, foreignAmount } from "@/lib/utils";
import {
  useVendorBills,
  useVendorBillsTotals,
  useDeleteVendorBill,
  usePayVendorBill,
  getBillAttachmentUrl,
  type VendorBill,
} from "@/lib/queries/vendor-bills";
import { useBankAccounts } from "@/lib/queries/bank";
import { AddVendorBillDialog } from "@/components/features/accounting/add-vendor-bill-dialog";
import { BillDetailDialog } from "@/components/features/accounting/bill-detail-dialog";
import { DocViewerDialog } from "@/components/features/documents/doc-viewer-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";

/** Current financial year (Apr 1 → today), IST-safe, in YYYY-MM-DD. Defaulting
 *  to the FY (not just this month) so a freshly-added bill dated in an earlier
 *  month still shows — "this month" silently hid past-dated bills. */
function thisFYRange(): { from: string; to: string } {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y   = ist.getUTCFullYear();
  const fyStartYear = ist.getUTCMonth() < 3 ? y - 1 : y;   // Apr = month index 3
  return { from: `${fyStartYear}-04-01`, to: ist.toISOString().slice(0, 10) };
}

const STATUS_COLOR: Record<string, "rose" | "emerald" | "amber" | "slate"> = {
  unpaid:  "rose",
  paid:    "emerald",
  partial: "amber",
};

export default function VendorBillsPage() {
  const [range, setRange]   = React.useState(thisFYRange());
  const [statusFilter, setStatusFilter] = React.useState<"" | "unpaid" | "paid" | "partial">("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [payBill, setPayBill] = React.useState<VendorBill | null>(null);
  const [detailBill, setDetailBill] = React.useState<VendorBill | null>(null);

  const billsQ  = useVendorBills({
    from:   range.from,
    to:     range.to,
    status: statusFilter || undefined,
  });
  const totalsQ = useVendorBillsTotals(range);
  const del     = useDeleteVendorBill();
  const confirm = useConfirm();

  const bills    = billsQ.data ?? [];
  const isLoading = billsQ.isLoading;
  const totals   = totalsQ.data;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">COGS Bills</h1>
          <p className="text-sm text-ink-3 mt-1">
            Bills for products you <b>resell</b> — Google CSP, Microsoft Partner, Zoho — your COGS source.
            <span className="block mt-0.5 text-[12px] text-ink-3">Office/overhead bills (stationery, your own software, rent) go in <b>Expenses</b> instead.</span>
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          className="hidden md:inline-flex"
          onClick={() => setAddOpen(true)}
        >
          Add Bill
        </Button>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4 mb-6">
        <KPI label="Bills (this FY)" value={totals ? String(totals.count) : "—"} />
        <KPI label="Total amount"       value={totals ? rupee(totals.total) : "—"} />
        <KPI label="Outstanding"        value={totals ? rupee(totals.outstanding) : "—"}
             tone={totals && totals.outstanding > 0 ? "rose" : undefined} />
        <KPI label="Input GST (claimable)" value={totals ? rupee(totals.inputGst) : "—"} tone="emerald" />
      </div>

      {/* ── Filter strip ────────────────────────────────────────── */}
      <Card className="mb-5 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">From</label>
          <input
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
          />
          <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">To</label>
          <input
            type="date"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
          >
            <option value="">All statuses</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
          </select>
          <div className="ml-auto text-xs text-ink-3">
            Showing {bills.length} {bills.length === 1 ? "bill" : "bills"}
          </div>
        </div>
      </Card>

      {/* ── List ────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : bills.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="receipt"
            title="No bills in this range"
            body="Add your Google CSP / Microsoft Partner / Zoho bills here so COGS and input GST show up on your P&L and GST reports."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add your first bill</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table — 6 tidy columns that fit without horizontal scroll */}
          <Card flush className="hidden md:block overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[14%]" />
                <col className="w-[13%]" />
                <col className="w-[15%]" />
                <col className="w-[11%]" />
                <col className="w-[17%]" />
              </colgroup>
              <thead className="bg-paper-2 border-b border-hairline-strong text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-2.5">Vendor</th>
                  <th className="text-left  px-3 py-2.5">Bill #</th>
                  <th className="text-left  px-3 py-2.5">Date</th>
                  <th className="text-right px-3 py-2.5">Amount</th>
                  <th className="text-left  px-3 py-2.5">Status</th>
                  <th className="text-right px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {bills.map((b) => {
                  const gst = (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0);
                  // GST head breakdown for ITC clarity (inter-state IGST vs intra CGST+SGST).
                  const gstTitle = b.igst > 0
                    ? `IGST ${rupee(b.igst)}`
                    : (b.cgst > 0 || b.sgst > 0)
                      ? `CGST ${rupee(b.cgst)} + SGST ${rupee(b.sgst)}`
                      : "No GST";
                  // Payment-due aging (unpaid only).
                  const dueDays = b.due_date ? Math.ceil((new Date(`${b.due_date}T00:00:00`).getTime() - Date.now()) / 86400000) : null;
                  const showAging = b.status !== "paid" && dueDays !== null && (dueDays < 0 || dueDays <= 15);
                  return (
                    <tr key={b.id} onClick={() => setDetailBill(b)} className="cursor-pointer border-b border-hairline last:border-0 hover:bg-paper-2/50 transition-colors">
                      {/* Vendor — identity + category + items */}
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-ink flex items-center gap-2 flex-wrap">
                          <span className="truncate">{b.vendor_name}</span>
                          {b.source_tenant_invoice_id && (
                            <Badge color="indigo" title="Auto-imported from your distributor — created when they invoiced you">From distributor</Badge>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 flex-wrap text-[11px] text-ink-3">
                          {b.vendor_gstin && <span className="font-mono">{b.vendor_gstin}</span>}
                          {b.category && <Badge kind="muted" size="sm">{b.category}</Badge>}
                          {(b.line_items?.length ?? 0) > 0 && (
                            <span className="inline-flex items-center gap-1"><Icon name="file" size={11} />{b.line_items.length} item{b.line_items.length === 1 ? "" : "s"}</span>
                          )}
                        </div>
                      </td>
                      {/* Bill # */}
                      <td className="px-3 py-3 font-mono text-[11px] text-ink-2 align-top truncate" title={b.bill_no || undefined}>{b.bill_no || "—"}</td>
                      {/* Date + aging */}
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        <div className="text-ink-2">{formatDate(b.bill_date)}</div>
                        {b.due_date && <div className="text-[11px] text-ink-3">due {formatDate(b.due_date)}</div>}
                        {showAging && (
                          <div className="mt-0.5">
                            <Badge kind={dueDays! < 0 ? "danger" : dueDays! <= 7 ? "warning" : "muted"} dot>
                              {dueDays! < 0 ? `Overdue ${Math.abs(dueDays!)}d` : dueDays === 0 ? "Due today" : `Due in ${dueDays}d`}
                            </Badge>
                          </div>
                        )}
                      </td>
                      {/* Amount — total prominent, GST + foreign as sublines */}
                      <td className="px-3 py-3 text-right align-top whitespace-nowrap">
                        <div className="font-semibold text-ink font-mono tabular-nums">{rupee(b.total)}</div>
                        {(() => { const fx = foreignAmount(b.currency, b.total, b.fx_rate); return fx ? <div className="text-[11px] font-normal text-ink-3 font-mono">{fx}</div> : null; })()}
                        {gst > 0 && <div className="text-[11px] text-emerald cursor-help" title={gstTitle}>incl {rupee(gst)} GST</div>}
                        {b.status !== "paid" && (b.total - (b.paid_amount ?? 0)) > 0 && (b.paid_amount ?? 0) > 0 && (
                          <div className="text-[10px] text-rose tabular-nums">{rupee(b.total - (b.paid_amount ?? 0))} due</div>
                        )}
                      </td>
                      {/* Status */}
                      <td className="px-3 py-3 align-top"><Badge color={STATUS_COLOR[b.status] ?? "slate"}>{b.status}</Badge></td>
                      {/* Actions */}
                      <td className="px-2 py-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end">
                          <BillActions
                            bill={b}
                            onPay={() => setPayBill(b)}
                            onDelete={async () => { if (await confirm({ title: `Delete bill ${b.bill_no || b.id}?`, danger: true, confirmLabel: "Delete" })) del.mutate(b.id); }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Mobile card list */}
          <ul className="md:hidden space-y-2.5">
            {bills.map((b) => {
              const gst = (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0);
              return (
                <li key={b.id}>
                  <Card className="p-4 cursor-pointer" onClick={() => setDetailBill(b)}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="font-medium text-ink leading-tight">
                        {b.vendor_name}
                        {(b.line_items?.length ?? 0) > 0 && <span className="ml-1 text-[11px] font-normal text-ink-3">· {b.line_items.length} items</span>}
                      </div>
                      <Badge color={STATUS_COLOR[b.status] ?? "slate"}>{b.status}</Badge>
                    </div>
                    <div className="text-[11px] text-ink-3 font-mono mb-2">
                      {b.bill_no || "—"} · {formatDate(b.bill_date)}
                    </div>
                    <div className="text-xs text-ink-3 mb-2">{b.category}</div>
                    <div className="flex items-end justify-between">
                      <div>
                        <div className="font-serif text-xl text-ink leading-none">{rupee(b.total)}</div>
                        {(() => { const fx = foreignAmount(b.currency, b.total, b.fx_rate); return fx ? <div className="text-[11px] text-ink-3 mt-1">{fx} @ ₹{b.fx_rate}/{b.currency}</div> : null; })()}
                        {gst > 0 && (
                          <div className="text-[11px] text-emerald mt-1">+{rupee(gst)} input GST</div>
                        )}
                      </div>
                      <span onClick={(e) => e.stopPropagation()}>
                        <BillActions
                          bill={b}
                          onPay={() => setPayBill(b)}
                          onDelete={async () => { if (await confirm({ title: `Delete bill ${b.bill_no || b.id}?`, danger: true, confirmLabel: "Delete" })) del.mutate(b.id); }}
                        />
                      </span>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Mobile FAB */}
      <FAB icon="plus" label="Bill" onClick={() => setAddOpen(true)} ariaLabel="Add Bill" />

      {/* Add dialog */}
      {addOpen && <AddVendorBillDialog onClose={() => setAddOpen(false)} />}
      {payBill && <PayBillDialog bill={payBill} onClose={() => setPayBill(null)} />}
      {detailBill && <BillDetailDialog bill={detailBill} onClose={() => setDetailBill(null)} />}
    </div>
  );
}


// ─── Row actions — View bill (attachment) · Record payment · Delete ─────────
function BillActions({ bill, onPay, onDelete }: { bill: VendorBill; onPay: () => void; onDelete: () => void }) {
  // Preview the attached file IN THE APP (DocViewerDialog renders PDFs via
  // pdf.js + images inline) instead of a new browser tab.
  const [viewer, setViewer] = React.useState(false);
  const fileName = bill.attachment_url ? (bill.attachment_url.split("/").pop() ?? "bill") : null;
  const outstanding = bill.total - (bill.paid_amount ?? 0);
  return (
    <div className="flex items-center gap-1.5">
      {bill.status !== "paid" && outstanding > 0 && (
        <Button size="sm" variant="primary" icon="rupee" onClick={onPay}>Pay</Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
            <Icon name="more_h" size={18} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          {bill.attachment_url ? (
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setViewer(true)}>
              <Icon name="file" size={15} /> View bill file
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="gap-2.5 py-2 text-ink-3" disabled>
              <Icon name="file" size={15} /> No file attached
            </DropdownMenuItem>
          )}
          {bill.status !== "paid" && outstanding > 0 && (
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onPay}>
              <Icon name="rupee" size={15} /> Record payment
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onDelete}>
            <Icon name="trash" size={15} /> Delete bill
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {bill.attachment_url && (
        <DocViewerDialog
          open={viewer}
          onOpenChange={setViewer}
          title={`${bill.vendor_name} · ${bill.bill_no || bill.id}`}
          fileName={fileName}
          filePath={bill.attachment_url}
          signer={getBillAttachmentUrl}
        />
      )}
    </div>
  );
}

function todayISO() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ─── Record a payment against a vendor bill ─────────────────────────────────
function PayBillDialog({ bill, onClose }: { bill: VendorBill; onClose: () => void }) {
  const pay = usePayVendorBill();
  const accountsQ = useBankAccounts();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active);
  const outstanding = bill.total - (bill.paid_amount ?? 0);

  const [amount, setAmount] = React.useState(String(outstanding));
  const [date, setDate] = React.useState(todayISO());
  const [accountId, setAccountId] = React.useState("");
  const [method, setMethod] = React.useState("bank transfer");

  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt = Math.round(Number(amount) || 0);
  const tooMuch = amt > outstanding;
  const valid = amt > 0 && !tooMuch && Boolean(accountId);

  const save = async () => {
    if (!valid) return;
    try {
      await pay.mutateAsync({ billId: bill.id, amount: amt, paidOn: date, bankAccountId: accountId, method });
      onClose();
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-sm">
        <DialogHeader>
          <DialogTitle>Pay · {bill.vendor_name}</DialogTitle>
          <DialogDescription>
            Outstanding: <b className="text-ink">{rupee(outstanding)}</b> of {rupee(bill.total)}. This money leaves the chosen bank account (and gets reconciled in Banking).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount (₹)" required>
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </FormField>
            <FormField label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
          {tooMuch && <p className="text-[11px] text-rose">Outstanding {rupee(outstanding)} se zyada nahi.</p>}
          <FormField label="Pay from">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber">
              {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </FormField>
          <FormField label="Method">
            <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="bank transfer / UPI / cash" />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={pay.isPending} disabled={!valid} onClick={save}>
            Pay {amt > 0 && !tooMuch ? rupee(amt) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tiny KPI card ────────────────────────────────────────────────────
function KPI({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose" | "amber";
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-xl md:text-2xl ${colorClass} leading-tight`}>{value}</div>
    </Card>
  );
}
