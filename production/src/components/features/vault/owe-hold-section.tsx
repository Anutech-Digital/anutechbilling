/**
 * R-2386 — Private Vault → Banking → "Money I owe / hold for others".
 *
 * Money that sits in one of your accounts (or as cash with someone) but is not yours: an
 * advance (byana) received for a sale, or money held on behalf of someone (a child). Every
 * OPEN entry is subtracted from Net worth on the Overview, so a ₹5 lakh byana kept as cash
 * no longer shows as ₹5 lakh of wealth. Loans are a separate card (R-2388).
 *
 * Closing an entry: an advance → "Convert into sale" (it became part of the sale price —
 * simply marked settled with a note, no capital-gains maths) or "Refund"; held money →
 * "Hand over". The linked account's balance is not changed here (balances are typed in
 * Banking) — the settle dialog says so.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { PersonalAccount } from "@/lib/queries/personal-vault";
import {
  usePersonalOweHold,
  useSavePersonalOweHold,
  useSettlePersonalOweHold,
  useDeletePersonalOweHold,
  type PersonalOweHold,
} from "@/lib/queries/personal-owe-hold";
import {
  OWE_HOLD_KINDS,
  OWE_HOLD_KIND_LABEL,
  OWE_HOLD_KIND_SHORT,
  OWE_HOLD_PARTY_LABEL,
  OWE_HOLD_SETTLED_LABEL,
  openOweHoldTotal,
  settleActions,
  type OweHoldKind,
  type OweHoldSettledHow,
} from "@/lib/vault/personal/owe-hold";
import { isLiabilityAccount } from "@/lib/vault/personal/net-worth";
import { parseRupees, MAX_RUPEES } from "@/lib/vault/personal/parse-rupees";
import { istToday } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";

const NO_ACCOUNT = "none";

interface FormState {
  id?: string;
  kind: OweHoldKind;
  party: string;
  occurred_on: string;
  amount: string;
  account_id: string;
  note: string;
}

const emptyForm = (): FormState => ({
  kind: "advance_received", party: "", occurred_on: istToday(), amount: "", account_id: NO_ACCOUNT, note: "",
});

const SETTLE_NOTE_DEFAULT: Record<OweHoldSettledHow, string> = {
  converted_to_sale: "Advance became part of the sale price",
  refunded: "",
  handed_over: "",
};

export function OweHoldSection({ accounts }: { accounts: PersonalAccount[] }) {
  const { data, isLoading, error } = usePersonalOweHold();
  const save = useSavePersonalOweHold();
  const settle = useSettlePersonalOweHold();
  const del = useDeletePersonalOweHold();
  const confirm = useConfirm();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [amountIssue, setAmountIssue] = React.useState<string | null>(null);
  const [settling, setSettling] = React.useState<{ row: PersonalOweHold; how: OweHoldSettledHow; on: string; note: string } | null>(null);

  // Where cash can sit: the owner's active, non-card accounts (a link to an old one stays shown).
  const pickable = accounts.filter((a) => a.is_active && !isLiabilityAccount(a.kind));
  const accountName = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.label ?? null : null);

  const rows = data ?? [];
  const openRows = rows.filter((r) => r.status === "open");
  const settledRows = rows.filter((r) => r.status === "settled");
  const openTotal = openOweHoldTotal(rows);

  const openNew = () => { setForm(emptyForm()); setAmountIssue(null); setOpen(true); };
  const openEdit = (r: PersonalOweHold) => {
    setForm({
      id: r.id, kind: r.kind, party: r.party, occurred_on: r.occurred_on, amount: String(r.amount),
      account_id: r.account_id ?? NO_ACCOUNT, note: r.note ?? "",
    });
    setAmountIssue(null);
    setOpen(true);
  };

  const handleSave = async () => {
    if (!form.party.trim()) {
      toast.error(form.kind === "advance_received" ? "Who paid the advance?" : "Who is the money held for?", {
        description: "Type a name, like the buyer or your daughter. Nothing was saved.",
      });
      return;
    }
    const p = parseRupees(form.amount);
    if (!p.ok || p.value <= 0) {
      setAmountIssue(!p.ok && p.reason === "too_big"
        ? `Too large — up to ${rupee(MAX_RUPEES)} (₹1 lakh crore). Check for extra zeros.`
        : "Type the amount in digits, like 500000 or 5,00,000. It must be more than 0.");
      return;
    }
    if (!form.occurred_on) {
      toast.error("Pick the date the money came in.");
      return;
    }
    setAmountIssue(null);
    try {
      await save.mutateAsync({
        id: form.id,
        kind: form.kind,
        party: form.party.trim(),
        occurred_on: form.occurred_on,
        amount: p.value,
        account_id: form.account_id === NO_ACCOUNT ? null : form.account_id,
        note: form.note.trim() || null,
      });
      toast.success(form.id ? "Entry updated." : "Entry added — Net worth now takes it off.");
      setOpen(false);
    } catch {
      /* the hook already showed why */
    }
  };

  const startSettle = (row: PersonalOweHold, how: OweHoldSettledHow) =>
    setSettling({ row, how, on: istToday(), note: SETTLE_NOTE_DEFAULT[how] });

  const handleSettle = async () => {
    if (!settling) return;
    if (!settling.on) { toast.error("Pick the date."); return; }
    try {
      await settle.mutateAsync({
        id: settling.row.id,
        settled_how: settling.how,
        settled_on: settling.on,
        settle_note: settling.note.trim() || null,
      });
      toast.success(`${OWE_HOLD_SETTLED_LABEL[settling.how]} — no longer counted in Net worth.`);
      setSettling(null);
    } catch {
      /* the hook already showed why */
    }
  };

  const handleDelete = async (r: PersonalOweHold) => {
    const ok = await confirm({
      title: `Delete the entry for "${r.party}"?`,
      body: "Use this only for a mistake. If the money was paid back or handed over, use Settle instead so the history stays.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(r.id);
      toast.success("Entry deleted.");
    } catch {
      /* the hook already showed why */
    }
  };

  const settleTitle = settling
    ? settling.how === "converted_to_sale" ? "Convert into sale"
      : settling.how === "refunded" ? "Refund the advance" : "Hand over the money"
    : "";

  return (
    <Card className="p-0 overflow-hidden" aria-labelledby="owe-hold-title">
      <div className="px-4 py-2.5 border-b border-hairline bg-paper-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="owe-hold-title" className="text-xs font-bold uppercase tracking-wider text-ink-3">Money I owe / hold for others</h2>
          <p className="text-2xs text-ink-3 mt-0.5">
            Advances received for a sale, money kept for someone. Open entries are taken off your Net worth.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {openRows.length > 0 && (
            <span className="text-right">
              <span className="block text-3xs uppercase tracking-wide text-ink-3">Open</span>
              <Money amount={openTotal} size="cell" tone="negative" autoNegative={false} />
            </span>
          )}
          <Button size="sm" variant="outline" onClick={openNew}>
            <Icon name="plus" size={13} className="mr-1" />
            Add entry
          </Button>
        </div>
      </div>

      {error && <p className="px-4 py-3 text-xs text-rose" role="alert">Could not load these entries. Refresh the page to try again.</p>}
      {isLoading && <p className="px-4 py-3 text-xs text-ink-3">Loading…</p>}
      {!isLoading && !error && rows.length === 0 && (
        <p className="px-4 py-3 text-xs text-ink-3">
          Nothing yet. Received a byana for a sale, or keeping money for your child? Add it here so your Net worth stays true.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-hairline">
          {[...openRows, ...settledRows].map((r) => {
            const where = accountName(r.account_id);
            const isOpen = r.status === "open";
            return (
              <li key={r.id} className={`px-4 py-3 flex items-center gap-3 ${isOpen ? "" : "opacity-70"}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-ink">{r.party}</span>
                    <Badge kind="muted" size="sm">{OWE_HOLD_KIND_SHORT[r.kind]}</Badge>
                    {!isOpen && r.settled_how && (
                      <Badge kind="muted" size="sm">
                        {OWE_HOLD_SETTLED_LABEL[r.settled_how]}{r.settled_on ? ` · ${formatDate(r.settled_on)}` : ""}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">
                    {formatDate(r.occurred_on)}
                    {where && <> · kept in {where}</>}
                    {r.note && <> · {r.note}</>}
                    {!isOpen && r.settle_note && <> · {r.settle_note}</>}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <Money amount={r.amount} size="cell" tone={isOpen ? "negative" : "default"} autoNegative={false} />
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isOpen && settleActions(r.kind).map((a, i) => (
                    <Button key={a.how} size="sm" variant={i === 0 ? "primary" : "outline"} onClick={() => startSettle(r, a.how)}>
                      {a.label}
                    </Button>
                  ))}
                  {isOpen && (
                    <Button size="sm" variant="ghost" onClick={() => openEdit(r)} aria-label={`Edit ${r.party}`}>
                      <Icon name="edit" size={14} />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => handleDelete(r)} aria-label={`Delete ${r.party}`} className="text-rose">
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Add / edit ─────────────────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit entry" : "Money I owe / hold"}</DialogTitle>
            <DialogDescription className="text-xs">
              Money that is with you but not yours. It is taken off your Net worth until you settle it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label htmlFor="oh-kind" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">What is it</label>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as OweHoldKind }))}>
                <SelectTrigger id="oh-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OWE_HOLD_KINDS.map((k) => <SelectItem key={k} value={k}>{OWE_HOLD_KIND_LABEL[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="oh-party" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">{OWE_HOLD_PARTY_LABEL[form.kind]}</label>
                <Input id="oh-party" value={form.party}
                  onChange={(e) => setForm((f) => ({ ...f, party: e.target.value }))}
                  placeholder={form.kind === "advance_received" ? "Buyer's name" : "Daughter / son"} />
              </div>
              <div>
                <label htmlFor="oh-amount" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Amount (₹)</label>
                <Input id="oh-amount" value={form.amount} inputMode="numeric" placeholder="500000"
                  onChange={(e) => { setForm((f) => ({ ...f, amount: e.target.value })); setAmountIssue(null); }}
                  aria-invalid={amountIssue ? true : undefined}
                  aria-describedby={amountIssue ? "oh-amount-error" : undefined} />
                {amountIssue && <p id="oh-amount-error" role="alert" className="mt-1 text-xs text-rose">{amountIssue}</p>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="oh-date" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Date received</label>
                <Input id="oh-date" type="date" value={form.occurred_on}
                  onChange={(e) => setForm((f) => ({ ...f, occurred_on: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="oh-account" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Where the money is</label>
                <Select value={form.account_id} onValueChange={(v) => setForm((f) => ({ ...f, account_id: v }))}>
                  <SelectTrigger id="oh-account"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ACCOUNT}>Not linked</SelectItem>
                    {pickable.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
                    {form.account_id !== NO_ACCOUNT && !pickable.some((a) => a.id === form.account_id) && (
                      <SelectItem value={form.account_id}>{accountName(form.account_id) ?? "Removed account"}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label htmlFor="oh-note" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Note</label>
              <Input id="oh-note" value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="optional — e.g. byana for the plot sale" />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} loading={save.isPending}>{form.id ? "Update" : "Add"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Settle ─────────────────────────────────────────────────────────── */}
      <Dialog open={settling !== null} onOpenChange={(v) => { if (!v) setSettling(null); }}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{settleTitle}</DialogTitle>
            <DialogDescription className="text-xs">
              {settling && <>{settling.row.party} · {rupee(settling.row.amount)}. </>}
              It will no longer be taken off your Net worth. If the cash left an account, update that account&apos;s balance in Banking.
            </DialogDescription>
          </DialogHeader>
          {settling && (
            <div className="space-y-3">
              <div>
                <label htmlFor="oh-settle-date" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Date</label>
                <Input id="oh-settle-date" type="date" value={settling.on}
                  onChange={(e) => setSettling((s) => (s ? { ...s, on: e.target.value } : s))} />
              </div>
              <div>
                <label htmlFor="oh-settle-note" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Note</label>
                <Input id="oh-settle-note" value={settling.note} placeholder="optional"
                  onChange={(e) => setSettling((s) => (s ? { ...s, note: e.target.value } : s))} />
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="outline" onClick={() => setSettling(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleSettle} loading={settle.isPending}>{settleTitle}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
