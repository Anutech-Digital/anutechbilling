/**
 * Vendors — supplier master (Google CSP, Microsoft, Zoho, etc.). Each vendor
 * rolls up its bills (total billed + outstanding), so the buy-side "kisko kitna
 * dena" reads at a glance. Bills still live on /accounting/bills; this is the
 * per-supplier view.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Card } from "@/components/ui/card";
import { StatStrip } from "@/components/shared/stat-strip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FormField } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useVendors, useUpsertVendor, useDeleteVendor, useBillsByVendor, useExpensesByVendor, type Vendor } from "@/lib/queries/vendors";
import type { VendorBill } from "@/lib/queries/vendor-bills";
import { BillDetailDialog } from "@/components/features/accounting/bill-detail-dialog";
import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import type { ExpenseRow } from "@/lib/supabase/database.types";
import { VENDOR_BILL_CATEGORIES } from "@/lib/queries/vendor-bills";
import { rupee, formatDate, GST_STATE_BY_CODE, gstStateFromGstin, foreignAmount, formatForeignAmount } from "@/lib/utils";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";

/** A short country / place-of-supply label from a vendor's GSTIN.
 *  Indian state code → "India · <State>"; OIDAR code 99/96 → "Foreign …"
 *  (with the embedded country code when present, e.g. Anthropic → "Foreign · USA"). */
function vendorRegion(gstin: string | null | undefined): string | null {
  const g = (gstin ?? "").trim().toUpperCase();
  if (!g) return null;
  const { code, name } = gstStateFromGstin(g);
  if (!code) return null;
  if (code === "99" || code === "96") {
    const m = g.match(/^\d{4}([A-Z]{2,3})/);   // OIDAR often embeds a country code
    return m ? `Foreign · ${m[1]}` : "Foreign supplier (OIDAR)";
  }
  return name ? `India · ${name}` : "India";
}

