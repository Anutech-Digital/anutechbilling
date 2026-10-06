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
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { BILL_STATUSES } from "@/lib/navigation/drilldown";

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
import { InboundBillsQueue } from "@/components/features/accounting/inbound-bills-queue";
import { BillDetailDialog } from "@/components/features/accounting/bill-detail-dialog";
import { DocViewerDialog } from "@/components/features/documents/doc-viewer-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { istToday, fyBounds } from "@/lib/dates/ist";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { BILL_SORT, billOutstanding, filterBills, readBillsView, type BillStatusFilter } from "./bills-table";

/** Current financial year (Apr 1 → today), IST-safe, in YYYY-MM-DD. Defaulting
 *  to the FY (not just this month) so a freshly-added bill dated in an earlier
 *  month still shows — "this month" silently hid past-dated bills. */
function thisFYRange(): { from: string; to: string } {
  return { from: fyBounds().start, to: istToday() };
}

const STATUS_COLOR: Record<string, "rose" | "emerald" | "amber" | "slate"> = {
  unpaid:  "rose",
  paid:    "emerald",
  partial: "amber",
};

export default function VendorBillsPage() {
  /* R-287: date range + search live in the URL (useUrlState) like status already did, so
     Back / reload / a shared link keeps the same filtered list. */
  const fy = React.useMemo(() => thisFYRange(), []);
  const [from, setFrom] = useUrlState("from", fy.from);
  const [to, setTo]     = useUrlState("to", fy.to);
  const range = React.useMemo(() => ({ from, to }), [from, to]);
  /* R-118: in the URL, so the Outstanding tile (and a link) can open the owed bills. */
  const [statusFilter, setStatusFilter] = useUrlChoice<BillStatusFilter>("status", BILL_STATUSES, "");
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

  const bills    = React.useMemo(() => billsQ.data ?? [], [billsQ.data]);
  const isLoading = billsQ.isLoading;
  const totals   = totalsQ.data;

  /* R-214: search runs here; sort, count and Load more come from DataTable. */
  const [search, setSearch] = useUrlState("q");
  const shownBills = React.useMemo(() => filterBills(bills, search), [bills, search]);
  const viewState = React.useMemo(
    () => ({ from: range.from, to: range.to, status: statusFilter, q: search.trim() }),
    [range, statusFilter, search],
  );
  const deleteBill = React.useCallback(async (b: VendorBill) => {
    if (await confirm({ title: `Delete bill ${b.bill_no || b.id}?`, danger: true, confirmLabel: "Delete" })) del.mutate(b.id);
  }, [confirm, del]);

  const columns = React.useMemo<DataTableColumn<VendorBill>[]>(() => [
    { id: "vendor", header: "Vendor", width: "30%", sortValue: BILL_SORT.vendor, cell: (b) => <VendorCell bill={b} /> },
    {
      id: "bill_no", header: "Bill #", width: "14%", sortValue: BILL_SORT.bill_no,
      cell: (b) => <div className="font-mono text-xs text-ink-2 truncate" title={b.bill_no || undefined}>{b.bill_no || "—"}</div>,
    },
    { id: "date", header: "Date", width: "13%", sortValue: BILL_SORT.date, cell: (b) => <DateCell bill={b} /> },
    { id: "amount", header: "Amount", width: "15%", align: "right", sortValue: BILL_SORT.amount, cell: (b) => <AmountCell bill={b} /> },
    {
      id: "status", header: "Status", width: "11%", sortValue: BILL_SORT.status,
      cell: (b) => <Badge color={STATUS_COLOR[b.status] ?? "slate"}>{b.status}</Badge>,
    },
    {
      id: "actions", header: <span className="sr-only">Actions</span>, width: "17%", align: "right",
      cell: (b) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          <BillActions bill={b} onPay={() => setPayBill(b)} onDelete={() => void deleteBill(b)} />
        </div>
      ),
    },
  ], [deleteBill]);

  const toolbar = (
    <>
      <Input
        type="search"
        aria-label="Search bills"
        placeholder="Vendor, bill #, GSTIN…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full sm:w-56"
      />
      <label htmlFor="bills-from" className="text-xs text-ink-3 font-semibold uppercase tracking-wide">From</label>
      <input id="bills-from"
        type="date"
        value={range.from}
        onChange={(e) => setFrom(e.target.value)}
        className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
      />
      <label htmlFor="bills-to" className="text-xs text-ink-3 font-semibold uppercase tracking-wide">To</label>
      <input id="bills-to"
        type="date"
        value={range.to}
        onChange={(e) => setTo(e.target.value)}
        className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
      />
      <select aria-label="Status filter"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as BillStatusFilter)}
        className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
      >
        <option value="">All statuses</option>
        <option value="owed">Owed (unpaid + partial)</option>
        <option value="unpaid">Unpaid</option>
        <option value="partial">Partial</option>
        <option value="paid">Paid</option>
      </select>
    </>
  );

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

      {/* Bills that arrived at billing@ and have not been posted yet. Above the
          KPIs deliberately: the numbers below do NOT include these, and an
          operator reading "outstanding" should see what is still waiting to be
          counted before they trust the figure. Renders nothing when empty. */}
      <InboundBillsQueue />

      {/* ── KPI strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4 mb-6">
        <KPI label="Bills (this FY)" value={totals ? String(totals.count) : "—"} onClick={() => setStatusFilter("")} />
        <KPI label="Total amount"       value={totals ? rupee(totals.total) : "—"} onClick={() => setStatusFilter("")} />
        <KPI label="Outstanding"        value={totals ? rupee(totals.outstanding) : "—"}
             tone={totals && totals.outstanding > 0 ? "rose" : undefined}
             onClick={() => setStatusFilter("owed")} active={statusFilter === "owed"} />
        <KPI label="Input GST (claimable)" value={totals ? rupee(totals.inputGst) : "—"} tone="emerald" onClick={() => setStatusFilter("")} />
      </div>

      {/* ── List (R-214: shared DataTable — header sort, search, saved views, Load more) ── */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : billsQ.isError ? (
        <Card className="py-2">
          <EmptyState
            icon="alert"
            title="Couldn't load bills"
            body="Your bills are safe — they just didn't load. Try again."
            action={<Button variant="primary" icon="refresh" onClick={() => billsQ.refetch()}>Try again</Button>}
          />
        </Card>
      ) : (
        <DataTable<VendorBill>
          rows={shownBills}
          totalCount={bills.length}
          noun="bill"
          columns={columns}
          getRowId={(b) => b.id}
          onRowClick={(b) => setDetailBill(b)}
          toolbar={toolbar}
          views={{
            storageKey: "vendor-bills",
            current: viewState,
            apply: (s) => {
              const v = readBillsView(s, viewState);
              setFrom(v.from);
              setTo(v.to);
              setStatusFilter(v.status);
              setSearch(v.q);
            },
          }}
          pageSize={50}
          mobileCard={(b) => (
            <BillCard bill={b} onOpen={() => setDetailBill(b)} onPay={() => setPayBill(b)} onDelete={() => void deleteBill(b)} />
          )}
          empty={
            <Card className="py-2">
              {bills.length > 0 ? (
                <EmptyState
                  icon="search"
                  title="No bills match"
                  body={`Nothing matches "${search.trim()}" in this range.`}
                  action={<Button variant="default" onClick={() => setSearch("")}>Clear search</Button>}
                />
              ) : (
                <EmptyState
                  icon="receipt"
                  title="No bills in this range"
                  body="Add your Google CSP / Microsoft Partner / Zoho bills here so COGS and input GST show up on your P&L and GST reports."
                  action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add your first bill</Button>}
                />
              )}
            </Card>
          }
        />
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


// ─── Table cells (desktop) ──────────────────────────────────────────────────
function billGst(b: VendorBill): number {
  return (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0);
}

/** Vendor — identity + category + items. */
function VendorCell({ bill: b }: { bill: VendorBill }) {
  return (
    <>
      <div className="font-medium text-ink flex items-center gap-2 flex-wrap">
        <span className="truncate">{b.vendor_name}</span>
        {b.source_tenant_invoice_id && (
          <Badge color="indigo" title="Auto-imported from your distributor — created when they invoiced you">From distributor</Badge>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 flex-wrap text-xs text-ink-3">
        {b.vendor_gstin && <span className="font-mono">{b.vendor_gstin}</span>}
        {b.category && <Badge kind="muted" size="sm">{b.category}</Badge>}
        {(b.line_items?.length ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1"><Icon name="file" size={11} />{b.line_items.length} item{b.line_items.length === 1 ? "" : "s"}</span>
        )}
      </div>
    </>
  );
}

/** Date + payment-due aging (unpaid only). */
function DateCell({ bill: b }: { bill: VendorBill }) {
  const dueDays = b.due_date ? Math.ceil((new Date(`${b.due_date}T00:00:00`).getTime() - Date.now()) / 86400000) : null;
  const showAging = b.status !== "paid" && dueDays !== null && (dueDays < 0 || dueDays <= 15);
  return (
    <div className="whitespace-nowrap">
      <div className="text-ink-2">{formatDate(b.bill_date)}</div>
      {b.due_date && <div className="text-xs text-ink-3">due {formatDate(b.due_date)}</div>}
      {showAging && dueDays !== null && (
        <div className="mt-0.5">
          <Badge kind={dueDays < 0 ? "danger" : dueDays <= 7 ? "warning" : "muted"} dot>
            {dueDays < 0 ? `Overdue ${Math.abs(dueDays)}d` : dueDays === 0 ? "Due today" : `Due in ${dueDays}d`}
          </Badge>
        </div>
      )}
    </div>
  );
}

/** Amount — total prominent, GST + foreign + balance as sublines. */
function AmountCell({ bill: b }: { bill: VendorBill }) {
  const gst = billGst(b);
  // GST head breakdown for ITC clarity (inter-state IGST vs intra CGST+SGST).
  const gstTitle = b.igst > 0
    ? `IGST ${rupee(b.igst)}`
    : (b.cgst > 0 || b.sgst > 0)
      ? `CGST ${rupee(b.cgst)} + SGST ${rupee(b.sgst)}`
      : "No GST";
  const fx = foreignAmount(b.currency, b.total, b.fx_rate);
  const due = billOutstanding(b);
  return (
    <div className="whitespace-nowrap">
      <div className="font-semibold text-ink font-mono tabular-nums">{rupee(b.total)}</div>
      {fx && <div className="text-xs font-normal text-ink-3 font-mono">{fx}</div>}
      {gst > 0 && <div className="text-xs text-emerald cursor-help" title={gstTitle}>incl {rupee(gst)} GST</div>}
      {due > 0 && (b.paid_amount ?? 0) > 0 && <div className="text-xs text-rose tabular-nums">{rupee(due)} due</div>}
    </div>
  );
}

// ─── Phone / tablet card ────────────────────────────────────────────────────
function BillCard({ bill: b, onOpen, onPay, onDelete }: { bill: VendorBill; onOpen: () => void; onPay: () => void; onDelete: () => void }) {
  const gst = billGst(b);
  const fx = foreignAmount(b.currency, b.total, b.fx_rate);
  return (
    <Card className="p-4 cursor-pointer" onClick={onOpen}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="font-medium text-ink leading-tight">
          {b.vendor_name}
          {(b.line_items?.length ?? 0) > 0 && <span className="ml-1 text-xs font-normal text-ink-3">· {b.line_items.length} items</span>}
        </div>
        <Badge color={STATUS_COLOR[b.status] ?? "slate"}>{b.status}</Badge>
      </div>
      <div className="text-xs text-ink-3 font-mono mb-2">
        {b.bill_no || "—"} · {formatDate(b.bill_date)}
      </div>
      {b.category && <div className="text-xs text-ink-3 mb-2">{b.category}</div>}
      <div className="flex items-end justify-between">
        <div>
          <div className="font-serif text-xl text-ink leading-none">{rupee(b.total)}</div>
          {fx && <div className="text-xs text-ink-3 mt-1">{fx} @ ₹{b.fx_rate}/{b.currency}</div>}
          {gst > 0 && <div className="text-xs text-emerald mt-1">+{rupee(gst)} input GST</div>}
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <BillActions bill={b} onPay={onPay} onDelete={onDelete} />
        </span>
      </div>
    </Card>
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
  return istToday();
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
            <FormField htmlFor="bills-amount" label="Amount (₹)" required>
              <Input id="bills-amount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </FormField>
            <FormField htmlFor="bills-date" label="Date">
              <Input id="bills-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
          {tooMuch && <p className="text-xs text-rose">Outstanding {rupee(outstanding)} se zyada nahi.</p>}
          <FormField htmlFor="bills-pay-from" label="Pay from">
            <select id="bills-pay-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber">
              {accounts.length === 0 && <option value="">No accounts — add one in Banking</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </FormField>
          <FormField htmlFor="bills-method" label="Method">
            <Input id="bills-method" aria-label="bank transfer / UPI / cash" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="bank transfer / UPI / cash" />
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
  label, value, tone, onClick, active,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose" | "amber";
  /** R-118: opens the bills this figure adds up (the From/To range stays as set). */
  onClick?: () => void;
  active?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : "text-ink";
  const body = (
    <>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-xl md:text-2xl ${colorClass} leading-tight`}>{value}</div>
    </>
  );
  if (!onClick) return <Card className="p-3 md:p-4">{body}</Card>;
  return (
    <button type="button" onClick={onClick} aria-pressed={active ?? undefined}
      className={`text-left rounded-lg border bg-paper p-3 md:p-4 transition-colors hover:border-amber/60 ${active ? "border-amber" : "border-hairline"}`}>
      {body}
    </button>
  );
}
