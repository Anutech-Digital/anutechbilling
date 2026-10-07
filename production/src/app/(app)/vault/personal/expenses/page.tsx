/**
 * Private Vault → Drawings & Expenses.
 *
 * Money the owner took OUT of the business, and what they spent personally.
 *
 * ─── RECORDING A DRAWING HERE BOOKS NOTHING IN THE COMPANY ──────────────────
 * That is a deliberate one-way wall, and it is the most important rule on this screen.
 * The company's books are reconciled against bank statements and feed the P&L, the
 * balance sheet and eventually a GST return. If a private note on this page could move
 * any of those, then one person's memory of what they withdrew would be silently
 * rewriting the company's accounts — with no bank line, no approval and no audit trail.
 *
 * So this is the owner's own record, kept for their own clarity. A real drawing still has
 * to be entered in the company's books the normal way, and the screen says so rather than
 * letting somebody assume it was handled.
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import {
  usePersonalTransactions,
  useSavePersonalTransaction,
  useDeletePersonalTransaction,
  usePersonalAccounts,
  type PersonalTransaction,
} from "@/lib/queries/personal-vault";
import { summariseCashFlow, PERSONAL_EXPENSE_CATEGORIES } from "@/lib/vault/personal/net-worth";
import { formatDate } from "@/lib/utils";

type TxKind = PersonalTransaction["kind"];

const KIND_LABEL: Record<TxKind, string> = {
  drawing: "Drawing (company se)",
  dividend: "Dividend",
  salary: "Salary",
  interest: "Interest",
  other_income: "Aur koi income",
  expense: "Kharcha",
};

const INCOME_KINDS: TxKind[] = ["drawing", "dividend", "salary", "interest", "other_income"];

interface FormState {
  id?: string;
  kind: TxKind;
  amount: string;
  occurred_on: string;
  category: string;
  account_id: string;
  note: string;
}

function todayIso(): string {
  // Stored verbatim as YYYY-MM-DD. Converting through UTC is how "aaj" becomes "kal"
  // for an IST user — the same trap lib/leads/inline-edit.ts already documents.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseRupees(value: string): number | null {
  const cleaned = value.replace(/[,\s₹]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Math.round(Number(cleaned));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default function PersonalExpensesPage() {
  const { data, isLoading, error } = usePersonalTransactions(500);
  const accountsQ = usePersonalAccounts(true);
  const save = useSavePersonalTransaction();
  const del = useDeletePersonalTransaction();
  const confirm = useConfirm();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>({
    kind: "expense", amount: "", occurred_on: todayIso(), category: "", account_id: "", note: "",
  });

  // Memoised because both feed useMemo dependency arrays below; a fresh [] on every
  // render would recompute the whole FY summary on every keystroke in the dialog.
  const rows = React.useMemo(() => data ?? [], [data]);
  const accounts = React.useMemo(() => accountsQ.data ?? [], [accountsQ.data]);
  const accountLabel = React.useMemo(
    () => new Map(accounts.map((a) => [a.id, a.label])),
    [accounts],
  );

  const fyStart = React.useMemo(() => {
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-04-01`;
  }, []);

  const flow = React.useMemo(
    () => summariseCashFlow(rows.filter((t) => t.occurred_on >= fyStart)),
    [rows, fyStart],
  );

  const openNew = (kind: TxKind) => {
    setForm({ kind, amount: "", occurred_on: todayIso(), category: "", account_id: "", note: "" });
    setOpen(true);
  };

  const openEdit = (t: PersonalTransaction) => {
    setForm({
      id: t.id,
      kind: t.kind,
      amount: String(t.amount),
      occurred_on: t.occurred_on,
      category: t.category ?? "",
      account_id: t.account_id ?? "",
      note: t.note ?? "",
    });
    setOpen(true);
  };

  const handleSave = async () => {
    const amount = parseRupees(form.amount);
    if (amount === null) { toast.error("Enter an amount above 0.", { description: "Numbers only — no commas or ₹ sign, e.g. 1250." }); return; }
    if (!form.occurred_on) { toast.error("Pick a date.", { description: "Choose the day this expense happened, then save." }); return; }

    try {
      await save.mutateAsync({
        id: form.id,
        kind: form.kind,
        amount,
        occurred_on: form.occurred_on,
        // Category only means something for spending; on income it would put "Salary"
        // next to "Groceries" in the breakdown.
        category: form.kind === "expense" ? (form.category || null) : null,
        account_id: form.account_id || null,
        note: form.note.trim() || null,
      });
      toast.success(form.id ? "Entry update ho gayi." : "Entry add ho gayi.");
      setOpen(false);
    } catch { /* the hook surfaced it */ }
  };

  const handleDelete = async (t: PersonalTransaction) => {
    const ok = await confirm({
      title: "Ye entry hata dein?",
      body: `${KIND_LABEL[t.kind]} · ₹${t.amount.toLocaleString("en-IN")} · ${formatDate(t.occurred_on)}`,
      confirmLabel: "Hata do",
      danger: true,
    });
    if (!ok) return;
    await del.mutateAsync(t.id);
    toast.success("Entry hata di.");
  };

  const isIncome = INCOME_KINDS.includes(form.kind);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-ink-3">
          Company se nikala hua paisa aur ghar ke kharche — aapka apna record.
        </p>
        <div className="flex gap-2 flex-shrink-0">
          <Button variant="outline" onClick={() => openNew("drawing")}>
            <Icon name="arrow_down" size={14} className="mr-1.5" />
            Drawing
          </Button>
          <Button onClick={() => openNew("expense")} className="bg-primary text-white">
            <Icon name="plus" size={14} className="mr-1.5" />
            Kharcha
          </Button>
        </div>
      </div>

      {/* The one-way wall, said once and plainly. */}
      <div className="rounded-lg border border-hairline bg-paper-2 p-3 flex gap-2.5">
        <Icon name="info" size={15} className="text-ink-3 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-ink-2 leading-relaxed">
          Yahan drawing likhne se company ki books me <b>kuch nahi</b> hota. Ye sirf aapka apna
          hisaab hai. Asli drawing company ke books me alag se aani chahiye — warna balance sheet
          aur bank reconcile nahi milenge.
        </p>
      </div>

      {error && <VaultLoadError error={error} />}

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {!isLoading && !error && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Company se (is FY)</p>
              <div className="mt-0.5"><Money amount={flow.drawnFromCompany} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Kul aaya</p>
              <div className="mt-0.5"><Money amount={flow.moneyIn} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Kharch hua</p>
              <div className="mt-0.5"><Money amount={flow.moneyOut} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Bacha</p>
              <div className="mt-0.5"><Money amount={flow.net} size="display" /></div>
            </Card>
          </div>

          {flow.byCategory.length > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-medium text-ink">Kharche kis cheez par (is FY)</h2>
              <ul className="mt-3 space-y-1.5">
                {flow.byCategory.slice(0, 8).map((c) => (
                  <li key={c.category} className="flex items-baseline justify-between text-sm">
                    <span className="text-ink-2">{c.category} <span className="text-ink-4 text-xs">· {c.count}</span></span>
                    <Money amount={c.total} size="cell" />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {rows.length === 0 ? (
            <Card className="p-6">
              <EmptyState
                icon="receipt"
                title="Abhi koi entry nahi"
                body="Company se nikala paisa ya ghar ka kharcha add karo."
                action={<Button onClick={() => openNew("drawing")}>Pehli entry</Button>}
              />
            </Card>
          ) : (
            <Card className="p-0 overflow-hidden">
              <ul className="divide-y divide-hairline">
                {rows.map((t) => {
                  const income = INCOME_KINDS.includes(t.kind);
                  return (
                    <li key={t.id} className="px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge kind={income ? "success" : "muted"} size="sm">{KIND_LABEL[t.kind]}</Badge>
                          {t.category && <span className="text-xs text-ink-2">{t.category}</span>}
                        </div>
                        <p className="text-xs text-ink-3 mt-0.5">
                          {formatDate(t.occurred_on)}
                          {t.account_id && <> · {accountLabel.get(t.account_id) ?? "account"}</>}
                          {t.note && <> · {t.note}</>}
                        </p>
                      </div>
                      <div className="flex-shrink-0">
                        <span className={income ? "text-emerald text-sm font-medium" : "text-ink text-sm font-medium"}>
                          {income ? "+" : "−"}₹{t.amount.toLocaleString("en-IN")}
                        </span>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(t)} aria-label="Edit">
                          <Icon name="edit" size={14} />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(t)} aria-label="Delete" className="text-rose">
                          <Icon name="trash" size={14} />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{form.id ? "Entry edit karo" : "Nayi entry"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ve-type" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Type</label>
                <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as TxKind }))}>
                  <SelectTrigger id="ve-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABEL) as TxKind[]).map((k) => (
                      <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="ve-amount" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Amount (₹)</label>
                <Input id="ve-amount"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder="50000"
                  inputMode="numeric"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ve-date" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Date</label>
                <Input id="ve-date"
                  type="date"
                  value={form.occurred_on}
                  onChange={(e) => setForm((f) => ({ ...f, occurred_on: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="ve-account" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Account</label>
                <Select
                  value={form.account_id || "none"}
                  onValueChange={(v) => setForm((f) => ({ ...f, account_id: v === "none" ? "" : v }))}
                >
                  <SelectTrigger id="ve-account"><SelectValue placeholder="Cash" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Cash / koi nahi</SelectItem>
                    {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!isIncome && (
              <div>
                <label htmlFor="ve-category" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Kis cheez par</label>
                <Select
                  value={form.category || "none"}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v === "none" ? "" : v }))}
                >
                  <SelectTrigger id="ve-category"><SelectValue placeholder="Chuno" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nahi bataya</SelectItem>
                    {PERSONAL_EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <label htmlFor="ve-note" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Note</label>
              <Input id="ve-note"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
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
