/**
 * SalaryLinesDialog — turn unmatched salary lines on a bank account into salary
 * records and reconcile them, after the operator has seen exactly what will happen.
 *
 * Auto-reconcile can only MATCH a line to a salary that Payroll already recorded.
 * When salaries were paid from the bank but never entered in Payroll, every salary
 * line sits unmatched. This reads the payee and month from each narration
 * (lib/banking/salary-lines.ts) and proposes, per line:
 *   • reconcile to the existing salary record for that employee + month, or
 *   • create that record (via the Payroll RPC) and reconcile to it, or
 *   • create the employee first, when no one by that name exists.
 * Nothing is written until "Book"; every line can be unticked, re-assigned or moved to
 * another month first. Anything unclear (two employees with the name, no readable
 * name, a month already paid) starts unticked and says why.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, toTitleCase } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useEmployees, useSalaryPayments } from "@/lib/queries/payroll";
import { useBookSalaryLines, type SalaryGroupInput, type SalaryGroupResult } from "@/lib/queries/salary-from-bank";
import { parseSalaryNarration, matchEmployee, titleCaseName, compactName, payeeKey, bestNameVariant, alreadyInPayroll, type AlreadyInPayroll, type SalaryNarration } from "@/lib/banking/salary-lines";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  transactions: BankTransactionRow[];
}

/** "" = not chosen · "create" = create employee from the statement name · else employee id */
type Choice = string;

type Line = { txn: BankTransactionRow; parsed: SalaryNarration };

/* Who a NEW employee is, across lines: the payee account on the narration when there is
   one, else the letters of the name. "HITES H BABU" and "HITESH BA BU" from the same
   account are one person — not two employees (26 Sep 2026: 15 created for 8 people). */
const createKeyOf = (l: Line) => payeeKey(l.txn.description ?? "") ?? `name:${compactName(l.parsed.name ?? "")}`;

/** Unmatched money-out lines that read as salary. */
export function salaryLinesOf(transactions: BankTransactionRow[]): Line[] {
  return transactions.flatMap((txn) => {
    if (txn.matched_to_type !== null || txn.debit <= 0) return [];
    const parsed = parseSalaryNarration(txn.description ?? "", txn.txn_date);
    return parsed ? [{ txn, parsed }] : [];
  });
}

const monthLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};

