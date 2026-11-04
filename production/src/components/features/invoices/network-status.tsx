/**
 * R-2450 (G-NETWORK N2c) — the seller's view of its customer's answer on a network copy:
 *   - NetworkStatusLine: one line under the invoice header ("Sent to Anutech on network —
 *     Accepted by customer on 04 Nov 2026") + the next step when there is one;
 *   - NetworkNoteStatus: the same answer on each credit / debit note row under the invoice;
 *   - useNetworkChips + NetworkChip: the invoices list's chip per row.
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
import {
  invoiceNetworkDoc,
  networkChipByInvoice,
  networkStatusView,
  noteNetworkDoc,
  type NetworkStatusView,
} from "./network-status-model";

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** At most 500 ids per call (the function refuses more). With invoiceCopiesOnly each call returns
 *  at most ~one row per id, so it stays under PostgREST's max_rows (1000); the invoice page asks for
 *  one invoice (its copy + its notes' copies). Chunks run in parallel. */
const MAX_IDS = 500;

async function readSentStatus(invoiceIds: readonly string[], invoiceCopiesOnly: boolean): Promise<NetworkSentDoc[]> {
  if (invoiceIds.length === 0) return [];
  /* The function is newer than the generated Database types — same narrow untyped rpc as
     lib/network/documents.ts. */
  const c = createClient() as unknown as { rpc: Rpc };
  const chunks: string[][] = [];
  for (let i = 0; i < invoiceIds.length; i += MAX_IDS) chunks.push(invoiceIds.slice(i, i + MAX_IDS));
  const parts = await Promise.all(
    chunks.map(async (ids) => {
      const { data, error } = await c.rpc("network_seller_document_status", {
        p_invoice_ids: ids,
        p_invoice_copies_only: invoiceCopiesOnly,
      });
      if (error) throw new Error(error.message);
      return ((data as Record<string, unknown>[] | null) ?? []).map(toSentDoc);
    }),
  );
  return parts.flat();
}

/** A short stable key for a long id list (the list page can hold thousands of invoices). */
function idsKey(ids: readonly string[]): string {
  let h = 5381;
  const s = ids.join("|");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/** Under ["invoices"], so every invoice mutation that refreshes the list refreshes this too.
 *  Pass a memoised array (the dedupe + sort runs when it changes). */
export function useNetworkSentStatus(invoiceIds: readonly string[], opts: { invoiceCopiesOnly?: boolean } = {}) {
  const only = opts.invoiceCopiesOnly ?? false;
  const ids = React.useMemo(() => [...new Set(invoiceIds.filter(Boolean))].sort(), [invoiceIds]);
  const key = React.useMemo(() => idsKey(ids), [ids]);
  return useQuery({
    queryKey: ["invoices", "network-status", only ? "invoices" : "all", key],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: () => readSentStatus(ids, only),
  });
}

/** The invoices list: invoice id → chip. A failed read shows no chips (the invoice page says so). */
export function useNetworkChips(invoiceIds: readonly string[]): Map<string, NetworkStatusView> {
  const { data } = useNetworkSentStatus(invoiceIds, { invoiceCopiesOnly: true });
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
  creditedInFull,
  className,
}: {
  invoiceId: string;
  rows: readonly NetworkSentDoc[] | undefined;
  error?: unknown;
  onRetry: () => void;
  /** A credit note already covers the whole invoice — a rejected copy needs no further step. */
  creditedInFull?: boolean;
  className?: string;
}) {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    if (error != null) console.error("[load-error] network answer", error);
  }, [error]);
  if (error) {
    /* §24: say what did not load and the way on — small, because most customers are not on the
       network at all; the raw text stays in the console. */
    return (
      <p className={`flex flex-wrap items-center gap-1.5 text-2xs text-ink-3 ${className ?? ""}`} role="alert">
        <Icon name="alert" size={12} className="shrink-0 text-amber-ink" />
        Could not check whether your customer answered on the network.
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-ink underline underline-offset-2 hover:text-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
        >
          Try again
        </button>
      </p>
    );
  }
  const d = invoiceNetworkDoc(rows, invoiceId);
  if (!d) return null;
  const v = networkStatusView(d, { creditedInFull });
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
