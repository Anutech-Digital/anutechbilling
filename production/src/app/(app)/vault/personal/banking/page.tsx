/**
 * Private Vault → Banking. The owner's OWN accounts, cards and deposits.
 *
 * ─── DELIBERATELY NOT `bank_accounts` ───────────────────────────────────────
 * The company already has a `bank_accounts` table that is reconciled line-by-line
 * against real statements and feeds the balance sheet. Personal accounts must never land
 * there: a personal savings balance in the company's books is a wrong balance sheet, and
 * a personal transaction offered to the bank-reconciliation screen is a match somebody
 * will eventually accept by mistake.
 *
 * ─── ONLY THE LAST FOUR DIGITS ──────────────────────────────────────────────
 * Enough to tell two HDFC accounts apart, useless to anybody who gets the table. There
 * is nothing this feature can do with a full account number, so it does not ask for one.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/ui/money";
import { EmptyState } from "@/components/shared/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import {
  usePersonalAccounts,
  useSavePersonalAccount,
  useDeletePersonalAccount,
  type PersonalAccount,
} from "@/lib/queries/personal-vault";
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABEL,
  isLiabilityAccount,
  type AccountKind,
} from "@/lib/vault/personal/net-worth";
import { formatDate } from "@/lib/utils";

interface FormState {
  id?: string;
  kind: AccountKind;
  label: string;
  institution: string;
  account_last4: string;
  balance: string;
  credit_limit: string;
  interest_rate: string;
  maturity_date: string;
  notes: string;
}

const EMPTY: FormState = {
  kind: "savings", label: "", institution: "", account_last4: "",
  balance: "", credit_limit: "", interest_rate: "", maturity_date: "", notes: "",
};

/** "1,50,000" / "₹1.5L" is not accepted — this is a plain number field, so say so. */
function parseRupees(value: string): number | null {
  const cleaned = value.replace(/[,\s₹]/g, "");
  if (cleaned === "") return 0;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Whole rupees, everywhere. Paise never reach persistence.
  return Math.round(n);
}

