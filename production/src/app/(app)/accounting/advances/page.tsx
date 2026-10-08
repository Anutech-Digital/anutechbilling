/**
 * /accounting/advances — Employee Expense Advances & Petty Cash Management.
 *
 * Allows company owners/accountants to:
 * 1. Disburse advance money to employees for official expenses (Travel, Client Meetings, Maintenance).
 * 2. Record expenses incurred by employees against their advance balance (Hits P&L as Expense & reduces available advance).
 * 3. Track real-time remaining advance balance & settle completed advances.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FormField } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import {
  useEmployeeAdvances,
  useDisburseAdvance,
  useTopUpAdvance,
  useSettleAdvance,
  useUpdateAdvance,
  useDeleteAdvance,
  ADVANCE_PAYMENT_METHODS,
  type EmployeeAdvance,
} from "@/lib/queries/advances";
import { useEmployees } from "@/lib/queries/payroll";
import { useBankAccounts } from "@/lib/queries/bank";
import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { getBillAttachmentUrl } from "@/lib/queries/vendor-bills";
import { toast } from "sonner";
import { istToday } from "@/lib/dates/ist";

function todayISO() {
  return istToday();
}

export default function EmployeeAdvancesPage() {
  const { data: advances = [], isLoading } = useEmployeeAdvances();
  const [disburseOpen, setDisburseOpen] = React.useState(false);
  /* ?give=1&name=&amount=&date=&method=&purpose= opens Give advance filled — AI Entry sends
     "Prashant ko kharche ke liye 5000 advance" straight here (2 Oct 2026). Read once after
     mount, then dropped from the URL so a refresh does not reopen it. */
  const [prefill, setPrefill] = React.useState<AdvancePrefill | null>(null);
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("give") !== "1") return;
    setPrefill({
      name: q.get("name") ?? "", amount: q.get("amount") ?? "", date: q.get("date") ?? "",
      method: q.get("method") ?? "", purpose: q.get("purpose") ?? "",
    });
    setDisburseOpen(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const [recordExpenseFor, setRecordExpenseFor] = React.useState<EmployeeAdvance | null>(null);
  const [topUpFor, setTopUpFor] = React.useState<EmployeeAdvance | null>(null);

  async function openBill(path: string) {
    try {
      const url = await getBillAttachmentUrl(path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast.error("Could not open the bill", { description: "Try again in a moment." });
    } catch { toast.error("Could not open the bill", { description: "Try again in a moment." }); }
  }
  const [settleFor, setSettleFor] = React.useState<EmployeeAdvance | null>(null);
  const [editFor, setEditFor] = React.useState<EmployeeAdvance | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<EmployeeAdvance | null>(null);

  const activeAdvances = advances.filter((a) => a.status === "active");
  /* The API calls a settled advance "closed" (my-advances route); this list looked for
     "settled" and so never showed one (4 Oct 2026). */
  const settledAdvances = advances.filter((a) => a.status !== "active");

  const totalDisbursedActive = activeAdvances.reduce((sum, a) => sum + a.disbursed_amount, 0);
  const totalSpentActive = activeAdvances.reduce((sum, a) => sum + a.total_spent, 0);
  const totalOutstandingBalance = activeAdvances.reduce((sum, a) => sum + a.remaining_balance, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">HR &amp; Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Employee Expense Advances</h1>
          <p className="text-sm text-ink-3 mt-1">
            Manage advance money given to employees for company expenses + track expenses booked against advance balances.
          </p>
        </div>

        <Button variant="primary" icon="plus" onClick={() => setDisburseOpen(true)}>
          Give Advance to Employee
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 border-l-4 border-l-amber">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Advance Money in Hands of Employees</p>
          <p className="font-serif text-3xl text-amber-ink mt-1">{rupee(totalOutstandingBalance)}</p>
          <p className="text-xs text-ink-3 mt-1">{activeAdvances.length} active employee advances</p>
        </Card>

        <Card className="p-5 border-l-4 border-l-indigo">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total Disbursed Advances</p>
          <p className="font-serif text-3xl text-indigo mt-1">{rupee(totalDisbursedActive)}</p>
          <p className="text-xs text-ink-3 mt-1">Total cash/bank given for expenses</p>
        </Card>

        <Card className="p-5 border-l-4 border-l-emerald">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Booked P&amp;L Expenses</p>
          <p className="font-serif text-3xl text-emerald mt-1">{rupee(totalSpentActive)}</p>
          <p className="text-xs text-ink-3 mt-1">Expenses adjusted &amp; recorded in P&amp;L</p>
        </Card>
      </div>

      {/* Active Advances List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-xl">Active Employee Advances</h2>
          <span className="text-xs text-ink-3 font-medium">{activeAdvances.length} active</span>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
          </div>
        ) : activeAdvances.length === 0 ? (
          <Card className="py-10 text-center">
            <EmptyState
              icon="wallet"
              title="No Active Employee Advances"
              body="When you give advance money to employees for travel, client meetings, or office expenses, click 'Give Advance to Employee' above."
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {activeAdvances.map((adv) => (
              <Card key={adv.id} className="p-5 space-y-4 hover:shadow-md transition-all">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-hairline">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-lg text-ink">{adv.employee_name}</span>
                      <Badge kind="warning" size="sm">Active Advance</Badge>
                    </div>
                    <p className="text-xs text-ink-3">
                      Purpose: <strong className="text-ink-2">{adv.purpose || "Official Company Expenses"}</strong> · Disbursed on {formatDate(adv.disbursed_date, "short")} via {ADVANCE_PAYMENT_METHODS[adv.payment_method] || adv.payment_method}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="primary"
                      className="gap-1.5"
                      onClick={() => setRecordExpenseFor(adv)}
                    >
                      <Icon name="plus" size={14} />
                      Record expense
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setTopUpFor(adv)}
                    >
                      Top-up
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSettleFor(adv)}
                    >
                      Settle
                    </Button>

                    <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditFor(adv)} aria-label={`Edit advance for ${adv.employee_name}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" icon="trash" className="text-red-ink" onClick={() => setDeleteFor(adv)} aria-label={`Delete advance for ${adv.employee_name}`}>
                      Delete
                    </Button>
                  </div>
                </div>

                {/* Balance Progress Bar */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-paper-2/50 p-3 rounded-lg border border-hairline">
                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Disbursed Advance</p>
                    <p className="font-serif text-lg text-ink font-semibold">{rupee(adv.disbursed_amount)}</p>
                  </div>

                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Total Spent &amp; Booked in P&amp;L</p>
                    <p className="font-serif text-lg text-emerald font-semibold">{rupee(adv.total_spent)}</p>
                  </div>

                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Remaining Advance in Hand</p>
                    <p className="font-serif text-lg text-amber-ink font-bold">{rupee(adv.remaining_balance)}</p>
                  </div>
                </div>

                {/* Linked Expenses Breakdown */}
                {adv.linked_expenses.length > 0 && (
                  <div className="pt-2">
                    <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                      Expenses Claimed &amp; Adjusted ({adv.linked_expenses.length})
                    </p>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {adv.linked_expenses.map((exp) => (
                        <div key={exp.id} className="flex items-center justify-between p-2.5 bg-paper rounded border border-hairline text-xs">
                          <div className="space-y-0.5">
                            <span className="font-semibold text-ink">{exp.category}</span>
                            {exp.description && <p className="text-ink-3 text-xs">{exp.description}</p>}
                            <span className="text-xs text-ink-3">{formatDate(exp.expense_date, "short")} {exp.vendor_name ? `· Vendor: ${exp.vendor_name}` : ""}</span>
                          </div>

                          <div className="text-right">
                            <span className="font-bold text-ink">{rupee(exp.amount)}</span>
                            {exp.attachment_url ? (
                              <button type="button" onClick={() => openBill(exp.attachment_url!)}
                                className="flex items-center gap-1 ml-auto text-xs text-amber-ink hover:underline">
                                <Icon name="file" size={12} /> Bill
                              </button>
                            ) : (
                              <p className="text-xs text-ink-3">No bill</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* History / Settled Advances */}
      {settledAdvances.length > 0 && (
        <div className="pt-6 border-t border-hairline space-y-3">
          <h2 className="font-serif text-lg text-ink-2">Completed / Settled Advances</h2>
          <div className="space-y-2">
            {settledAdvances.map((adv) => (
              <Card key={adv.id} className="p-4 flex items-center justify-between text-xs bg-paper-2/40">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink">{adv.employee_name}</span>
                    <Badge kind="success" size="sm">Settled</Badge>
                  </div>
                  <p className="text-ink-3 text-xs mt-0.5">
                    Disbursed: {rupee(adv.disbursed_amount)} · Spent: {rupee(adv.total_spent)} · Disbursed on {formatDate(adv.disbursed_date, "short")}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditFor(adv)} aria-label={`Edit advance for ${adv.employee_name}`}>Edit</Button>
                  <Button size="sm" variant="ghost" icon="trash" className="text-red-ink" onClick={() => setDeleteFor(adv)} aria-label={`Delete advance for ${adv.employee_name}`}>Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Disburse Advance Modal */}
      <DisburseAdvanceDialog open={disburseOpen} onOpenChange={setDisburseOpen} prefill={prefill} />

      {/* Record Expense Modal */}
      {/* R-101: the normal Expense form (bill attach, GST, categories) with this
          advance already picked under "Paid by". */}
      {recordExpenseFor && (
        <AddExpenseDialog
          advanceId={recordExpenseFor.id}
          onClose={() => setRecordExpenseFor(null)}
        />
      )}

      {topUpFor && (
        <TopUpAdvanceDialog
          advance={topUpFor}
          open={!!topUpFor}
          onOpenChange={(open) => !open && setTopUpFor(null)}
        />
      )}

      {editFor && (
        <EditAdvanceDialog advance={editFor} open={!!editFor} onOpenChange={(open) => !open && setEditFor(null)} />
      )}
      {deleteFor && (
        <DeleteAdvanceDialog advance={deleteFor} open={!!deleteFor} onOpenChange={(open) => !open && setDeleteFor(null)} />
      )}

      {/* Settle Advance Modal */}
      {settleFor && (
        <SettleAdvanceDialog
          advance={settleFor}
          open={!!settleFor}
          onOpenChange={(open) => !open && setSettleFor(null)}
        />
      )}
    </div>
  );
}

/** Disburse Advance Modal */
interface AdvancePrefill { name: string; amount: string; date: string; method: string; purpose: string }

function DisburseAdvanceDialog({ open, onOpenChange, prefill }: { open: boolean; onOpenChange: (open: boolean) => void; prefill?: AdvancePrefill | null }) {
  const disburse = useDisburseAdvance();
  const { data: employees = [] } = useEmployees();
  const { data: bankAccounts = [] } = useBankAccounts();

  const [selectedEmpId, setSelectedEmpId] = React.useState<string>("");
  const [customName, setCustomName] = React.useState<string>("");
  const [amount, setAmount] = React.useState<string>("");
  const [date, setDate] = React.useState<string>(todayISO());
  const [method, setMethod] = React.useState<string>("bank_transfer");
  const [bankId, setBankId] = React.useState<string>("");
  const [purpose, setPurpose] = React.useState<string>("");

  /* Fill from AI Entry: the employee is matched by name (exact, then first-name), else the
     name goes in "Or Enter Employee Name" so nothing is silently dropped. */
  React.useEffect(() => {
    if (!prefill || !open) return;
    const n = prefill.name.trim().toLowerCase();
    const hit = n ? (employees.find((e) => e.name.trim().toLowerCase() === n)
      ?? employees.find((e) => e.name.trim().toLowerCase().split(/s+/)[0] === n.split(/s+/)[0])) : undefined;
    if (hit) { setSelectedEmpId(hit.id); setCustomName(""); } else { setSelectedEmpId(""); setCustomName(prefill.name); }
    if (prefill.amount) setAmount(prefill.amount);
    if (/^d{4}-d{2}-d{2}$/.test(prefill.date)) setDate(prefill.date);
    if (prefill.method && prefill.method in ADVANCE_PAYMENT_METHODS) setMethod(prefill.method);
    if (prefill.purpose) setPurpose(prefill.purpose);
  }, [prefill, open, employees]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error("Enter the advance amount", { description: "More than ₹0." });
      return;
    }

    const empObj = employees.find((e) => e.id === selectedEmpId);
    const empName = empObj ? empObj.name : customName.trim();

    if (!empName) {
      toast.error("Choose who gets the advance", { description: "Pick an employee, or type a name." });
      return;
    }

    disburse.mutate(
      {
        employee_name: empName,
        disbursed_amount: parsedAmount,
        disbursed_date: date,
        payment_method: method,
        bank_account_id: bankId || null,
        purpose: purpose.trim() || null,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setAmount("");
          setPurpose("");
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disburse Employee Expense Advance</DialogTitle>
          <DialogDescription>
            Give advance money to an employee for official company expenses (Travel, Client Visit, Petty Cash).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <FormField htmlFor="advances-employee" label="Employee">
            <Select value={selectedEmpId} onValueChange={(val) => { setSelectedEmpId(val); setCustomName(""); }}>
              <SelectTrigger id="advances-employee" className="w-full">
                <SelectValue placeholder="Select Employee..." />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {!selectedEmpId && (
            <FormField htmlFor="advances-or-enter-employee-name" label="Or Enter Employee Name">
              <Input id="advances-or-enter-employee-name"
                placeholder="e.g. Pawan Kumar"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
            </FormField>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="advances-advance-amount" label="Advance Amount (₹)" required>
              <Input id="advances-advance-amount"
                type="number"
                placeholder="5000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </FormField>

            <FormField htmlFor="advances-disbursed-date" label="Disbursed Date">
              <Input id="advances-disbursed-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="advances-payment-method" label="Payment Method">
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="advances-payment-method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ADVANCE_PAYMENT_METHODS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField htmlFor="advances-company-bank-cash" label="Company Bank / Cash">
              <Select value={bankId} onValueChange={setBankId}>
                <SelectTrigger id="advances-company-bank-cash" className="w-full">
                  <SelectValue placeholder="Select Bank..." />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name} ({rupee(b.current_balance ?? b.opening_balance)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField htmlFor="advances-purpose-purpose-notes" label="Purpose / Purpose Notes">
            <Input id="advances-purpose-purpose-notes"
              placeholder="e.g. Client visit travel & lodging expenses"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </FormField>

          <DialogFooter className="pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={disburse.isPending}>
              Disburse Advance
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Top-up — the weekly / monthly refill of the same advance. */
function TopUpAdvanceDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const topUp = useTopUpAdvance();
  const spent = advance.total_spent;
  const [amount, setAmount] = React.useState<string>(spent > 0 ? String(spent) : "");
  const [date, setDate] = React.useState<string>(todayISO());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Top-up for {advance.employee_name}</DialogTitle>
          <DialogDescription>
            {rupee(advance.remaining_balance)} is with them now.{" "}
            {spent > 0 ? <>Bills so far add up to {rupee(spent)}, so that is filled in.</> : null}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.round(Number(amount));
            if (!n || n <= 0) { toast.error("Enter the top-up amount", { description: "More than ₹0." }); return; }
            topUp.mutate({ advance_id: advance.id, amount: n, date }, { onSuccess: () => onOpenChange(false) });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount (₹)" required htmlFor="topup-amount">
              <Input id="topup-amount" type="number" min={1} inputMode="numeric" autoFocus
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Date" htmlFor="topup-date">
              <Input id="topup-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
          <p className="text-xs text-ink-3">
            Paid the same way as the advance ({ADVANCE_PAYMENT_METHODS[advance.payment_method] || advance.payment_method}).
            From petty cash, the cash balance goes down by this much.
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={topUp.isPending}>Add top-up</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Fix an advance made by mistake. Amount and date lock once it is settled or topped up —
    the database enforces the same rule and its message reaches the toast. */
function EditAdvanceDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const update = useUpdateAdvance();
  const [name, setName] = React.useState(advance.employee_name);
  const [amount, setAmount] = React.useState(String(advance.disbursed_amount));
  const [date, setDate] = React.useState(advance.disbursed_date?.slice(0, 10) ?? todayISO());
  const [purpose, setPurpose] = React.useState(advance.purpose && !/^(Top-up ₹|Settled on )/.test(advance.purpose) ? advance.purpose : "");
  const toppedUp = /(^|\n)Top-up ₹/.test(advance.notes ?? "");
  const moneyLocked = advance.status !== "active" || toppedUp;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit advance</DialogTitle>
          <DialogDescription>
            {moneyLocked
              ? (advance.status !== "active"
                  ? "This advance is settled, so only the name and purpose can change."
                  : "This advance has a top-up, so only the name and purpose can change. To fix the amount, delete it and give it again.")
              : <>Fix a mistake. {advance.total_spent > 0 ? <>{rupee(advance.total_spent)} is already spent, so the amount cannot go below that.</> : null}</>}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.round(Number(amount));
            if (!name.trim()) { toast.error("Enter who you gave the money to", { description: "A name is needed to track who owes it back." }); return; }
            if (!n || n <= 0) { toast.error("Enter the amount", { description: "More than ₹0." }); return; }
            update.mutate(
              { advance_id: advance.id, employee_name: name.trim(), amount: n, date, purpose: purpose.trim() || null },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <FormField label="Given to" required htmlFor="edit-adv-name">
            <Input id="edit-adv-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount (₹)" required htmlFor="edit-adv-amount">
              <Input id="edit-adv-amount" type="number" min={Math.max(1, advance.total_spent)} inputMode="numeric"
                value={amount} onChange={(e) => setAmount(e.target.value)} disabled={moneyLocked} />
            </FormField>
            <FormField label="Date" htmlFor="edit-adv-date">
              <Input id="edit-adv-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={moneyLocked} />
            </FormField>
          </div>
          <FormField label="Purpose" htmlFor="edit-adv-purpose">
            <Input id="edit-adv-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Office petty kharche" />
          </FormField>
          {!moneyLocked && advance.payment_method === "cash" && (
            <p className="text-xs text-ink-3">The petty-cash entry for this advance changes with it.</p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={update.isPending}>Save changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Delete an advance made by mistake. Lists what goes with it before anything is removed. */
function DeleteAdvanceDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const del = useDeleteAdvance();
  const n = advance.linked_expenses.length;
  const [withExpenses, setWithExpenses] = React.useState(false);
  const blocked = n > 0 && !withExpenses;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete advance to {advance.employee_name}?</DialogTitle>
          <DialogDescription>
            {rupee(advance.disbursed_amount)} given on {formatDate(advance.disbursed_date, "short")}. Use this only for an advance entered by mistake —
            the petty-cash entries it made are removed too. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {n > 0 && (
          <div className="rounded-lg border border-hairline bg-paper-2/50 p-3 space-y-2 text-sm">
            <p className="font-semibold text-ink">{n} expense{n === 1 ? "" : "s"} worth {rupee(advance.total_spent)} {n === 1 ? "is" : "are"} booked against it:</p>
            <ul className="text-xs text-ink-3 space-y-0.5 max-h-28 overflow-y-auto">
              {advance.linked_expenses.map((e) => (
                <li key={e.id}>{formatDate(e.expense_date, "short")} · {e.category}{e.vendor_name ? ` · ${e.vendor_name}` : ""} · {rupee(e.amount)}</li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
              <input type="checkbox" className="mt-1" checked={withExpenses} onChange={(e) => setWithExpenses(e.target.checked)} />
              <span>Delete {n === 1 ? "this expense" : "these expenses"} too — {n === 1 ? "it was" : "they were"} also a mistake</span>
            </label>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="danger" disabled={blocked} loading={del.isPending}
            onClick={() => del.mutate({ advance_id: advance.id, delete_expenses: withExpenses }, { onSuccess: () => onOpenChange(false) })}>
            Delete advance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settle Advance Modal */
function SettleAdvanceDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const settle = useSettleAdvance();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settle &amp; Close Employee Advance</DialogTitle>
          <DialogDescription>
            Settle advance for <strong>{advance.employee_name}</strong> once all expenses have been recorded or remaining cash has been returned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-3 text-xs">
          <div className="p-3 bg-paper-2 rounded-lg border border-hairline space-y-1">
            <div className="flex justify-between"><span>Disbursed Advance:</span><span className="font-bold">{rupee(advance.disbursed_amount)}</span></div>
            <div className="flex justify-between"><span>Expenses Booked:</span><span className="font-bold text-emerald">{rupee(advance.total_spent)}</span></div>
            <div className="flex justify-between border-t border-hairline pt-1 font-semibold text-amber-ink">
              <span>Remaining Advance Balance:</span>
              <span>{rupee(advance.remaining_balance)}</span>
            </div>
          </div>

          {advance.remaining_balance > 0 ? (
            <p className="text-ink-2 bg-amber-soft/20 p-2.5 rounded border border-amber/30">
              💡 <strong>Employee has {rupee(advance.remaining_balance)} cash remaining.</strong> Settling records that they handed it back. Given from petty cash, it goes back into petty cash.
            </p>
          ) : (
            <p className="text-emerald font-medium">
              ✓ All advance money has been 100% accounted for with booked expenses.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={settle.isPending}
            onClick={() => {
              settle.mutate({ advance_id: advance.id, date: todayISO() }, {
                onSuccess: () => onOpenChange(false),
              });
            }}
          >
            Confirm &amp; Settle Advance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
