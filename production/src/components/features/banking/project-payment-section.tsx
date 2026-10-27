/**
 * ProjectPaymentSection — inside the reconcile dialog: "whose project is this money for?"
 *
 * Existing project (R-1998, R-1910 audit "ONE path") → the project opens by itself when the bank
 * line names its customer (or when its oldest instalments add up to the receipt); its OPEN
 * instalments are listed with Instalment / Paid / Balance, and the oldest are ticked first up to
 * what the receipt settles (bank + TDS) — the last one ticked may be part-paid. Amounts can be
 * edited; the check under the list says live whether bank + TDS = the instalments ticked. ONE Save
 * books it all in one transaction: allocate_project_receipt (R-1995), or
 * allocate_project_receipt_with_tds (R-1996) when TDS was deducted. Money beyond every open
 * instalment is NOT put anywhere (keeping it as the customer's advance is R-1997, decision D1):
 * Save stays off and the screen says so.
 *
 * A project already paid in full (or extra money that is separate work) → "Add as a new
 * milestone": the receipt becomes a new milestone and the project value grows by it (shown before
 * booking). New project → customer, name and the project's total value; it is created with an
 * Advance + Balance split (or one Full payment), and this receipt pays the first. Those two keep the
 * project module's own RPCs (useBookBankCreditAsProjectPayment).
 *
 * "TDS deducted?" — when the customer withheld TDS, the bank amount is not the invoice:
 * ₹5,40,000 at 10% TDS settles a ₹5,90,000 invoice (₹5,00,000 + GST). The instalments, the new
 * project's value and the invoice are sized on what the receipt SETTLES, and the TDS is
 * recorded as a receivable to claim (lib/accounting/tds-split.ts).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import {
  useOpenProjects, useBookBankCreditAsProjectPayment, useAllocateProjectReceipt, receiptMilestones,
  type OpenMilestone,
} from "@/lib/queries/project-receipts";
import { TDS_SECTIONS, tdsSplitFromNet } from "@/lib/accounting/tds-split";
import { amountInIndianWords } from "@/lib/accounting/amount-words";
import { guessCustomer } from "@/lib/banking/credit-pay-for";
import {
  fifoAllocate, receiptCheck, pickProjectForReceipt, projectReceiptPayload, hintLink, type KistRow,
} from "@/lib/banking/project-receipt-allocation";
import { describeError } from "@/lib/errors/toast-error";

const NEW_CUSTOMER = "__new_customer__";
const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

interface Props {
  txn: { id: string; txn_date: string; description: string | null; reference?: string | null };
  amount: number;
  customers: readonly { id: string; name: string }[];
  customerId: string;
  onCustomerChange: (id: string) => void;
  onNewCustomer: () => void;
  onCancel: () => void;
  onDone: () => void;
}

/** One instalment row as the owner sees and edits it. */
interface RowState { on: boolean; amount: string; invoice: boolean }

