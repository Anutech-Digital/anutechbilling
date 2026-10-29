"use client";

/**
 * R-2025 (5): "Known payers" on the customer page — who else pays for this customer (their own
 * other account, a group company, a director, a third party). Learned when a bank line from that
 * account is reconciled with an answer on the Reconcile sheet, or added here by an owner /
 * accountant. The next line from a known payer guesses this customer by itself ("Why: known payer
 * for …"). The receipt and GST invoice always stay in the customer's own name.
 */
import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { bankLineHref } from "@/lib/payroll/salary-bank-link";
import { PAYER_RELATIONS, relationLabel, type KnownPayer, type PayerRelation } from "@/lib/banking/customer-payer";
import {
  useCustomerPayerLines, useCustomerPayers, useDeleteCustomerPayer, useSaveCustomerPayer, type KnownPayerInput,
} from "@/lib/queries/customer-payers";

const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

interface Draft { id: string | null; name: string; relation: PayerRelation; note: string; ifsc: string; upi: string; tail: string }
const EMPTY: Draft = { id: null, name: "", relation: "group_company", note: "", ifsc: "", upi: "", tail: "" };
const fromRow = (k: KnownPayer): Draft => ({
  id: k.id, name: k.payer_name, relation: k.relation, note: k.note ?? "", ifsc: k.ifsc ?? "", upi: k.upi_id ?? "", tail: k.account_tail ?? "",
});
const orNull = (s: string) => s.trim() || null;

export function KnownPayersCard({ customerId, customerName, canEdit }: { customerId: string; customerName: string; canEdit: boolean }) {
  const { data: all } = useCustomerPayers();
  const { data: lines } = useCustomerPayerLines(customerId);
  const save = useSaveCustomerPayer();
  const del = useDeleteCustomerPayer();
  const payers = (all ?? []).filter((k) => k.customer_id === customerId);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);

  const submit = async () => {
    if (!draft || !draft.name.trim()) return;
    const input: KnownPayerInput = {
      id: draft.id, customerId, payerName: draft.name.trim(), relation: draft.relation, note: orNull(draft.note),
      ifsc: orNull(draft.ifsc), upi: orNull(draft.upi), accountTail: orNull(draft.tail),
    };
    try {
      await save.mutateAsync(input);
      setDraft(null);
    } catch { /* the hook toasts */ }
  };

  return (
    <Card
      title="Known payers"
      sub={`Accounts that pay for ${customerName}`}
      actions={canEdit && !draft ? <Button size="sm" variant="default" icon="plus" onClick={() => setDraft(EMPTY)}>Add known payer</Button> : undefined}
    >
      {payers.length === 0 && !draft && (
        <p className="text-xs text-ink-3">
          No known payers yet — they are learned when you reconcile money paid from someone else&apos;s account, or add one here.
        </p>
      )}
      {payers.length > 0 && (
        <ul className="divide-y divide-hairline">
          {payers.map((k) => {
            const seen = (lines ?? []).filter((l) => l.payer_key === k.payer_name_key);
            const details = [k.ifsc && `IFSC ${k.ifsc}`, k.upi_id && `UPI ${k.upi_id}`, k.account_tail && `a/c …${k.account_tail}`].filter(Boolean).join(" · ");
            return (
              <li key={k.id} className="py-2 first:pt-0 last:pb-0 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm text-ink break-words">
                    <span className="font-medium">{k.payer_name}</span>{" "}
                    <Badge kind="muted" size="sm">{relationLabel(k.relation)}</Badge>
                  </p>
                  {details && <p className="text-xs text-ink-3">{details}</p>}
                  {k.note && <p className="text-xs text-ink-2 break-words">{k.note}</p>}
                  <p className="text-xs text-ink-3">
                    {seen.length > 0 ? (
                      <Link href={bankLineHref({ accountId: seen[0].bank_account_id, txnId: seen[0].id }) as never} className="underline hover:no-underline">
                        {`Seen on ${seen.length} bank line${seen.length === 1 ? "" : "s"}`}
                      </Link>
                    ) : `Added ${formatDate(k.created_at)} — not seen on a bank line yet`}
                  </p>
                </div>
                {canEdit && (
                  confirmId === k.id ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-ink-2">Remove this payer?</span>
                      <Button size="sm" variant="danger" loading={del.isPending} onClick={async () => { try { await del.mutateAsync(k.id); } catch { /* toasted */ } setConfirmId(null); }}>Yes, remove</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${k.payer_name}`} onClick={() => setDraft(fromRow(k))}>Edit</Button>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${k.payer_name}`} onClick={() => setConfirmId(k.id)}>Remove</Button>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <div className="mt-3 rounded-md border border-hairline bg-paper-2/40 p-2.5 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs text-ink-3 space-y-0.5 sm:col-span-2">
              <span className="block">Payer name (as on the bank line)</span>
              <Input value={draft.name} maxLength={200} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Payer name (as on the bank line)" />
            </label>
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">How related</span>
              <select value={draft.relation} onChange={(e) => setDraft({ ...draft, relation: e.target.value as PayerRelation })} aria-label="How related" className={selectCls}>
                {PAYER_RELATIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">Note (optional)</span>
              <Input value={draft.note} maxLength={500} onChange={(e) => setDraft({ ...draft, note: e.target.value })} aria-label="Note (optional)" />
            </label>
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">IFSC (optional)</span>
              <Input value={draft.ifsc} maxLength={20} onChange={(e) => setDraft({ ...draft, ifsc: e.target.value })} aria-label="IFSC (optional)" />
            </label>
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">UPI id (optional)</span>
              <Input value={draft.upi} maxLength={100} onChange={(e) => setDraft({ ...draft, upi: e.target.value })} aria-label="UPI id (optional)" />
            </label>
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">Account ending (optional)</span>
              <Input value={draft.tail} maxLength={6} inputMode="numeric" onChange={(e) => setDraft({ ...draft, tail: e.target.value.replace(/\D/g, "") })} aria-label="Account ending (optional)" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon="check" disabled={!draft.name.trim()} loading={save.isPending} onClick={submit}>Save payer</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
