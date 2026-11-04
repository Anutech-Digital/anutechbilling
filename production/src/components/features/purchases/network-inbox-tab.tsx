/**
 * R-2449 (G-NETWORK N2b) — Purchases → Inbox "From network".
 *
 * A connected seller's issued invoice (and its credit / debit notes) arrives here as a copy
 * frozen at issue (R-2434). The buyer answers it like GST IMS:
 *   - Accept → one bill in my books (or my own bill with the same number gets linked), with the
 *     category I pick (default: that vendor's default) — the dialog says first whether the GST
 *     becomes my input credit, by my own rules (lib/gst/bill-itc);
 *   - Reject → with a reason the seller reads (required; final — the seller corrects with a
 *     credit note and a fresh invoice);
 *   - Undo accept (invoice / debit note) for a wrong click.
 * Notes list under their invoice and wait for it. A copy the seller voided shows greyed.
 * Only owner / manager / accountant see this tab (the page checks; the database refuses others).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { TabBar } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { loadErrorBody } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { toast } from "@/components/ui/toaster";
import { toastError, describeError } from "@/lib/errors/toast-error";
import { formatDate, rupee, cn } from "@/lib/utils";
import { VENDOR_BILL_CATEGORIES, useOwnStateCode } from "@/lib/queries/vendor-bills";
import {
  canAccept, canReject, canUndoAccept, cleanRejectReason, type NetworkInboxDoc,
} from "@/lib/network/documents";
import {
  groupInbox, filterGroups, statusCounts, rowStatusText, acceptBlockedReason, defaultAcceptCategory,
  acceptItcLine, billsHref, kindLabel, type InboxFilter,
} from "./network-inbox-model";
import {
  useNetworkInbox, useAcceptNetworkDocument, useRejectNetworkDocument, useUndoNetworkAccept,
  useVendorDefaultCategory,
} from "./network-inbox-queries";

const money = (n: number, currency: string) =>
  currency === "INR" ? rupee(n) : `${currency} ${n.toLocaleString("en-IN")}`;

const STATUS_DOT: Readonly<Record<NetworkInboxDoc["status"], string>> = {
  pending: "bg-amber",
  accepted: "bg-emerald",
  rejected: "bg-rose",
  cancelled: "bg-ink-4",
};

export function NetworkInboxTab() {
  const { data, isLoading, error, refetch } = useNetworkInbox(true);
  const docs = React.useMemo(() => data ?? [], [data]);
  const counts = statusCounts(docs);
  const [picked, setPicked] = React.useState<InboxFilter | null>(null);
  const filter: InboxFilter = picked ?? (counts.pending > 0 ? "pending" : "all");
  const groups = React.useMemo(() => filterGroups(groupInbox(docs), filter), [docs, filter]);
  const byId = React.useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);

  const [acceptDoc, setAcceptDoc] = React.useState<NetworkInboxDoc | null>(null);
  const [rejectDoc, setRejectDoc] = React.useState<NetworkInboxDoc | null>(null);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const confirm = useConfirm();
  const undo = useUndoNetworkAccept();
  const doUndo = async (d: NetworkInboxDoc) => {
    const ok = await confirm({
      title: `Undo accept of ${kindLabel(d.kind).toLowerCase()} ${d.docNumber}?`,
      body: d.linkedExisting
        ? `Your bill ${d.vendorBillId ?? ""} stays; it is only unlinked. The ${kindLabel(d.kind).toLowerCase()} is pending again.`
        : `Bill ${d.vendorBillId ?? ""} is removed from your books and the ${kindLabel(d.kind).toLowerCase()} is pending again.`,
      confirmLabel: "Undo accept",
      danger: true,
    });
    if (!ok) return;
    try {
      await undo.mutateAsync(d.id);
      toast.success(`${kindLabel(d.kind)} ${d.docNumber} is pending again`);
    } catch (e) {
      toastError(e, { fallback: "Could not undo the accept." });
    }
  };

  if (error) {
    return (
      <EmptyState icon="alert" title="Could not load documents from your network" body={loadErrorBody(error)}
        action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>} />
    );
  }
  if (isLoading) return <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (docs.length === 0) {
    return (
      <EmptyState
        icon="users"
        title="Nothing from your network yet"
        body="When a supplier connected with you on ResellerOS issues you an invoice, it lands here to accept or reject — no typing the bill."
        action={<Link href={"/settings?tab=network" as Route}><Button icon="users">Connect a supplier</Button></Link>}
      />
    );
  }

  const filters: { id: InboxFilter; label: string }[] = [
    { id: "pending", label: "Pending" },
    { id: "accepted", label: "Accepted" },
    { id: "rejected", label: "Rejected" },
    { id: "cancelled", label: "Cancelled" },
    { id: "all", label: "All" },
  ];

  const renderRow = (d: NetworkInboxDoc, isNote: boolean) => {
    const parent = d.parentDocumentId ? byId.get(d.parentDocumentId) : null;
    const blocked = canAccept(d) ? acceptBlockedReason(d, parent) : null;
    const gst = d.cgst + d.sgst + d.igst;
    const greyed = d.status === "cancelled";
    const linesOpen = open.has(d.id);
    return (
      <React.Fragment key={d.id}>
        <tr className={cn("border-t border-hairline align-top", greyed && "opacity-60")}>
          <td className="py-2.5 pr-3">
            <div className={cn("text-sm font-medium text-ink truncate", isNote && "pl-5")} title={d.sellerName}>{d.sellerName}</div>
            <div className={cn("font-mono text-xs text-ink-3", isNote && "pl-5")}>{d.sellerGstin}</div>
          </td>
          <td className="py-2.5 pr-3">
            <div className={cn("text-xs text-ink-3", isNote && "pl-5")}>
              {isNote && <span aria-hidden>↳ </span>}{kindLabel(d.kind)} · {formatDate(d.docDate)}
            </div>
            <div className={cn("font-mono text-sm text-ink truncate", isNote && "pl-5")} title={d.docNumber}>{d.docNumber}</div>
            {d.lines.length > 0 && (
              <button
                type="button"
                className={cn("text-xs text-indigo-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded", isNote && "ml-5")}
                aria-expanded={linesOpen}
                onClick={() => toggle(d.id)}
              >
                {linesOpen ? "Hide" : "Show"} {d.lines.length} {d.lines.length === 1 ? "line" : "lines"}
              </button>
            )}
          </td>
          <td className="py-2.5 pr-3 text-right tabular-nums text-sm">{money(d.taxableValue, d.currency)}</td>
          <td className="py-2.5 pr-3 text-right tabular-nums text-sm">{money(gst, d.currency)}</td>
          <td className="py-2.5 pr-3 text-right tabular-nums text-sm font-semibold">{money(d.total, d.currency)}</td>
          <td className="py-2.5 pr-3">
            <div className="flex items-start gap-1.5 text-sm text-ink">
              <span aria-hidden className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[d.status])} />
              <span className="line-clamp-2 break-words" title={rowStatusText(d)}>{rowStatusText(d)}</span>
            </div>
            {d.status === "accepted" && d.applyNote && <p className="mt-1 text-xs text-ink-3">{d.applyNote}</p>}
            {blocked && <p className="mt-1 text-xs text-amber-ink">{blocked}</p>}
          </td>
          <td className="py-2.5 text-right">
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {canAccept(d) && (
                <Button size="sm" variant="primary" icon="check" disabled={!!blocked} onClick={() => setAcceptDoc(d)}>Accept</Button>
              )}
              {canReject(d) && (
                <Button size="sm" variant="ghost" onClick={() => setRejectDoc(d)}>Reject</Button>
              )}
              {d.status === "accepted" && d.vendorBillId && (
                <Link href={billsHref(d) as Route}><Button size="sm" variant="default" icon="file">Open bill</Button></Link>
              )}
              {canUndoAccept(d) && (
                <Button size="sm" variant="ghost" loading={undo.isPending && undo.variables === d.id} onClick={() => void doUndo(d)}>
                  Undo accept
                </Button>
              )}
            </div>
          </td>
        </tr>
        {linesOpen && (
          <tr className={cn(greyed && "opacity-60")}>
            <td colSpan={7} className="pb-3 pl-5 pr-3">
              <ul className="space-y-0.5 rounded-md bg-paper-2 px-3 py-2 text-xs text-ink-2">
                {d.lines.map((l, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words">
                      {l.description}{l.hsnSac ? <span className="text-ink-3"> · HSN/SAC {l.hsnSac}</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums">{l.quantity} × {money(l.rate, d.currency)} = {money(l.amount, d.currency)}</span>
                  </li>
                ))}
                {(d.dueDate || d.pdfUrl) && (
                  <li className="flex gap-3 pt-1 text-ink-3">
                    {d.dueDate && <span>Due {formatDate(d.dueDate)}</span>}
                    {d.pdfUrl && (
                      <a href={d.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-ink hover:underline">
                        Seller&apos;s PDF
                      </a>
                    )}
                  </li>
                )}
              </ul>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="space-y-3">
      <TabBar
        value={filter}
        onChange={(id) => setPicked(id as InboxFilter)}
        items={filters.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] }))}
      />
      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">Nothing {filter === "all" ? "" : filter} here.</p>
      ) : (
        <div className="rounded-lg border border-hairline bg-paper px-3">
          <table className="w-full table-fixed text-left">
            <caption className="sr-only">Documents from connected businesses</caption>
            <colgroup>
              <col className="w-[22%]" /><col className="w-[18%]" /><col className="w-[10%]" /><col className="w-[9%]" />
              <col className="w-[10%]" /><col className="w-[15%]" /><col className="w-[16%]" />
            </colgroup>
            <thead>
              <tr className="text-xs uppercase tracking-wider text-ink-3">
                <th scope="col" className="py-2 pr-3 font-semibold">Seller</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Document</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">Taxable</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">GST</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">Total</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                <th scope="col" className="py-2 text-right font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.doc.id}>
                  {renderRow(g.doc, false)}
                  {g.notes.map((n) => renderRow(n, true))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {acceptDoc && <AcceptDialog doc={acceptDoc} onClose={() => setAcceptDoc(null)} />}
      {rejectDoc && <RejectDialog doc={rejectDoc} onClose={() => setRejectDoc(null)} />}
    </div>
  );
}

function DialogError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md bg-rose-soft px-3 py-2 text-sm text-rose-ink">
      <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

function AcceptDialog({ doc, onClose }: { doc: NetworkInboxDoc; onClose: () => void }) {
  const isCredit = doc.kind === "credit_note";
  const kind = kindLabel(doc.kind).toLowerCase();
  const { data: vendorDefault } = useVendorDefaultCategory(isCredit ? null : doc.sellerGstin);
  const { data: ownStateCode } = useOwnStateCode();
  const [picked, setPicked] = React.useState<string | null>(null);
  const category = picked ?? defaultAcceptCategory(vendorDefault);
  const itc = acceptItcLine(doc, category, ownStateCode);
  const accept = useAcceptNetworkDocument();
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    try {
      const r = await accept.mutateAsync({ id: doc.id, category: isCredit ? null : category });
      toast.success(
        isCredit ? `Credit note ${doc.docNumber} accepted — bill ${r.vendorBillId} lowered`
          : r.linkedExisting ? `Linked to your bill ${r.vendorBillId}` : `Bill ${r.vendorBillId} created`,
        r.note ? { description: r.note } : undefined,
      );
      onClose();
    } catch (e) {
      const d = describeError(e, "Could not accept this document.");
      setErr(d.description ? `${d.message} ${d.description}` : d.message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Accept {kind} {doc.docNumber}</DialogTitle>
          <DialogDescription>
            From {doc.sellerName} (GSTIN {doc.sellerGstin}) · total {money(doc.total, doc.currency)}.{" "}
            {isCredit
              ? `This lowers your bill for invoice ${doc.sellerInvoiceId}.`
              : "Accepting adds one bill to your books (or links your own bill with the same number). Nothing is filed on the GST portal."}
          </DialogDescription>
        </DialogHeader>

        {!isCredit && (
          <div className="space-y-3">
            <FormField label="Category" required htmlFor="network-accept-category">
              <Select value={category} onValueChange={setPicked}>
                <SelectTrigger id="network-accept-category"><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {VENDOR_BILL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            <p className={cn("flex items-start gap-2 text-sm", itc.credit ? "text-emerald-ink" : "text-amber-ink")}>
              <Icon name={itc.credit ? "check_circle" : "info"} size={14} className="mt-0.5 shrink-0" />
              <span>{itc.text}</span>
            </p>
          </div>
        )}

        <DialogError text={err} />

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" loading={accept.isPending} onClick={() => void submit()}>
            {isCredit ? "Accept credit note" : "Accept and create bill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ doc, onClose }: { doc: NetworkInboxDoc; onClose: () => void }) {
  const kind = kindLabel(doc.kind).toLowerCase();
  const reject = useRejectNetworkDocument();
  const [reason, setReason] = React.useState("");
  const [fieldErr, setFieldErr] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    let clean: string;
    try {
      clean = cleanRejectReason(reason);
    } catch (e) {
      setFieldErr((e as Error).message);
      return;
    }
    setFieldErr(null);
    try {
      await reject.mutateAsync({ id: doc.id, reason: clean });
      toast.success(`${kindLabel(doc.kind)} ${doc.docNumber} rejected — ${doc.sellerName} sees your reason`);
      onClose();
    } catch (e) {
      const d = describeError(e, "Could not reject this document.");
      setErr(d.description ? `${d.message} ${d.description}` : d.message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Reject {kind} {doc.docNumber}</DialogTitle>
          <DialogDescription>
            {doc.sellerName} sees your reason on their {kind}. Reject is final — they correct it with a credit note and a fresh invoice.
          </DialogDescription>
        </DialogHeader>
        <FormField label="Reason" required>
          <Textarea
            value={reason}
            maxLength={500}
            rows={3}
            placeholder="e.g. Rate is ₹900, not ₹1,000 as agreed"
            error={fieldErr ?? undefined}
            onChange={(e) => { setReason(e.target.value); if (fieldErr) setFieldErr(null); }}
          />
        </FormField>
        <DialogError text={err} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={reject.isPending} onClick={() => void submit()}>Reject {kind}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