export default function PersonalBankingPage() {
  const { data, isLoading, error } = usePersonalAccounts(true);
  const save = useSavePersonalAccount();
  const del = useDeletePersonalAccount();
  const confirm = useConfirm();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(EMPTY);

  const openNew = () => { setForm(EMPTY); setOpen(true); };
  const openEdit = (a: PersonalAccount) => {
    setForm({
      id: a.id,
      kind: a.kind,
      label: a.label,
      institution: a.institution ?? "",
      account_last4: a.account_last4 ?? "",
      balance: String(a.balance ?? 0),
      credit_limit: a.credit_limit === null ? "" : String(a.credit_limit),
      interest_rate: a.interest_rate === null ? "" : String(a.interest_rate),
      maturity_date: a.maturity_date ?? "",
      notes: a.notes ?? "",
    });
    setOpen(true);
  };

  const handleSave = async () => {
    if (!form.label.trim()) { toast.error("Account ka naam likho (jaise 'HDFC Salary')."); return; }

    const balance = parseRupees(form.balance);
    if (balance === null) { toast.error("Balance sirf number me likho — comma ya ₹ nahi."); return; }

    if (form.account_last4 && !/^\d{4}$/.test(form.account_last4)) {
      toast.error("Sirf aakhri 4 digit likho (poora number nahi).");
      return;
    }

    const creditLimit = form.credit_limit ? parseRupees(form.credit_limit) : null;
    if (form.credit_limit && creditLimit === null) { toast.error("Credit limit sirf number me likho."); return; }

    const rate = form.interest_rate ? Number(form.interest_rate) : null;
    if (form.interest_rate && (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100)) {
      toast.error("Interest rate 0 se 100 ke beech hona chahiye.");
      return;
    }

    try {
      await save.mutateAsync({
        id: form.id,
        kind: form.kind,
        label: form.label.trim(),
        institution: form.institution.trim() || null,
        account_last4: form.account_last4 || null,
        balance,
        credit_limit: creditLimit,
        interest_rate: rate,
        maturity_date: form.maturity_date || null,
        notes: form.notes.trim() || null,
      });
      toast.success(form.id ? "Account update ho gaya." : "Account add ho gaya.");
      setOpen(false);
    } catch {
      /* the hook already surfaced the reason */
    }
  };

  const handleDelete = async (a: PersonalAccount) => {
    const ok = await confirm({
      title: `"${a.label}" hata dein?`,
      body: "Is account se judi entries reh jayengi, par unka account link hat jayega.",
      confirmLabel: "Hata do",
      danger: true,
    });
    if (!ok) return;
    await del.mutateAsync(a.id);
    toast.success("Account hata diya.");
  };

  const rows = data ?? [];
  const assets = rows.filter((a) => a.is_active && !isLiabilityAccount(a.kind));
  const debts = rows.filter((a) => a.is_active && isLiabilityAccount(a.kind));
  const closed = rows.filter((a) => !a.is_active);

  const assetTotal = assets.reduce((s, a) => s + a.balance, 0);
  const debtTotal = debts.reduce((s, a) => s + a.balance, 0);

  const isCard = form.kind === "credit_card";
  const isDeposit = form.kind === "fd" || form.kind === "rd";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          Aapke apne bank account, card aur deposit. Company ke bank accounts alag hain.
        </p>
        <Button variant="primary" onClick={openNew} className="flex-shrink-0">
          <Icon name="plus" size={14} className="mr-1.5" />
          Account add karo
        </Button>
      </div>

      {error && <VaultLoadError error={error} />}

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {!isLoading && !error && rows.length === 0 && (
        <Card className="p-6">
          <EmptyState
            icon="wallet"
            title="Abhi koi account nahi"
            body="Apna savings account, credit card ya FD add karo. Ye sirf aapko dikhega."
            action={<Button onClick={openNew}>Pehla account add karo</Button>}
          />
        </Card>
      )}

      {!isLoading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Kul jama</p>
              <div className="mt-0.5"><Money amount={assetTotal} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Card par bakaya</p>
              <div className="mt-0.5">
                <Money amount={debtTotal} size="display" tone={debtTotal > 0 ? "negative" : "default"} autoNegative={false} />
              </div>
            </Card>
          </div>

          {[
            { title: "Jama (assets)", list: assets },
            { title: "Bakaya (cards)", list: debts },
            { title: "Band ho chuke", list: closed },
          ].filter((g) => g.list.length > 0).map((group) => (
            <Card key={group.title} className="p-0 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-hairline bg-paper-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-ink-3">{group.title}</h2>
              </div>
              <ul className="divide-y divide-hairline">
                {group.list.map((a) => (
                  <li key={a.id} className="px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-ink">{a.label}</span>
                        <Badge kind="muted" size="sm">{ACCOUNT_KIND_LABEL[a.kind]}</Badge>
                        {!a.is_active && <Badge kind="muted" size="sm">band</Badge>}
                      </div>
                      <p className="text-xs text-ink-3 mt-0.5">
                        {a.institution || "—"}
                        {a.account_last4 && <span className="font-mono"> ····{a.account_last4}</span>}
                        {a.maturity_date && <> · maturity {formatDate(a.maturity_date)}</>}
                        {a.interest_rate !== null && <> · {a.interest_rate}%</>}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <Money
                        amount={a.balance}
                        size="cell"
                        tone={isLiabilityAccount(a.kind) && a.balance > 0 ? "negative" : "default"}
                        autoNegative={false}
                      />
                      {a.credit_limit !== null && a.credit_limit > 0 && (
                        <p className="text-3xs text-ink-4 mt-0.5">limit ₹{a.credit_limit.toLocaleString("en-IN")}</p>
                      )}
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(a)} aria-label="Edit">
                        <Icon name="edit" size={14} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDelete(a)} aria-label="Delete" className="text-rose">
                        <Icon name="trash" size={14} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{form.id ? "Account edit karo" : "Naya account"}</DialogTitle>
            <DialogDescription className="text-xs">
              Poora account number kabhi mat likho — sirf aakhri 4 digit.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="vb-type" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Type</label>
                <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as AccountKind }))}>
                  <SelectTrigger id="vb-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>{ACCOUNT_KIND_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="vb-balance" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">
                  {isCard ? "Bakaya (₹)" : "Balance (₹)"}
                </label>
                <Input id="vb-balance"
                  value={form.balance}
                  onChange={(e) => setForm((f) => ({ ...f, balance: e.target.value }))}
                  placeholder="0"
                  inputMode="numeric"
                />
              </div>
            </div>

            <div>
              <label htmlFor="vb-name" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Naam</label>
              <Input id="vb-name"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="HDFC Salary / ICICI Amazon Card"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="vb-bank" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Bank</label>
                <Input id="vb-bank"
                  value={form.institution}
                  onChange={(e) => setForm((f) => ({ ...f, institution: e.target.value }))}
                  placeholder="HDFC Bank"
                />
              </div>
              <div>
                <label htmlFor="vb-last4" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Aakhri 4 digit</label>
                <Input id="vb-last4"
                  value={form.account_last4}
                  onChange={(e) => setForm((f) => ({ ...f, account_last4: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                  placeholder="4821"
                  inputMode="numeric"
                  className="font-mono"
                />
              </div>
            </div>

            {isCard && (
              <div>
                <label htmlFor="vb-credit-limit" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Credit limit (₹)</label>
                <Input id="vb-credit-limit"
                  value={form.credit_limit}
                  onChange={(e) => setForm((f) => ({ ...f, credit_limit: e.target.value }))}
                  placeholder="200000"
                  inputMode="numeric"
                />
              </div>
            )}

            {isDeposit && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="vb-interest" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Interest %</label>
                  <Input id="vb-interest"
                    value={form.interest_rate}
                    onChange={(e) => setForm((f) => ({ ...f, interest_rate: e.target.value }))}
                    placeholder="7.1"
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <label htmlFor="vb-maturity" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Maturity</label>
                  <Input id="vb-maturity"
                    type="date"
                    value={form.maturity_date}
                    onChange={(e) => setForm((f) => ({ ...f, maturity_date: e.target.value }))}
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="vb-note" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Note</label>
              <Input id="vb-note"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="optional"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} loading={save.isPending}>
              {form.id ? "Update" : "Add"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