export function SalaryLinesDialog({ open, onOpenChange, accountId, transactions }: Props) {
  const lines = React.useMemo(() => salaryLinesOf(transactions), [transactions]);
  const { data: employees = [], isLoading: empLoading } = useEmployees();
  const { data: salaries = [] } = useSalaryPayments();
  const book = useBookSalaryLines();

  const [choice, setChoice]   = React.useState<Record<string, Choice>>({});
  const [period, setPeriod]   = React.useState<Record<string, string>>({});
  const [include, setInclude] = React.useState<Record<string, boolean>>({});
  const [results, setResults] = React.useState<SalaryGroupResult[] | null>(null);

  /* Defaults, once employees have loaded — recomputed when the dialog reopens. */
  React.useEffect(() => {
    if (!open || empLoading) return;
    /* Payees already paid from this account before: their earlier salary lines were
       reconciled to a salary record, which names the employee. Same account → same person,
       whatever the statement did to the spelling this time. */
    const known = new Map<string, string>();
    for (const t of transactions) {
      if (t.matched_to_type !== "salary" || !t.matched_to_id) continue;
      const k = payeeKey(t.description ?? "");
      const emp = salaries.find((sp) => sp.id === t.matched_to_id)?.employee_id;
      if (k && emp && employees.some((e) => e.id === emp && e.is_active)) known.set(k, emp);
    }
    const c: Record<string, Choice> = {};
    const p: Record<string, string> = {};
    for (const { txn, parsed } of lines) {
      const k = payeeKey(txn.description ?? "");
      const m = matchEmployee(parsed.name, employees);
      c[txn.id] = (k && known.get(k)) || (m.kind === "match" ? m.id : m.kind === "none" && parsed.name ? "create" : "");
      p[txn.id] = parsed.period;
    }
    setChoice(c);
    setPeriod(p);
    setInclude({});
    setResults(null);
  }, [open, empLoading, lines, employees, salaries, transactions]);

  const activeEmployees = employees.filter((e) => e.is_active);
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? "employee";

  /* The first line (top to bottom) set to create each name — the only one whose
     dropdown says "Create". */
  const firstCreateByName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const x of lines) {
      const key = createKeyOf(x);
      if (choice[x.txn.id] === "create" && (include[x.txn.id] ?? true) && !m.has(key)) m.set(key, x.txn.id);
    }
    return m;
  }, [lines, choice, include]);
  const isFirstCreate = (l: Line) => firstCreateByName.get(createKeyOf(l)) === l.txn.id;

  /* The name a new employee gets: the best spelling among that payee's lines, editable. */
  const [newNames, setNewNames] = React.useState<Record<string, string>>({});
  React.useEffect(() => { if (open) setNewNames({}); }, [open]);
  const newNameFor = (l: Line) => {
    const key = createKeyOf(l);
    return newNames[key] ?? bestNameVariant(lines.filter((x) => createKeyOf(x) === key).map((x) => x.parsed.name ?? ""));
  };

  /* ── Incentive / commission inside a salary transfer ────────────────────────
     A June transfer of ₹70,000 to someone on ₹35,000 was ₹35,000 salary + ₹35,000 deal
     commission. Booked as one ₹70,000 gross it made the monthly salary read double. The part
     above the monthly salary can be marked incentive — payroll's own field, still salary
     for TDS — and is offered (not assumed) when the transfer exceeds the monthly salary. */
  const [incentive, setIncentive] = React.useState<Record<string, string>>({});
  React.useEffect(() => { if (open) setIncentive({}); }, [open]);
  const incentiveOf = (l: Line) => Math.max(0, Math.round(Number(incentive[l.txn.id] || 0)) || 0);
  /** True when booking this line creates a NEW salary record (the only place an incentive applies). */
  const createsRecord = (l: Line) => {
    const c = choice[l.txn.id] ?? "";
    if (c === "create") return true;
    if (c === "") return false;
    const per = period[l.txn.id] ?? l.parsed.period;
    return !salaries.some((sp) => sp.employee_id === c && sp.period === per);
  };
  /** Transfer minus the employee's monthly salary, when it is clearly more (10%+). */
  const suggestedIncentive = (l: Line) => {
    const c = choice[l.txn.id] ?? "";
    const monthly = employees.find((e) => e.id === c)?.monthly_gross ?? 0;
    return monthly > 0 && l.txn.debit > monthly * 1.1 ? l.txn.debit - monthly : 0;
  };

  /** R-1831: this line's month is already in payroll (lib/banking/salary-lines.ts → alreadyInPayroll). */
  const alreadyInPayrollFor = (l: Line): AlreadyInPayroll | null => alreadyInPayroll({
    choice: choice[l.txn.id] ?? "",
    statementName: l.parsed.name,
    period: period[l.txn.id] ?? l.parsed.period,
    amount: l.txn.debit,
    salaries,
    employees,
  });
  const alreadyInPayrollText = (d: AlreadyInPayroll): string => {
    const who = toTitleCase(nameOf(d.employeeId));
    const month = monthLabel(d.period);
    if (d.kind === "paid") return `Already in payroll — ${who}'s ${month} salary is paid. Skipped.`;
    if (d.kind === "other_month") return `Already in payroll — ${who}'s ${month} salary (${rupee(d.remaining)}) is booked and not paid yet. Skipped: set the month to ${month} to link this line to it.`;
    return `Already in payroll — ${who}'s ${month} salary is ${rupee(d.net)}. Skipped: pick ${who} as the employee to link this line to it.`;
  };

  /** What booking this line would do — or why it cannot. */
  const planFor = (l: Line): { ok: boolean; text: string } => {
    const inc = createsRecord(l) ? incentiveOf(l) : 0;
    if (inc >= l.txn.debit && inc > 0) return { ok: false, text: "Incentive must be less than the amount paid — the rest is the salary." };
    const split = inc > 0 ? ` · ${rupee(l.txn.debit - inc)} salary + ${rupee(inc)} incentive` : "";
    const c = choice[l.txn.id] ?? "";
    const per = period[l.txn.id] ?? l.parsed.period;
    if (c === "") {
      const m = matchEmployee(l.parsed.name, employees);
      return { ok: false, text: m.kind === "ambiguous" ? "More than one employee has this name — pick one." : "No name on the line — pick the employee." };
    }
    /* R-1831: never a second record for a month payroll already has. */
    const dup = alreadyInPayrollFor(l);
    if (dup) return { ok: false, text: alreadyInPayrollText(dup) };
    if (c === "create") {
      /* One employee per name, however many lines carry it: only the first line
         creates, the rest say they reuse it. */
      const who = `"${newNameFor(l)}"`;
      const emp = isFirstCreate(l) ? `New employee ${who}` : `Same new employee ${who} as above (not created again)`;
      return { ok: true, text: `${emp} + new ${monthLabel(per)} salary record${split}` };
    }
    const rec = salaries.find((s) => s.employee_id === c && s.period === per);
    if (!rec) return { ok: true, text: `New ${monthLabel(per)} salary record for ${nameOf(c)}${split}` };
    const remaining = rec.net - rec.paid_amount; // a paid record was caught by alreadyInPayroll above
    if (l.txn.debit > remaining) return { ok: false, text: `${monthLabel(per)} record has only ${rupee(remaining)} left to pay.` };
    return { ok: true, text: `Reconcile to existing ${monthLabel(per)} record (${rupee(remaining)} left)` };
  };

  /* A director's salary starts unticked: it is usually remuneration, not payroll. */
  const isOn = (l: Line) => (include[l.txn.id] ?? !l.parsed.director) && planFor(l).ok;
  const selected = lines.filter(isOn);
  const skipped = lines.flatMap((l) => {
    const dup = alreadyInPayrollFor(l);
    return dup ? [{ l, dup }] : [];
  });
  const selectedTotal = selected.reduce((s, l) => s + l.txn.debit, 0);
  const anyCreatesRecord = selected.some((l) => planFor(l).text.includes("New "));

  const onBook = async () => {
    /* One group per employee + month: two transfers for the same month become one
       salary record, which is what Payroll's unique (employee, period) requires. */
    const groups = new Map<string, SalaryGroupInput>();
    for (const l of selected) {
      const c = choice[l.txn.id];
      const per = period[l.txn.id] ?? l.parsed.period;
      const empKey = c === "create" ? `create:${createKeyOf(l)}` : c;
      const key = `${empKey}|${per}`;
      const g = groups.get(key) ?? {
        employee: c === "create"
          ? { createName: newNameFor(l).trim() || titleCaseName(l.parsed.name ?? ""), monthlyGross: l.txn.debit - (createsRecord(l) ? incentiveOf(l) : 0) }
          : { id: c },
        period: per,
        lines: [],
      };
      g.lines.push({ txnId: l.txn.id, txnDate: l.txn.txn_date, amount: l.txn.debit, description: l.txn.description ?? "" });
      if (createsRecord(l) && incentiveOf(l) > 0) g.incentive = (g.incentive ?? 0) + incentiveOf(l);
      groups.set(key, g);
    }

    try {
      setResults(await book.mutateAsync({ accountId, groups: [...groups.values()] }));
    } catch {
      /* hook shows the error */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[640px] md:max-w-[760px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Salary lines → salary records</SheetTitle>
          <SheetDescription>
            Salary transfers found on this account that are not reconciled yet. For each one we
            read the employee and month from the narration — check them, then book. The salary
            record is created the same way Payroll creates it, and the bank line is reconciled to it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {results ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-ink">Result</p>
              {results.map((r, i) => (
                <div key={i} className={`rounded-md border px-3 py-2 text-xs ${r.ok ? "border-emerald/30 bg-emerald-soft/40" : "border-rose/30 bg-rose-soft/40"}`}>
                  <p className="font-medium text-ink flex items-center gap-1.5">
                    <Icon name={r.ok ? "check_circle" : "alert"} size={13} className={r.ok ? "text-emerald" : "text-rose"} />
                    {r.label} · {monthLabel(r.period)}
                  </p>
                  <p className="text-ink-2 mt-0.5">{r.message}</p>
                </div>
              ))}
            </div>
          ) : lines.length === 0 ? (
            <p className="text-sm text-ink-2">No unreconciled salary lines on this account.</p>
          ) : (
            <>
              {activeEmployees.length === 0 && !empLoading && (
                <p className="rounded-md border border-amber/30 bg-amber-soft/40 px-3 py-2 text-xs text-amber-ink">
                  No employees in Payroll yet. Lines with a readable name will create the employee
                  (monthly salary set to the amount paid — edit it later in{" "}
                  <Link href={"/accounting/payroll" as never} className="underline">Payroll</Link>).
                </p>
              )}

              {/* R-1831: say up front which lines will not be booked because payroll has them. */}
              {skipped.length > 0 && (
                <div className="rounded-md border border-hairline bg-paper-2/60 px-3 py-2 text-xs text-ink-2">
                  <p className="font-semibold text-ink">
                    {skipped.length} line{skipped.length === 1 ? "" : "s"} will be skipped — already in payroll
                  </p>
                  <p className="mt-0.5">
                    {skipped.map(({ l, dup }) => `${toTitleCase(nameOf(dup.employeeId))} · ${monthLabel(dup.period)} (${rupee(l.txn.debit)})`).join(" · ")}
                  </p>
                </div>
              )}

              <ul className="divide-y divide-hairline rounded-md border border-hairline">
                {lines.map((l) => {
                  const plan = planFor(l);
                  const on = isOn(l);
                  const c = choice[l.txn.id] ?? "";
                  const per = period[l.txn.id] ?? l.parsed.period;
                  return (
                    <li key={l.txn.id} className={`px-3 py-2.5 ${on ? "" : "bg-paper-2/40"}`}>
                      <div className="flex items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-1 accent-amber"
                          aria-label={`Book ${l.txn.description}`}
                          checked={on}
                          disabled={!plan.ok}
                          onChange={(e) => setInclude((s) => ({ ...s, [l.txn.id]: e.target.checked }))}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-[12px] text-ink truncate" title={l.txn.description ?? ""}>{l.txn.description}</p>
                            <span className="text-[12px] font-semibold tabular-nums text-rose shrink-0">{rupee(l.txn.debit)}</span>
                          </div>
                          <p className="text-xs text-ink-3">{formatDate(l.txn.txn_date)}</p>

                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <select
                              aria-label="Employee"
                              value={c}
                              onChange={(e) => setChoice((s) => ({ ...s, [l.txn.id]: e.target.value }))}
                              className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink max-w-[220px]"
                            >
                              <option value="">— pick employee —</option>
                              {l.parsed.name && (
                                <option value="create">
                                  {c === "create" && !isFirstCreate(l)
                                    ? `${newNameFor(l)} (new, created above)`
                                    : `+ Create “${newNameFor(l)}”`}
                                </option>
                              )}
                              {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                            </select>
                            {/* The statement may have broken the name ("HITES H BABU") — the new
                                employee's name is shown and can be corrected before it is created. */}
                            {c === "create" && isFirstCreate(l) && (
                              <input
                                aria-label="New employee name"
                                value={newNameFor(l)}
                                onChange={(e) => setNewNames((m) => ({ ...m, [createKeyOf(l)]: e.target.value }))}
                                className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink w-[150px]"
                              />
                            )}
                            {createsRecord(l) && (
                              <label className="inline-flex items-center gap-1 text-xs text-ink-3">
                                Incentive ₹
                                <input
                                  aria-label="Incentive / commission in this transfer"
                                  type="number" min={0}
                                  value={incentive[l.txn.id] ?? ""}
                                  placeholder="0"
                                  onChange={(e) => setIncentive((m) => ({ ...m, [l.txn.id]: e.target.value }))}
                                  className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink w-[90px]"
                                />
                              </label>
                            )}
                            {createsRecord(l) && suggestedIncentive(l) > 0 && !incentive[l.txn.id] && (
                              <button
                                type="button"
                                onClick={() => setIncentive((m) => ({ ...m, [l.txn.id]: String(suggestedIncentive(l)) }))}
                                className="text-xs text-amber-ink hover:underline"
                                title="The transfer is more than this employee's monthly salary"
                              >
                                {rupee(suggestedIncentive(l))} more than the monthly salary — incentive / commission?
                              </button>
                            )}
                            <input
                              type="month"
                              aria-label="Salary month"
                              value={per}
                              onChange={(e) => setPeriod((s) => ({ ...s, [l.txn.id]: e.target.value }))}
                              className="rounded border border-hairline bg-paper px-1.5 py-0.5 text-2xs text-ink"
                            />
                            {!l.parsed.periodFromNarration && (
                              <Badge kind="warning" size="sm">month assumed</Badge>
                            )}
                            {l.parsed.fullAndFinal && (
                              <Badge kind="info" size="sm">full &amp; final</Badge>
                            )}
                            {l.parsed.director && (
                              <Badge kind="warning" size="sm" title="Director's remuneration is usually not employee payroll — book it from Reconcile as an expense, category Director's Remuneration.">
                                director
                              </Badge>
                            )}
                          </div>
                          <p className={`mt-1 text-xs ${plan.ok ? "text-ink-3" : "text-rose-ink"}`}>{plan.text}</p>
                          {/* Said in words, not only in a badge that read "director — unticked" even
                              after the operator had ticked it. Ticked, it warns what booking here does. */}
                          {l.parsed.director && (
                            isOn(l) ? (
                              <p className="mt-1 text-xs text-amber-ink leading-snug">
                                The director's payment goes to payroll as <b>staff salary</b> (Salaries, payslip, project salary pool).
                                If this is Director&apos;s Remuneration, untick it and book it from Reconcile — the category is prefilled there.
                              </p>
                            ) : (
                              <p className="mt-1 text-xs text-ink-3 leading-snug">
                                Director's payment — so it is not ticked. Book it from the line's <b>Reconcile</b> (Expense → Director&apos;s Remuneration).
                                Tick it here only for a whole-time director who needs a payslip — and keep the same method all year.
                              </p>
                            )
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {anyCreatesRecord && (
                <p className="text-xs text-ink-3">
                  A new salary record is booked with <b>gross = the amount paid</b> and no TDS / PF / ESI
                  deductions — the bank line only shows the net. If deductions applied, delete the
                  record in Payroll before it is reconciled, or adjust it with your CA.
                </p>
              )}
            </>
          )}
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {results ? "Close" : "Cancel"}
          </Button>
          {!results && (
            <Button
              variant="primary"
              icon="check"
              disabled={selected.length === 0}
              loading={book.isPending}
              onClick={onBook}
            >
              {`Book ${selected.length} line${selected.length === 1 ? "" : "s"} · ${rupee(selectedTotal)}`}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
