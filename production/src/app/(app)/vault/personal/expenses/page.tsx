/**
 * Private Vault → Income & Expenses (R-2387; was "Drawings & Expenses").
 *
 * Every rupee that came in — salary, rent, interest, dividend, business, agriculture, capital
 * gains, gifts, refunds, drawings from the company — and what was spent, with Saved = Income −
 * Spent, a month filter, the FY split by ITR head and a CSV export. The arithmetic lives in
 * lib/vault/personal/income-expense.ts (tested there); this file is the wiring.
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
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  INCOME_SOURCES,
  EXPENSE_FORM_CATEGORIES,
  ITR_HEAD_LABEL,
  summariseIncomeExpense,
  fyMonths,
  inPeriod,
  monthlyDue,
  sourceOf,
  headOf,
  rowLabel,
  isIncomeKind,
  isSpendKind,
  incomeSourceDef,
  kindForSource,
  csvRows,
  CSV_HEADERS,
  type IncomeSource,
  type LedgerRow,
  type MonthlyDue,
} from "@/lib/vault/personal/income-expense";
import { downloadCSV } from "@/lib/csv";
import { formatDate, rupee } from "@/lib/utils";
// "Today" is the IST day (R-1609), not the browser's — a laptop on another timezone used to
// pre-fill yesterday's date.
import { fyStartISO, fyLabel, istToday, istMonth, formatMonthLabel } from "@/lib/dates/ist";
import { parseRupees, MAX_RUPEES } from "@/lib/vault/personal/parse-rupees";
import { PersonPicker } from "@/components/features/vault/person-picker";

/** income / expense / drawing are the three buttons; "other" keeps an imported transfer's kind. */
type Mode = "income" | "expense" | "drawing" | "other";

type Row = PersonalTransaction & LedgerRow & { id: string };

interface FormState {
  id?: string;
  mode: Mode;
  /** Only for mode "other": the row's own kind (transfer_in, card_payment …). */
  kind: string;
  source: IncomeSource;
  amount: string;
  occurred_on: string;
  category: string;
  account_id: string;
  party: string;
  /** R-2392: the picked person (People); null = typed text or nobody. */
  contact_id: string | null;
  note: string;
  repeat: boolean;
}

const MODE_TITLE: Record<Mode, string> = {
  income: "income",
  expense: "expense",
  drawing: "drawing (from company)",
  other: "entry",
};

/**
 * R-2111: the amount goes through parse-rupees.ts (R-1419) — the old local parser had no
 * upper limit, so a 25-digit amount reached the bigint column as "1e+24" and came back as a
 * Postgres error. The message sits under the field, not in a toast.
 */
function checkAmount(input: string): { value: number } | { problem: string } {
  const p = parseRupees(input);
  if (!p.ok) {
    return {
      problem: p.reason === "too_big"
        ? `Too large — up to ${rupee(MAX_RUPEES)} (₹1 lakh crore). Check for extra zeros.`
        : "Type a whole amount in digits, like 1250 or 1,250. No minus sign.",
    };
  }
  if (p.value <= 0) return { problem: "Enter an amount above 0." };
  return { value: p.value };
}

function blankForm(mode: Mode): FormState {
  return {
    mode,
    kind: mode === "drawing" ? "drawing" : mode === "expense" ? "expense" : "salary",
    source: "salary",
    amount: "",
    occurred_on: istToday(),
    category: "",
    account_id: "",
    party: "",
    contact_id: null,
    note: "",
    // salary is the first source and comes every month
    repeat: mode === "income",
  };
}

function modeOf(kind: string): Mode {
  if (kind === "drawing") return "drawing";
  if (isIncomeKind(kind)) return "income";
  if (isSpendKind(kind)) return "expense";
  return "other";
}