export default function VendorsPage() {
  const router = useRouter();
  const { data: vendors, isLoading } = useVendors();
  const [search, setSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [editVendor, setEditVendor] = React.useState<Vendor | null>(null);
  const [detailVendor, setDetailVendor] = React.useState<Vendor | null>(null);
  const del = useDeleteVendor();
  const confirm = useConfirm();

  const rows = (vendors ?? []).filter((v) =>
    !search.trim() || v.name.toLowerCase().includes(search.toLowerCase()) || (v.gstin ?? "").toLowerCase().includes(search.toLowerCase()));
  const totalOutstanding = (vendors ?? []).reduce((s, v) => s + v.outstanding, 0);
  const totalSpend = (vendors ?? []).reduce((s, v) => s + v.totalSpend, 0);

  const confirmDelete = async (v: Vendor) => {
    if (await confirm({
      title: `Remove vendor "${v.name}"?`,
      body: `Its ${v.billCount} bill(s) stay — they just lose the vendor link (name is kept).`,
      confirmLabel: "Remove",
      danger: true,
    })) {
      del.mutate(v.id);
    }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Vendors</h1>
          <p className="text-sm text-ink-3 mt-1">
            Everyone who invoices you — resale suppliers (Google / Microsoft / Zoho) and expense vendors (software, rent, stationery). Total spend across COGS bills + expenses, all in one place.
          </p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex" onClick={() => setAddOpen(true)}>Add vendor</Button>
      </div>

      {!isLoading && (vendors ?? []).length > 0 && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "Vendors",      value: (vendors ?? []).length },
            { label: "Total spend",  value: rupee(totalSpend, { compact: true }) },
            { label: "Outstanding",  value: rupee(totalOutstanding, { compact: true }), tone: totalOutstanding > 0 ? "rose" : "emerald" },
          ]}
        />
      )}

      {(vendors ?? []).length > 0 && (
        <div className="mb-3 w-full sm:w-72">
          <Input prefix={<Icon name="search" size={14} />} placeholder="Vendor name / GSTIN…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (vendors ?? []).length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="users"
            title="No vendors yet"
            body="Suppliers appear here automatically when you add a bill — or add one now."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add vendor</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card flush className="hidden md:block">
            <table className="w-full text-sm">
              <thead className="bg-paper-2 border-b border-hairline-strong text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-2.5">Vendor</th>
                  <th className="text-left  px-4 py-2.5">Category</th>
                  <th className="text-right px-4 py-2.5">Entries</th>
                  <th className="text-right px-4 py-2.5">Total spend</th>
                  <th className="text-right px-4 py-2.5">Outstanding</th>
                  <th className="text-right px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((v) => (
                  <tr
                    key={v.id}
                    className="group hover:bg-paper-2/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${v.name}`}
                    onClick={() => setDetailVendor(v)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailVendor(v); } }}
                  >
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-medium text-ink leading-snug">{v.name}</div>
                      {v.gstin && <div className="text-[11px] text-ink-3 font-mono">{v.gstin}</div>}
                      {(() => { const r = vendorRegion(v.gstin); return r ? <div className="text-[11px] text-ink-3">{r}</div> : null; })()}
                      {v.contact_email && <div className="text-[11px] text-ink-3 truncate">{v.contact_email}</div>}
                    </td>
                    <td className="px-4 py-2.5 align-top">{v.default_category ? <Badge kind="muted" size="sm">{v.default_category}</Badge> : <span className="text-ink-3">—</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-2 align-top">{v.docCount || "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums align-top">
                      {v.totalSpend > 0 ? rupee(v.totalSpend) : "—"}
                      {v.billCurrency && v.totalBilled > 0 && (
                        <div className="text-[10px] text-ink-3">{formatForeignAmount(v.billCurrency, v.foreignBilled)} COGS</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums align-top">
                      {v.outstanding > 0
                        ? <span className="font-serif text-[15px] font-semibold text-rose">{rupee(v.outstanding)}</span>
                        : <span className="text-emerald">✓</span>}
                      {v.billCurrency && v.outstanding > 0 && (
                        <div className="text-[10px] font-normal text-rose/70">{formatForeignAmount(v.billCurrency, v.foreignOutstanding)}</div>
                      )}
                    </td>
                    <td className="px-2 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end">
                        <VendorActions
                          onView={() => setDetailVendor(v)}
                          onEdit={() => setEditVendor(v)}
                          onDelete={() => confirmDelete(v)}
                          onUploadBill={() => router.push("/accounting/bills" as never)}
                          onRecordPayment={() => router.push("/accounting/bills" as never)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2.5">
            {rows.map((v) => (
              <li key={v.id}>
                <Card className="p-4" onClick={() => setDetailVendor(v)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-ink truncate">{v.name}</div>
                      {v.gstin && <div className="text-[11px] text-ink-3 font-mono truncate">{v.gstin}</div>}
                      {(() => { const r = vendorRegion(v.gstin); return r ? <div className="text-[11px] text-ink-3 truncate">{r}</div> : null; })()}
                      <div className="text-[11px] text-ink-3 mt-0.5">{v.docCount} {v.docCount === 1 ? "entry" : "entries"} · {rupee(v.totalSpend, { compact: true })} spent</div>
                    </div>
                    <div className="text-right shrink-0">
                      {v.outstanding > 0
                        ? <span className="font-serif text-lg text-rose">{rupee(v.outstanding, { compact: true })}</span>
                        : <span className="text-emerald text-sm">✓ clear</span>}
                      {v.billCurrency && v.outstanding > 0 && (
                        <div className="text-[10px] text-rose/70">{formatForeignAmount(v.billCurrency, v.foreignOutstanding)}</div>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <FAB icon="plus" label="Vendor" onClick={() => setAddOpen(true)} ariaLabel="Add vendor" />
      {addOpen && <VendorFormDialog onClose={() => setAddOpen(false)} />}
      {editVendor && <VendorFormDialog vendor={editVendor} onClose={() => setEditVendor(null)} />}
      {detailVendor && <VendorBillsDialog vendor={detailVendor} onClose={() => setDetailVendor(null)} onEdit={() => { setEditVendor(detailVendor); setDetailVendor(null); }} />}
    </div>
  );
}

function VendorActions({ onView, onEdit, onDelete, onUploadBill, onRecordPayment }: {
  onView: () => void; onEdit: () => void; onDelete: () => void;
  onUploadBill: () => void; onRecordPayment: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Vendor actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
          <Icon name="more_h" size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onUploadBill}><Icon name="upload" size={15} /> Upload bill</DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onRecordPayment}><Icon name="rupee" size={15} /> Record payment</DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onView}><Icon name="eye" size={15} /> View ledger</DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onEdit}><Icon name="edit" size={15} /> Edit vendor details</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onDelete}><Icon name="trash" size={15} /> Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VendorFormDialog({ vendor, onClose }: { vendor?: Vendor; onClose: () => void }) {
  const save = useUpsertVendor();
  const [name, setName] = React.useState(vendor?.name ?? "");
  const [gstin, setGstin] = React.useState(vendor?.gstin ?? "");
  const [category, setCategory] = React.useState(vendor?.default_category ?? "");
  const [contactName, setContactName] = React.useState(vendor?.contact_name ?? "");
  const [contactEmail, setContactEmail] = React.useState(vendor?.contact_email ?? "");
  const [contactPhone, setContactPhone] = React.useState(vendor?.contact_phone ?? "");
  const [address, setAddress] = React.useState(vendor?.address ?? "");
  const [city, setCity] = React.useState(vendor?.city ?? "");
  const [state, setState] = React.useState(vendor?.state ?? "");
  const [pincode, setPincode] = React.useState(vendor?.pincode ?? "");
  const [notes, setNotes] = React.useState(vendor?.notes ?? "");

  const STATE_NAMES = React.useMemo(() => Object.values(GST_STATE_BY_CODE).sort(), []);

  // Typing a GSTIN instantly fills the State from its first two digits (the
  // GST state code) — offline, no API. Only auto-fills when State is still
  // blank so a manual pick is never overwritten.
  const onGstinChange = (raw: string) => {
    setGstin(raw);
    const { name: stName } = gstStateFromGstin(raw);
    if (stName) setState((prev) => (prev ? prev : stName));
  };

  // "Fill form from GST" — push verified GSTN details into the vendor fields.
  const fillFromGst = (v: import("@/lib/supabase/database.types").GstinVerification) => {
    if (v.legal_name) setName(v.legal_name);
    if (v.address) setAddress(v.address);
    if (v.principal_address?.city) setCity(v.principal_address.city);
    const stName = (v.state_code && GST_STATE_BY_CODE[v.state_code]) || v.principal_address?.state || null;
    if (stName) setState(stName);
    if (v.principal_address?.pin_code) setPincode(v.principal_address.pin_code);
  };

  const submit = async () => {
    if (!name.trim()) return;
    try {
      await save.mutateAsync({
        id: vendor?.id, name: name.trim(), gstin: gstin || null, defaultCategory: category || null,
        contactName: contactName || null, contactEmail: contactEmail || null, contactPhone: contactPhone || null,
        address: address || null, city: city || null, state: state || null, pincode: pincode || null,
        notes: notes || null,
      });
      onClose();
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>{vendor ? "Edit vendor" : "Add vendor"}</DialogTitle>
          <DialogDescription>Supplier details — these auto-fill when you add a bill.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Vendor name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Google Cloud India" autoFocus />
            </FormField>
            <FormField label="GSTIN (optional)">
              <Input value={gstin} onChange={(e) => onGstinChange(e.target.value)} placeholder="e.g. 27ABCDE1234F1Z5" />
            </FormField>
          </div>
          <GstinVerifyCard gstin={gstin} noPersist onFillForm={fillFromGst} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="Contact name"><Input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="e.g. Rahul Sharma" /></FormField>
            <FormField label="Email"><Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="e.g. name@vendor.com" /></FormField>
            <FormField label="Phone"><Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="e.g. +91 98765 43210" /></FormField>
          </div>
          <FormField label="Address (optional)">
            <Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 4th Floor, Tower B, Cyber City" />
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="City">
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Mumbai" />
            </FormField>
            <FormField label="State (place of supply)">
              <Select value={state || "none"} onValueChange={(v) => setState(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— none —</SelectItem>
                  {STATE_NAMES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="PIN code">
              <Input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="e.g. 400001" />
            </FormField>
          </div>
          <FormField label="Default category">
            <Select value={category || "none"} onValueChange={(v) => setCategory(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {VENDOR_BILL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Reseller portal, account manager" /></FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorBillsDialog({ vendor, onClose, onEdit }: { vendor: Vendor; onClose: () => void; onEdit: () => void }) {
  const { data: bills, isLoading } = useBillsByVendor(vendor.id);
  const { data: vExpenses } = useExpensesByVendor(vendor.id);
  const [detailBill, setDetailBill] = React.useState<VendorBill | null>(null);
  const [detailExpense, setDetailExpense] = React.useState<ExpenseRow | null>(null);

  return (
    <>
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {vendor.name}
            {vendor.gstin && <span className="font-mono text-[11px] text-ink-3">{vendor.gstin}</span>}
            {(() => { const r = vendorRegion(vendor.gstin); return r ? <span className="text-[11px] font-normal text-ink-3 rounded-full bg-paper-2 px-2 py-0.5">{r}</span> : null; })()}
          </DialogTitle>
          <DialogDescription>
            {vendor.docCount} {vendor.docCount === 1 ? "entry" : "entries"} · {rupee(vendor.totalSpend)}
            {vendor.billCurrency ? ` (${formatForeignAmount(vendor.billCurrency, vendor.foreignBilled)})` : ""} spent ·{" "}
            <b className={vendor.outstanding > 0 ? "text-rose" : "text-emerald"}>{vendor.outstanding > 0 ? `${rupee(vendor.outstanding)} due` : "all settled"}</b>
            {vendor.billCount > 0 && vendor.expenseCount > 0 && (
              <span className="text-ink-3"> · {vendor.billCount} COGS bill{vendor.billCount === 1 ? "" : "s"} + {vendor.expenseCount} expense{vendor.expenseCount === 1 ? "" : "s"}</span>
            )}
            {[vendor.address, vendor.city, vendor.state, vendor.pincode].some(Boolean) && (
              <span className="mt-1 block text-[12px] not-italic text-ink-3">
                📍 {[vendor.address, vendor.city, vendor.state, vendor.pincode].filter(Boolean).join(", ")}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1 space-y-4">
          {isLoading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (bills ?? []).length === 0 && (vExpenses ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-3">No bills or expenses for this vendor yet.</p>
          ) : (
          <>
            {(bills ?? []).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1 px-1">COGS bills</p>
            <ul className="divide-y divide-hairline">
              {(bills ?? []).map((b) => {
                const out = Math.max(0, (b.total ?? 0) - (b.paid_amount ?? 0));
                return (
                  <li
                    key={b.id}
                    onClick={() => setDetailBill(b)}
                    className="flex items-center justify-between gap-3 py-2.5 -mx-1 px-1 rounded-md cursor-pointer hover:bg-paper-2/60 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-ink truncate">{b.bill_no || b.id} <span className="text-ink-3">· {b.category}</span>{(b.line_items?.length ?? 0) > 0 && <span className="text-ink-3"> · {b.line_items.length} items</span>}</p>
                      <p className="text-[11px] text-ink-3">{formatDate(b.bill_date)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      {(() => { const fx = foreignAmount(b.currency, b.total, b.fx_rate); return fx ? (
                        <p className="font-mono text-sm font-semibold text-ink">{fx} <span className="text-[10px] font-normal text-ink-3">({rupee(b.total)})</span></p>
                      ) : (
                        <p className="font-mono text-sm font-semibold text-ink">{rupee(b.total)}</p>
                      ); })()}
                      <p className={`text-[10px] ${out > 0 ? "text-rose" : "text-emerald"}`}>{out > 0 ? `${rupee(out)} due` : "paid"}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            </div>
            )}
            {(vExpenses ?? []).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1 px-1">Expenses</p>
              <ul className="divide-y divide-hairline">
                {(vExpenses ?? []).map((e) => {
                  const fx = foreignAmount(e.currency, e.amount, e.fx_rate);
                  return (
                  <li
                    key={e.id}
                    onClick={() => setDetailExpense(e)}
                    className="flex items-center justify-between gap-3 py-2.5 -mx-1 px-1 rounded-md cursor-pointer hover:bg-paper-2/60 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-ink truncate">{e.category}{e.description ? <span className="text-ink-3"> · {e.description}</span> : ""}</p>
                      <p className="text-[11px] text-ink-3">{formatDate(e.expense_date)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono text-sm font-semibold text-ink">{fx ? <>{fx} <span className="text-[10px] font-normal text-ink-3">({rupee(e.amount)})</span></> : rupee(e.amount)}</p>
                      {e.gst_paid > 0 && (() => { const gfx = foreignAmount(e.currency, e.gst_paid, e.fx_rate); return <p className="text-[10px] text-emerald">+{gfx ?? rupee(e.gst_paid)} GST{gfx ? ` (${rupee(e.gst_paid)})` : ""}</p>; })()}
                    </div>
                  </li>
                  );
                })}
              </ul>
            </div>
            )}
          </>
          )}
        </div>
        <DialogFooter>
          <Button asChild variant="default"><Link href={"/accounting/bills" as never}>Open all bills</Link></Button>
          <Button variant="ghost" icon="edit" onClick={onEdit}>Edit vendor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {detailBill && <BillDetailDialog bill={detailBill} onClose={() => setDetailBill(null)} />}
    {detailExpense && <AddExpenseDialog expense={detailExpense} onClose={() => setDetailExpense(null)} />}
    </>
  );
}
