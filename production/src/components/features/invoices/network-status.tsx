/**
 * R-2450 (G-NETWORK N2c) — the seller's view of its customer's answer on a network copy:
 *   - NetworkStatusLine: one line under the invoice header ("Sent to Anutech on network —
 *     Accepted by customer on 04 Nov 2026") + the next step when there is one;
 *   - NetworkNoteChip: the same answer on a credit / debit note row under the invoice;
 *   - useNetworkChips: the invoices list's chip per row (one read for the whole page).
 *
 * Read through network_seller_document_status (SECURITY DEFINER, tenant + owner / manager /
 * accountant / billing gate — migration *_r2450_*). A customer not on the network, or a role
 * that may not read it, gets no row → nothing is shown. Words: ./network-status-model.ts.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toSentDoc, type NetworkSentDoc } from "@/lib/network/documents";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { LoadErrorInline } from "@/components/shared/load-error";
import {
  invoiceNetworkDoc,
  networkChipByInvoice,
  networkStatusView,
  noteNetworkDoc,
  type NetworkStatusView,
} from "./network-status-model";

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** At most 500 ids per call (the function refuses more) — the list pages are far smaller. */
const MAX_IDS = 500;

async function readSentStatus(invoiceIds: readonly string[]): Promise<NetworkSentDoc[]> {
  if (invoiceIds.length === 0) return [];
  /* The function is newer than the generated Database types — same narrow untyped rpc as
     lib/network/documents.ts. */
  const c = createClient() as unknown as { rpc: Rpc };
  const out: NetworkSentDoc[] = [];
  for (let i = 0; i < invoiceIds.length; i += MAX_IDS) {
    const { data, error } = await c.rpc("network_seller_document_status", { p_invoice_ids: invoiceIds.slice(i, i + MAX_IDS) });
    if (error) throw new Error(error.message);
    for (const r of (data as Record<string, unknown>[] | null) ?? []) out.push(toSentDoc(r));
  }
  return out;
}

/** Under ["invoices"], so every invoice mutation that refreshes the list refreshes this too. */
export function useNetworkSentStatus(invoiceIds: readonly string[]) {
  const ids = React.useMemo(() => [...new Set(invoiceIds.filter(Boolean))].sort(), [invoiceIds]);
  return useQuery({
    queryKey: ["invoices", "network-status", ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: () => readSentStatus(ids),
  });
}

/** The invoices list: invoice id → chip. An error shows no chips (the invoice page says why). */
export function useNetworkChips(invoiceIds: readonly string[]): Map<string, NetworkStatusView> {
  const { data } = useNetworkSentStatus(invoiceIds);
  return React.useMemo(() => networkChipByInvoice(data), [data]);
}

const TONE_ICON = { info: "send", success: "check_circle", danger: "alert", muted: "x_circle" } as const;
const TONE_TEXT = { info: "text-indigo-ink", success: "text-emerald", danger: "text-rose-ink", muted: "text-ink-3" } as const;

/** The small chip in the invoices list (fits the Status cell under the payment badge). */
export function NetworkChip({ view }: { view: NetworkStatusView }) {
  return (
    <Badge kind={view.tone} size="sm" title={view.line} data-network-chip>
      Network · {view.chip}
    </Badge>
  );
}

/** One line under the invoice header. Nothing when the invoice was never sent on the network.
 *  The page reads once (useNetworkSentStatus) and hands the rows here and to the notes list. */
export function NetworkStatusLine({
  invoiceId,
  rows,
  error,
  onRetry,
  className,
}: {
  invoiceId: string;
  rows: readonly NetworkSentDoc[] | undefined;
  error?: unknown;
  onRetry: () => void;
  className?: string;
}) {
  if (error) {
    return (
      <div className={className}>
        <LoadErrorInline what="the customer's network answer" onRetry={onRetry} error={error} />
      </div>
    );
  }
  const d = invoiceNetworkDoc(rows, invoiceId);
  if (!d) return null;
  const v = networkStatusView(d);
  return (
    <div className={className} data-network-status={d.status} role="status">
      <p className={`flex items-start gap-1.5 text-xs font-medium ${TONE_TEXT[v.tone]}`}>
        <Icon name={TONE_ICON[v.tone]} size={14} className="mt-px shrink-0" />
        <span className="min-w-0 break-words">{v.line}</span>
      </p>
      {v.nextStep && <p className="text-2xs text-ink-2 mt-0.5 pl-5">{v.nextStep}</p>}
    </div>
  );
}

/** A credit / debit note row's answer (one line under the row). Nothing when it has no copy. */
export function NetworkNoteStatus({ rows, noteId }: { rows: readonly NetworkSentDoc[] | undefined; noteId: string }) {
  const d = noteNetworkDoc(rows, noteId);
  if (!d) return null;
  const v = networkStatusView(d);
  return (
    <p className={`mt-1 flex items-start gap-1.5 text-2xs font-medium ${TONE_TEXT[v.tone]}`} data-network-status={d.status}>
      <Icon name={TONE_ICON[v.tone]} size={12} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">
        {v.line}
        {v.nextStep && <span className="text-ink-2 font-normal"> · {v.nextStep}</span>}
      </span>
    </p>
  );
}

/** The invoice page's one read, for the notes list under it (no prop to thread through, and a
 *  notes list rendered elsewhere — the invoices list's expand — simply shows no note status). */
export const NetworkRowsContext = React.createContext<readonly NetworkSentDoc[] | undefined>(undefined);

/** NetworkNoteStatus fed from NetworkRowsContext. */
export function NetworkNoteStatusFromPage({ noteId }: { noteId: string }) {
  const rows = React.useContext(NetworkRowsContext);
  return <NetworkNoteStatus rows={rows} noteId={noteId} />;
}