function formFromRow(t: LedgerRow & { id?: string }): FormState {
  const s = sourceOf(t);
  return {
    id: t.id,
    mode: modeOf(t.kind),
    kind: t.kind,
    source: s && s !== "drawing" ? s : "salary",
    amount: String(t.amount),
    occurred_on: t.occurred_on,
    category: t.category ?? "",
    account_id: t.account_id ?? "",
    party: t.party ?? "",
    contact_id: (t as { contact_id?: string | null }).contact_id ?? null,
    note: t.note ?? "",
    repeat: Boolean(t.repeat_monthly),
  };
}

const LABEL = "block text-2xs uppercase tracking-wide text-ink-3 mb-1";

export default function PersonalExpensesPage() {
  const { data, isLoading, error } = usePersonalTransactions(2000);
  const accountsQ = usePersonalAccounts(true);
  const save = useSavePersonalTransaction();
  const del = useDeletePersonalTransaction();
  const confirm = useConfirm();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(() => blankForm("expense"));
  const [dialogTitle, setDialogTitle] = React.useState("New entry");
  const [amountIssue, setAmountIssue] = React.useState<string | null>(null);

  const rows = React.useMemo(() => (data ?? []) as Row[], [data]);
  const accounts = React.useMemo(() => accountsQ.data ?? [], [accountsQ.data]);
  const accountLabel = React.useMemo(() => new Map(accounts.map((a) => [a.id, a.label])), [accounts]);
  // R-2111: a closed account is not offered for new entries; an old entry already linked to
  // one keeps it, so editing it does not silently drop the link.
  const pickableAccounts = React.useMemo(
    () => accounts.filter((a) => a.is_active || a.id === form.account_id),
    [accounts, form.account_id],
  );

  // IST, not the browser's clock (R-1609). The FY picker offers this FY and any FY with entries.
  const currentFy = React.useMemo(() => fyStartISO(new Date()), []);
  const fyOptions = React.useMemo(() => {
    const set = new Set<string>([currentFy]);
    for (const t of rows) set.add(fyStartISO(t.occurred_on));
    return [...set].sort().reverse();
  }, [rows, currentFy]);
  const [fy, setFy] = React.useState(currentFy);
  const [month, setMonth] = React.useState<string>("all");

  const fyRows = React.useMemo(() => inPeriod(rows, fy, null), [rows, fy]);
  const periodRows = React.useMemo(() => (month === "all" ? fyRows : inPeriod(rows, fy, month)), [rows, fyRows, fy, month]);
  const period = React.useMemo(() => summariseIncomeExpense(periodRows), [periodRows]);
  const fySummary = React.useMemo(() => summariseIncomeExpense(fyRows), [fyRows]);
  const drawn = period.bySource.find((s) => s.source === "drawing")?.total ?? 0;
  const thisMonth = istMonth();
  const due = React.useMemo(() => monthlyDue(rows, thisMonth), [rows, thisMonth]);

  const periodLabel = month === "all" ? `FY ${fyLabel(fy)}` : formatMonthLabel(month, { month: "long" });

  const openNew = (mode: Mode) => {
    setForm(blankForm(mode));
    setDialogTitle(`New ${MODE_TITLE[mode]}`);
    setAmountIssue(null);
    setOpen(true);
  };

  const openEdit = (t: Row) => {
    const f = formFromRow(t);
    setForm(f);
    setDialogTitle(f.mode === "other" ? rowLabel(t) : `Edit ${MODE_TITLE[f.mode]}`);
    setAmountIssue(null);
    setOpen(true);
  };

  /** "Add this month's": the series' last entry, copied onto this month's date — reviewed, then Add. */
  const openDue = (d: MonthlyDue) => {
    setForm({ ...formFromRow({ ...d.from, id: undefined }), occurred_on: d.date, repeat: true });
    setDialogTitle(`This month's ${d.label}`);
    setAmountIssue(null);
    setOpen(true);
  };

  const handleSave = async () => {
    const checked = checkAmount(form.amount);
    if ("problem" in checked) { setAmountIssue(checked.problem); return; }
    setAmountIssue(null);
    if (!form.occurred_on) { toast.error("Pick a date.", { description: "Choose the day of this entry, then save." }); return; }

    const kind = form.mode === "income" ? kindForSource(form.source)
      : form.mode === "expense" ? "expense"
      : form.mode === "drawing" ? "drawing"
      : form.kind;

    try {
      await save.mutateAsync({
        id: form.id,
        // database.types.ts still patches kind to the six pre-gp12a values; the DB CHECK
        // (gp12a) also allows refund / transfer_* / card_payment / atm_cash, which an income
        // refund or an imported row being edited carries.
        kind: kind as PersonalTransaction["kind"],
        amount: checked.value,
        occurred_on: form.occurred_on,
        // The source only on income, the category only on spending — never "Salary" next to
        // "Groceries" in the same breakdown. An imported transfer keeps its own category.
        income_source: form.mode === "income" ? form.source : null,
        category: form.mode === "expense" || form.mode === "other" ? (form.category || null) : null,
        account_id: form.account_id || null,
        party: form.party.trim().slice(0, 120) || null,
        contact_id: form.party.trim() ? form.contact_id : null,
        note: form.note.trim() || null,
        repeat_monthly: form.mode === "other" ? false : form.repeat,
      });
      toast.success(form.id ? "Entry updated." : "Entry added.");
      setOpen(false);
    } catch { /* the hook surfaced it */ }
  };

  const handleDelete = async (t: Row) => {
    const ok = await confirm({
      title: "Remove this entry?",
      body: `${rowLabel(t)} · ₹${t.amount.toLocaleString("en-IN")} · ${formatDate(t.occurred_on)}`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(t.id);
      toast.success("Entry removed.");
    } catch {
      /* R-2111: the hook already showed why (toastError); only keep the promise from going unhandled */
    }
  };

  const exportCsv = () => {
    const slug = month === "all" ? `fy-${fy.slice(0, 4)}` : month;
    downloadCSV(`personal-income-expenses-${slug}.csv`, CSV_HEADERS, csvRows(periodRows, (id) => accountLabel.get(id)));
  };

  const sourceDef = incomeSourceDef(form.source);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-ink-3">
          Money that came in from every source, and what you spent — your own record.
        </p>
        <div className="flex gap-2 flex-shrink-0 flex-wrap">
          <Button variant="outline" onClick={() => openNew("income")}>
            <Icon name="plus" size={14} className="mr-1.5" />
            Income
          </Button>
          <Button onClick={() => openNew("expense")} className="bg-primary text-white">
            <Icon name="plus" size={14} className="mr-1.5" />
            Expense
          </Button>
          <Button variant="outline" onClick={() => openNew("drawing")}>
            <Icon name="arrow_down" size={14} className="mr-1.5" />
            Drawing (from company)
          </Button>
        </div>
      </div>

      {/* The one-way wall, said once and plainly. */}
      <div className="rounded-lg border border-hairline bg-paper-2 p-3 flex gap-2.5">
        <Icon name="info" size={15} className="text-ink-3 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-ink-2 leading-relaxed">
          Recording a drawing here changes <b>nothing</b> in the company books. This is only your own
          record. The actual drawing must be entered separately in the company books — otherwise the balance sheet
          and bank reconciliation will not match.
        </p>
      </div>

      {error && <VaultLoadError error={error} />}

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {!isLoading && !error && (
        <>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="w-40">
              <label htmlFor="ve-fy" className={LABEL}>Financial year</label>
              <Select value={fy} onValueChange={(v) => { setFy(v); setMonth("all"); }}>
                <SelectTrigger id="ve-fy"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {fyOptions.map((f) => <SelectItem key={f} value={f}>FY {fyLabel(f)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-44">
              <label htmlFor="ve-month" className={LABEL}>Month</label>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger id="ve-month"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Whole year</SelectItem>
                  {fyMonths(fy).map((m) => <SelectItem key={m} value={m}>{formatMonthLabel(m, { month: "long" })}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto">
              <Button variant="outline" onClick={exportCsv} disabled={periodRows.length === 0}>
                <Icon name="download" size={14} className="mr-1.5" />
                Export CSV
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-3">Income · {periodLabel}</p>
              <div className="mt-0.5"><Money amount={period.income} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-3">Spent</p>
              <div className="mt-0.5"><Money amount={period.spent} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-3">Saved (income − spent)</p>
              <div className="mt-0.5"><Money amount={period.saved} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-3">Of which from company</p>
              <div className="mt-0.5"><Money amount={drawn} size="display" /></div>
            </Card>
          </div>

          {due.length > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-medium text-ink">Monthly entries not added for {formatMonthLabel(thisMonth, { month: "long" })}</h2>
              <ul className="mt-2 space-y-1.5">
                {due.map((d) => (
                  <li key={`${d.from.id}-${d.date}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink-2 min-w-0 truncate">
                      {d.label} <span className="text-ink-3 text-xs">· last {rupee(d.from.amount)} on {formatDate(d.from.occurred_on)}</span>
                    </span>
                    <Button size="sm" variant="outline" onClick={() => openDue(d)}>Add this month&apos;s</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {(period.bySource.length > 0 || period.byCategory.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card className="p-5">
                <h2 className="text-sm font-medium text-ink">Income by source</h2>
                {period.bySource.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-3">No income in this period.</p>
                ) : (
                  <ul className="mt-3 space-y-1.5">
                    {period.bySource.map((s) => (
                      <li key={s.source} className="flex items-baseline justify-between text-sm">
                        <span className="text-ink-2">{s.label} <span className="text-ink-3 text-xs">· {s.count}</span></span>
                        <Money amount={s.total} size="cell" />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card className="p-5">
                <h2 className="text-sm font-medium text-ink">Spent by category</h2>
                {period.byCategory.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-3">No spending in this period.</p>
                ) : (
                  <ul className="mt-3 space-y-1.5">
                    {period.byCategory.slice(0, 10).map((c) => (
                      <li key={c.category} className="flex items-baseline justify-between text-sm">
                        <span className="text-ink-2">{c.category} <span className="text-ink-3 text-xs">· {c.count}</span></span>
                        <Money amount={c.total} size="cell" />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}

          {fySummary.byHead.length > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-medium text-ink">FY {fyLabel(fy)} income by ITR head</h2>
              <p className="text-xs text-ink-3 mt-0.5">For your tax return — the whole year, whatever month is picked above.</p>
              <ul className="mt-3 space-y-1.5">
                {fySummary.byHead.map((h) => (
                  <li key={h.head} className="flex items-baseline justify-between text-sm">
                    <span className="text-ink-2">{h.label}</span>
                    <Money amount={h.total} size="cell" />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {rows.length === 0 ? (
            <Card className="p-6">
              <EmptyState
                icon="receipt"
                title="No entries yet"
                body="Add your income from any source, an expense, or money taken from the company."
                action={<Button onClick={() => openNew("expense")}>Add first entry</Button>}
              />
            </Card>
          ) : periodRows.length === 0 ? (
            <Card className="p-6 text-center text-sm text-ink-3">No entries in {periodLabel}.</Card>
          ) : (
            <Card className="p-0 overflow-hidden">
              <ul className="divide-y divide-hairline">
                {periodRows.map((t) => {
                  const income = isIncomeKind(t.kind);
                  const spend = isSpendKind(t.kind);
                  const s = sourceOf(t);
                  return (
                    <li key={t.id} className="px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge kind={income ? "success" : "muted"} size="sm">{spend ? "Expense" : rowLabel(t)}</Badge>
                          {spend && t.category && <span className="text-xs text-ink-2">{t.category}</span>}
                          {s && <span className="text-xs text-ink-3">{ITR_HEAD_LABEL[headOf(s)]}</span>}
                          {t.repeat_monthly && <span className="text-xs text-ink-3">· monthly</span>}
                        </div>
                        <p className="text-xs text-ink-3 mt-0.5">
                          {formatDate(t.occurred_on)}
                          {t.account_id && <> · {accountLabel.get(t.account_id) ?? "account"}</>}
                          {t.party && <> · {t.party}</>}
                          {t.note && <> · {t.note}</>}
                        </p>
                      </div>
                      <div className="flex-shrink-0">
                        <span className={income ? "text-emerald text-sm font-medium" : spend ? "text-ink text-sm font-medium" : "text-ink-3 text-sm"}>
                          {income ? "+" : spend ? "−" : ""}₹{t.amount.toLocaleString("en-IN")}
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
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {form.mode === "income" && (
              <div>
                <label htmlFor="ve-source" className={LABEL}>Source</label>
                <Select
                  value={form.source}
                  onValueChange={(v) => setForm((f) => ({
                    ...f,
                    source: v as IncomeSource,
                    // salary and rent come every month — tick it for them on a new entry
                    repeat: f.id ? f.repeat : Boolean(incomeSourceDef(v)?.monthly),
                  }))}
                >
                  <SelectTrigger id="ve-source"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INCOME_SOURCES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {sourceDef && (
                  <p className="mt-1 text-xs text-ink-3">ITR head: {ITR_HEAD_LABEL[sourceDef.head]}</p>
                )}
              </div>
            )}

            {form.mode === "expense" && (
              <div>
                <label htmlFor="ve-category" className={LABEL}>Category</label>
                <Select
                  value={form.category || "none"}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v === "none" ? "" : v }))}
                >
                  <SelectTrigger id="ve-category"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    {/* an old row's own category stays pickable even when it is not on the list */}
                    {form.category && !EXPENSE_FORM_CATEGORIES.includes(form.category) && (
                      <SelectItem value={form.category}>{form.category}</SelectItem>
                    )}
                    {EXPENSE_FORM_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ve-amount" className={LABEL}>Amount (₹)</label>
                <Input id="ve-amount"
                  value={form.amount}
                  onChange={(e) => { setForm((f) => ({ ...f, amount: e.target.value })); setAmountIssue(null); }}
                  placeholder="50000"
                  inputMode="numeric"
                  aria-invalid={amountIssue ? true : undefined}
                  aria-describedby={amountIssue ? "ve-amount-error" : undefined}
                />
                {amountIssue && (
                  <p id="ve-amount-error" role="alert" className="mt-1 text-xs text-rose">{amountIssue}</p>
                )}
              </div>
              <div>
                <label htmlFor="ve-date" className={LABEL}>Date</label>
                <Input id="ve-date"
                  type="date"
                  value={form.occurred_on}
                  onChange={(e) => setForm((f) => ({ ...f, occurred_on: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ve-account" className={LABEL}>{form.mode === "expense" ? "Paid from" : "Account"}</label>
                <Select
                  value={form.account_id || "none"}
                  onValueChange={(v) => setForm((f) => ({ ...f, account_id: v === "none" ? "" : v }))}
                >
                  <SelectTrigger id="ve-account"><SelectValue placeholder="Cash" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Cash / none</SelectItem>
                    {pickableAccounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="ve-party" className={LABEL}>{form.mode === "expense" ? "Paid to" : "Received from"}</label>
                <PersonPicker id="ve-party" allowText
                  value={{ contactId: form.contact_id, name: form.party }}
                  onChange={(v) => setForm((f) => ({ ...f, party: v.name, contact_id: v.contactId }))}
                  placeholder={form.mode === "income" ? "Employer, tenant, a person…" : "Optional — shop or person"}
                />
              </div>
            </div>

            <div>
              <label htmlFor="ve-note" className={LABEL}>Note</label>
              <Input id="ve-note"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="optional"
              />
            </div>

            {form.mode !== "other" && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="ve-repeat"
                  checked={form.repeat}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, repeat: v === true }))}
                  className="mt-0.5"
                />
                <label htmlFor="ve-repeat" className="text-sm text-ink-2">
                  Repeats every month
                  <span className="block text-xs text-ink-3">Next month this screen offers &quot;Add this month&apos;s&quot; — nothing is added by itself.</span>
                </label>
              </div>
            )}
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