export function ProjectPaymentSection({ txn, amount, customers, customerId, onCustomerChange, onNewCustomer, onCancel, onDone }: Props) {
  const { data: projects, isLoading } = useOpenProjects(true);
  const book = useBookBankCreditAsProjectPayment();
  const allocate = useAllocateProjectReceipt();

  const [mode, setMode] = React.useState<"existing" | "new">("existing");
  const [projectId, setProjectId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [total, setTotal] = React.useState(String(Math.round(amount)));
  const [raiseInvoice, setRaiseInvoice] = React.useState(true);
  /* Book the whole receipt as ONE new milestone on the picked project (paid-in-full project, or separate work). */
  const [addMilestone, setAddMilestone] = React.useState(false);
  const [newMsLabel, setNewMsLabel] = React.useState("Additional payment");
  const [tdsOn, setTdsOn] = React.useState(false);
  const [tdsKey, setTdsKey] = React.useState(TDS_SECTIONS[0].key);
  /* The TDS amount follows the section until the owner types the one on the customer's Form 16A. */
  const [tdsTyped, setTdsTyped] = React.useState<string | null>(null);
  /* null = the instalments follow FIFO; set once the owner ticks, unticks or edits a row. */
  const [manual, setManual] = React.useState<Record<string, RowState> | null>(null);
  const [saveError, setSaveError] = React.useState<{ text: string; link: { href: string; label: string } | null } | null>(null);

  /* No open project at all → start on "New project" rather than an empty picker. */
  React.useEffect(() => {
    if (!isLoading && (projects ?? []).length === 0) setMode("new");
  }, [isLoading, projects]);

  const project = (projects ?? []).find((p) => p.id === projectId) ?? null;
  const paidInFull = !!project && project.milestones.length === 0;
  const addingMilestone = !!project && (addMilestone || paidInFull);

  const net = Math.round(amount);
  const tdsSection = TDS_SECTIONS.find((t) => t.key === tdsKey) ?? TDS_SECTIONS[0];
  const gstRate = mode === "existing" && project ? project.gstRate : 18;
  const tdsSplit = tdsOn ? tdsSplitFromNet(net, gstRate, tdsSection.ratePct) : null;
  const tdsAmount = !tdsOn ? 0 : tdsTyped !== null ? Math.max(0, Math.round(Number(tdsTyped) || 0)) : (tdsSplit?.tds ?? 0);
  /* What this receipt settles: the bank amount, plus the TDS the customer paid for us. */
  const settled = net + tdsAmount;

  /* The project to open on: the customer the bank line names, else the one whose oldest
     instalments add up to the receipt. Once — the owner's own pick is never overridden. */
  const guessed = React.useMemo(() => guessCustomer(txn, customers), [txn, customers]);
  const autoPicked = React.useRef(false);
  React.useEffect(() => {
    if (autoPicked.current || isLoading || !projects?.length || projectId) return;
    autoPicked.current = true;
    const id = pickProjectForReceipt(projects, guessed?.customerId ?? (customerId || null), settled);
    if (id) setProjectId(id);
  }, [isLoading, projects, projectId, guessed, customerId, settled]);

  /* A different project or a different amount settled → back to FIFO. */
  React.useEffect(() => { setManual(null); }, [projectId, settled]);

  /* The guessed customer's projects first in the picker. */
  const ordered = React.useMemo(() => {
    const first = guessed?.customerId ?? customerId;
    const list = [...(projects ?? [])];
    return first ? [...list.filter((p) => p.customerId === first), ...list.filter((p) => p.customerId !== first)] : list;
  }, [projects, guessed, customerId]);

  const fifo = project && !addingMilestone ? fifoAllocate(settled, project.milestones) : null;
  const rowState = (m: OpenMilestone): RowState => {
    if (manual?.[m.id]) return manual[m.id];
    const line = fifo?.lines.find((l) => l.id === m.id);
    return { on: !!line, amount: String(line?.amount ?? m.remaining), invoice: !m.invoiceId };
  };
  const rows: (KistRow & { m: OpenMilestone; raw: RowState })[] = (project?.milestones ?? []).map((m) => {
    const raw = rowState(m);
    return { id: m.id, seq: m.seq, on: raw.on, amount: Math.round(Number(raw.amount) || 0), raiseInvoice: raw.invoice, m, raw };
  });
  const ticked = rows.filter((r) => r.on);
  const tickedTotal = ticked.reduce((s, r) => s + r.amount, 0);
  const check = receiptCheck(net, tdsAmount, tickedTotal);
  const rowTooBig = ticked.some((r) => r.amount > r.m.remaining || r.amount <= 0);
  const dueTotal = (project?.milestones ?? []).reduce((s, m) => s + m.remaining, 0);
  /* FIFO ran out of instalments: the extra has no home here yet (R-1997). */
  const leftover = !manual && fifo ? fifo.leftover : 0;

  function editRow(m: OpenMilestone, change: Partial<RowState>) {
    const snapshot: Record<string, RowState> = {};
    for (const x of project?.milestones ?? []) snapshot[x.id] = rowState(x);
    const next = { ...snapshot[m.id], ...change };
    /* A row ticked by hand takes what is still short, up to its balance. */
    if (change.on === true && !snapshot[m.id].on) {
      const short = check.state === "short" ? check.diff : 0;
      next.amount = String(short > 0 ? Math.min(short, m.remaining) : m.remaining);
    }
    setManual({ ...snapshot, [m.id]: next });
    setSaveError(null);
  }

  function pickProject(id: string) {
    setProjectId(id);
    setAddMilestone(false);
    setSaveError(null);
  }

  const totalNum = Math.round(Number(total));
  const customerName = customers.find((c) => c.id === customerId)?.name ?? "";
  /* Open projects of the customer picked under "New project" — see the warning below it. */
  const customerProjects = customerId ? (projects ?? []).filter((p) => p.customerId === customerId) : [];
  const split = totalNum > 0 ? receiptMilestones(totalNum, settled) : [];

  /* A new project's value follows what the receipt settles until the operator types one. */
  const [totalEdited, setTotalEdited] = React.useState(false);
  React.useEffect(() => { if (!totalEdited) setTotal(String(settled)); }, [settled, totalEdited]);

  const listMode = mode === "existing" && !!project && !addingMilestone;
  const canSubmit = listMode
    ? ticked.length > 0 && check.state === "match" && !rowTooBig && leftover === 0 && (!tdsOn || tdsAmount > 0)
    : mode === "existing"
      ? addingMilestone && newMsLabel.trim().length > 0
      : !!customerId && title.trim().length > 0 && totalNum >= settled;

  async function submit() {
    setSaveError(null);
    if (listMode && project) {
      try {
        await allocate.mutateAsync(projectReceiptPayload({
          bankTxnId: txn.id,
          projectId: project.id,
          rows,
          tds: tdsOn ? { section: tdsSection.section, ratePct: tdsSection.ratePct, amount: tdsAmount } : null,
          receivedAt: txn.txn_date,
          reference: txn.reference ?? null,
        }));
      } catch (err) {
        /* The RPC's own words (§24) + where to go next (its hint). The hook toasts it too. */
        setSaveError({
          text: describeError(err, "Could not book the project receipt").message,
          link: hintLink((err as { hint?: string } | null)?.hint),
        });
        return;
      }
      onDone();
      return;
    }
    await book.mutateAsync({
      bankTxnId: txn.id,
      amount: net,
      tds: tdsSplit ? { amount: tdsSplit.tds, section: tdsSection.section, ratePct: tdsSection.ratePct, base: tdsSplit.taxable } : null,
      receivedAt: txn.txn_date,
      reference: txn.reference ?? txn.description,
      raiseInvoice,
      target: mode === "existing"
        ? { kind: "existing", projectId, milestoneId: null, newMilestoneLabel: newMsLabel.trim() }
        : { kind: "new", customerId, customerName, title: title.trim(), totalInclusive: totalNum, gstRate: 18 },
    });
    onDone();
  }

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border border-hairline p-0.5 text-[12px]" role="tablist">
        {(["existing", "new"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded px-2.5 py-1 ${mode === m ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
          >
            {m === "existing" ? "Existing project" : "＋ New project"}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        isLoading ? (
          <p className="text-xs text-ink-3">Loading projects…</p>
        ) : (projects ?? []).length === 0 ? (
          <p className="text-xs text-ink-3">No open projects — choose &quot;New project&quot;.</p>
        ) : (
          <>
            <select value={projectId} onChange={(e) => pickProject(e.target.value)} aria-label="Project" className={selectCls}>
              <option value="" disabled>Which project is this payment for? Select a project…</option>
              {ordered.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.customerName} · {p.milestones.length > 0
                    ? `balance ${rupee(p.milestones.reduce((s, m) => s + m.remaining, 0))}`
                    : p.paid > 0 ? `fully paid (${rupee(p.paid)})` : "no milestones"}
                </option>
              ))}
            </select>

            {listMode && project && (
              <div className="rounded-md border border-hairline bg-paper">
                <p className="border-b border-hairline px-2.5 py-1.5 text-xs text-ink-3">
                  Open instalments — oldest ticked first up to {rupee(settled)}{tdsAmount > 0 ? " (bank + TDS)" : ""}. Change any amount if needed.
                </p>
                <ul className="divide-y divide-hairline">
                  {rows.map(({ m, raw, amount: amt }) => (
                    <li key={m.id} role="group" aria-label={m.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2">
                      <label className="flex min-w-0 flex-1 basis-48 items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={raw.on}
                          onChange={(e) => editRow(m, { on: e.target.checked })}
                          aria-label={`Tick ${m.label}`}
                          className="mt-1"
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{m.seq}. {m.label}</span>
                          <span className="block text-xs text-ink-3 tabular-nums">
                            Instalment {rupee(m.total)} · Paid {rupee(m.paid)} · Balance {rupee(m.remaining)}
                          </span>
                        </span>
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={m.remaining}
                          value={raw.on ? raw.amount : ""}
                          placeholder="0"
                          disabled={!raw.on}
                          onChange={(e) => editRow(m, { amount: e.target.value })}
                          aria-label={`Amount for ${m.label}`}
                          className="w-32 text-right tabular-nums"
                        />
                        {m.invoiceId ? (
                          <span className="w-24 text-xs text-ink-3">Invoice {m.invoiceId}</span>
                        ) : (
                          <label className="flex w-24 items-center gap-1.5 text-xs text-ink-2">
                            <input
                              type="checkbox"
                              checked={raw.invoice}
                              disabled={!raw.on}
                              onChange={(e) => editRow(m, { invoice: e.target.checked })}
                              aria-label={`Raise invoice for ${m.label}`}
                            />
                            Invoice
                          </label>
                        )}
                      </div>
                      {raw.on && amt > m.remaining && (
                        <p className="basis-full text-xs text-rose">Only {rupee(m.remaining)} is left on this instalment.</p>
                      )}
                      {raw.on && amt > 0 && amt < m.remaining && raw.invoice && !m.invoiceId && m.paid === 0 && (
                        <p className="basis-full text-xs text-ink-3">
                          Part payment: a separate instalment of {rupee(amt)} is made and invoiced; {rupee(m.remaining - amt)} stays due.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {addingMilestone && project && (
              <>
                <Input value={newMsLabel} onChange={(e) => setNewMsLabel(e.target.value)} placeholder="Milestone name (e.g. Phase 2)" aria-label="New milestone name" />
                <p className="text-xs text-amber-ink">
                  {paidInFull && project.paid > 0 ? "This project is already fully paid. " : ""}
                  This {rupee(settled)} is added as a new milestone and the project value goes from {rupee(project.total)} to {rupee(project.total + settled)}.
                  If this is separate work, choose &quot;New project&quot;.
                </p>
                {!paidInFull && (
                  <Button size="sm" variant="link" onClick={() => setAddMilestone(false)}>Back to the open instalments</Button>
                )}
              </>
            )}
          </>
        )
      ) : (
        <>
          <select
            value={customerId}
            onChange={(e) => {
              if (e.target.value === NEW_CUSTOMER) { onNewCustomer(); return; }
              onCustomerChange(e.target.value);
            }}
            aria-label="Customer"
            className={selectCls}
          >
            <option value="" disabled>Select a customer…</option>
            <option value={NEW_CUSTOMER}>＋ New customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {/* This customer already has an open project — the usual case is an instalment on
              it, not a new deal. Booking it as "New project" split a ₹50L contract into a
              ₹5L duplicate (26 Sep 2026), so it is said before anything is created. */}
          {customerProjects.length > 0 && (
            <div className="rounded-md border border-amber/50 bg-amber-soft/30 p-2.5 text-xs text-ink-2 space-y-1.5">
              <p>
                <b>{customerName}</b> already has an open project. If this payment is an instalment of it, do not create a new project —
                choose the existing project.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {customerProjects.map((p) => (
                  <Button key={p.id} type="button" size="sm" variant="default" onClick={() => { setMode("existing"); pickProject(p.id); }}>
                    {p.title} · {rupee(p.total)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project name (e.g. Accounting software)" aria-label="Project name" />
          <label className="block text-xs text-ink-3">
            Project total value ₹ (incl. GST) — if this payment is the whole project, leave it as is
            <Input value={total} onChange={(e) => { setTotal(e.target.value); setTotalEdited(true); }} type="number" min={0} className="mt-1" aria-label="Project total value" />
          </label>
          {totalNum > 0 && (
            <p className="text-xs text-ink-3">
              = <b className="text-ink">{amountInIndianWords(totalNum)}</b> (incl. GST)
            </p>
          )}
          {/* The total defaults to this one payment — right for a one-payment job, wrong for the
              first instalment of a bigger contract, which is how a ₹50L deal became a ₹5L project. */}
          {totalNum === settled && (
            <p className="text-xs text-amber-ink">
              The deal value now equals just this payment ({amountInIndianWords(settled)}). If this is the first instalment of a bigger deal,
              enter the <b>full value</b> above — the remaining milestone is created automatically.
            </p>
          )}
          {split.length > 0 && totalNum >= settled && (
            <p className="text-xs text-ink-3">
              Milestones: {split.map((m) => `${m.label} ${rupee(m.total_amount)}`).join(" + ")} (incl. 18% GST) — this {rupee(settled)} goes to the first milestone.
              You can change milestones later on the project page.
            </p>
          )}
          {totalNum > 0 && totalNum < settled && (
            <p className="text-xs text-rose">Total value cannot be less than this payment ({rupee(settled)}).</p>
          )}
        </>
      )}

      {/* TDS the customer withheld: the receipt then settles more than reached the bank. */}
      <div className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={tdsOn} onChange={(e) => { setTdsOn(e.target.checked); setTdsTyped(null); }} className="mt-0.5" />
          <span><b>TDS deducted?</b> The customer deducted TDS and sent {rupee(net)}</span>
        </label>
        {tdsOn && tdsSplit && (
          <>
            <select value={tdsKey} onChange={(e) => { setTdsKey(e.target.value); setTdsTyped(null); }} aria-label="TDS section" className={selectCls}>
              {TDS_SECTIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            {listMode ? (
              <label className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                TDS amount ₹ (as on the customer&apos;s Form 16A)
                <Input
                  type="number"
                  min={0}
                  value={tdsTyped ?? String(tdsSplit.tds)}
                  onChange={(e) => setTdsTyped(e.target.value)}
                  aria-label="TDS amount"
                  className="w-32 text-right tabular-nums"
                />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular-nums">
                <span className="text-ink-3">Value of work (taxable)</span><span className="text-right text-ink">{rupee(tdsSplit.taxable)}</span>
                <span className="text-ink-3">+ GST {gstRate}%</span><span className="text-right text-ink">{rupee(tdsSplit.gst)}</span>
                <span className="text-ink-3 font-semibold">= Invoice</span><span className="text-right text-ink font-semibold">{rupee(tdsSplit.gross)}</span>
                <span className="text-ink-3">− TDS {tdsSection.ratePct}% on {rupee(tdsSplit.taxable)}</span><span className="text-right text-rose">− {rupee(tdsSplit.tds)}</span>
                <span className="text-ink-3">= Received in bank</span><span className="text-right text-emerald">{rupee(tdsSplit.net)}</span>
              </div>
            )}
            <p className="text-xs text-ink-3">
              {rupee(tdsAmount)} goes to TDS Receivable (Form 16A pending) — claimed in the ITR.
            </p>
          </>
        )}
      </div>

      {/* The live check: bank + TDS against the instalments ticked. */}
      {listMode && (
        leftover > 0 ? (
          <div className="rounded-md border border-amber/50 bg-amber-soft/30 p-2.5 text-xs text-ink-2 space-y-1.5" role="status">
            <p>
              This receipt settles {rupee(settled)}, which is {rupee(leftover)} more than everything due on this project ({rupee(dueTotal)}).
              Keeping the extra as the customer&apos;s advance is not available here yet, so nothing is booked.
            </p>
            <p>
              If the extra is for separate work, add the receipt as a new milestone. If it is an advance, close this and use
              &quot;This money is for → Advance&quot;.
            </p>
            <Button size="sm" variant="default" onClick={() => setAddMilestone(true)}>Add as a new milestone instead</Button>
          </div>
        ) : (
          <p
            role="status"
            className={`text-xs tabular-nums ${check.state === "match" ? "text-emerald" : "text-rose"}`}
          >
            Bank {rupee(net)}{tdsAmount > 0 ? ` + TDS ${rupee(tdsAmount)}` : ""} = {rupee(settled)} · Instalments ticked {rupee(tickedTotal)} ·{" "}
            {check.state === "match"
              ? "matches"
              : check.state === "short"
                ? `${rupee(check.diff)} short — tick the next instalment or raise an amount`
                : `${rupee(check.diff)} over — lower an amount${tdsOn ? " or check the TDS" : ""}`}
          </p>
        )
      )}

      {!listMode && (
        <label className="flex items-start gap-2 text-xs text-ink-2 pt-1">
          <input type="checkbox" checked={raiseInvoice} onChange={(e) => setRaiseInvoice(e.target.checked)} className="mt-0.5" />
          <span>Also create the tax invoice for this milestone</span>
        </label>
      )}

      {saveError && (
        <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft/30 p-2.5 text-xs text-ink-2">
          <p>{saveError.text}</p>
          {saveError.link && (
            <Link href={saveError.link.href as Route} className="mt-1 inline-block font-medium text-ink underline">{saveError.link.label}</Link>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="primary"
          icon="check"
          loading={listMode ? allocate.isPending : book.isPending}
          disabled={!canSubmit || (mode === "existing" && !project)}
          onClick={submit}
        >
          {listMode ? "Save & reconcile" : "Record project payment & reconcile"}
        </Button>
        <Button size="sm" variant="default" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
