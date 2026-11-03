/**
 * Private Vault → People (R-2392, 3 Nov 2026).
 *
 * Pardeep: "from a person karne par contact list show honi chahiye". Your own people —
 * family, friends — kept once and picked everywhere the vault asks for a person (Loans from /
 * to a person, Money I owe / hold, Income "Received from", Expense "Paid to"), so one person
 * is spelt one way and everything with them adds up.
 *
 * Left: the list (search, net per person). Right: everything with the picked person — loans
 * given / taken still outstanding, open owe/hold, income received / paid — and one net
 * figure: "They owe me" / "I owe them" (lib/vault/personal/contacts.ts, tested there).
 * Income and spending are shown but are not debts, so they are not in the net.
 *
 * Never the company's customers or contacts: table personal_contacts, owner-only RLS.
 */
"use client";

import * as React from "react";
import Link from "next/link";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import {
  usePersonalContacts,
  useSavePersonalContact,
  useArchivePersonalContact,
  usePersonalContactTransactions,
  type PersonalContact,
} from "@/lib/queries/personal-contacts";
import { usePersonalLoans, usePersonalLoanPayments } from "@/lib/queries/personal-loans";
import { usePersonalOweHold } from "@/lib/queries/personal-owe-hold";
import {
  CONTACT_RELATIONS,
  CONTACT_RELATION_LABEL,
  NET_SIDE_LABEL,
  contactIssue,
  contactPositions,
  contactTxTotals,
  netSide,
  normalisePan,
  searchContacts,
  type ContactPosition,
  type ContactRelation,
} from "@/lib/vault/personal/contacts";
import { summariseLoan, loanKindLabel } from "@/lib/vault/personal/loans";
import { OWE_HOLD_KIND_SHORT, OWE_HOLD_SETTLED_LABEL } from "@/lib/vault/personal/owe-hold";
import { rowLabel } from "@/lib/vault/personal/income-expense";
import { formatDate } from "@/lib/utils";

const LABEL = "block text-2xs uppercase tracking-wide text-ink-3 mb-1";

interface FormState {
  id?: string;
  name: string;
  relation: ContactRelation;
  phone: string;
  email: string;
  pan: string;
  note: string;
}

const blank = (): FormState => ({ name: "", relation: "family", phone: "", email: "", pan: "", note: "" });

export default function PersonalPeoplePage() {
  const contactsQ = usePersonalContacts();
  const loansQ = usePersonalLoans();
  const paymentsQ = usePersonalLoanPayments();
  const oweHoldQ = usePersonalOweHold();
  const save = useSavePersonalContact();
  const archive = useArchivePersonalContact();

  const contacts = React.useMemo(() => contactsQ.data ?? [], [contactsQ.data]);
  const loans = React.useMemo(() => loansQ.data ?? [], [loansQ.data]);
  const payments = React.useMemo(() => paymentsQ.data ?? [], [paymentsQ.data]);
  const oweHold = React.useMemo(() => oweHoldQ.data ?? [], [oweHoldQ.data]);

  const [q, setQ] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(blank);
  const [issue, setIssue] = React.useState<string | null>(null);

  const list = React.useMemo(() => searchContacts(contacts, q, showArchived), [contacts, q, showArchived]);
  const positions = React.useMemo(
    () => contactPositions(contacts.map((c) => c.id), loans, payments, oweHold),
    [contacts, loans, payments, oweHold],
  );
  const selected = contacts.find((c) => c.id === selectedId) ?? list[0] ?? null;
  const txQ = usePersonalContactTransactions(selected?.id ?? null);

  const error = contactsQ.error || loansQ.error || paymentsQ.error || oweHoldQ.error;
  if (error) {
    return <VaultLoadError error={error} onRetry={() => { void contactsQ.refetch(); void loansQ.refetch(); void paymentsQ.refetch(); void oweHoldQ.refetch(); }} />;
  }
  if (contactsQ.isLoading || loansQ.isLoading || paymentsQ.isLoading || oweHoldQ.isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

  const openNew = () => { setForm(blank()); setIssue(null); setOpen(true); };
  const openEdit = (c: PersonalContact) => {
    setForm({ id: c.id, name: c.name, relation: c.relation, phone: c.phone ?? "", email: c.email ?? "", pan: c.pan ?? "", note: c.note ?? "" });
    setIssue(null);
    setOpen(true);
  };

  const handleSave = async () => {
    const problem = contactIssue(form, contacts, form.id);
    if (problem) { setIssue(problem); return; }
    try {
      const row = await save.mutateAsync({
        id: form.id,
        name: form.name.trim(),
        relation: form.relation,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        pan: normalisePan(form.pan),
        note: form.note.trim() || null,
      });
      toast.success(form.id ? "Person updated — the new name shows on their loans and entries too." : "Person added — pick them in Loans, Owe / hold and Income & Expenses.");
      if (row?.id) setSelectedId(row.id);
      setOpen(false);
    } catch {
      /* the hook already showed why */
    }
  };

  const toggleArchive = async (c: PersonalContact) => {
    try {
      await archive.mutateAsync({ id: c.id, archived: !c.archived });
      toast.success(c.archived ? `${c.name} is back in the list.` : `${c.name} archived — hidden from the person picker. Their loans and entries stay.`);
    } catch {
      /* the hook already showed why */
    }
  };

  if (contacts.length === 0) {
    return (
      <>
        <Card className="p-6">
          <EmptyState
            icon="users"
            title="No people yet"
            body="Add family and friends you lend to, borrow from or keep money for. Then pick them in Loans, Money I owe / hold and Income & Expenses — and see here what each one owes you, or you owe them."
            action={<Button variant="primary" onClick={openNew}>Add person</Button>}
          />
        </Card>
        <ContactDialog open={open} onOpenChange={setOpen} form={form} setForm={(p) => { setForm((f) => ({ ...f, ...p })); setIssue(null); }}
          issue={issue} saving={save.isPending} onSave={handleSave} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 rounded-md border border-hairline bg-paper px-2.5 py-1.5 w-full max-w-[320px] focus-within:ring-2 focus-within:ring-amber/40">
          <Icon name="search" size={14} className="text-ink-3 shrink-0" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search people"
            placeholder="Search name, phone or email"
            className="w-full bg-transparent text-sm focus:outline-none placeholder:text-ink-4"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-3">
          <Checkbox checked={showArchived} onCheckedChange={(v) => setShowArchived(v === true)} aria-label="Show archived" />
          Show archived
        </label>
        <div className="flex-1" />
        <Button variant="primary" onClick={openNew}>
          <Icon name="plus" size={13} className="mr-1" />
          Add person
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] items-start">
        {/* ── The list ─────────────────────────────────────────────────── */}
        <Card className="p-0 overflow-hidden">
          {list.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-3">No one matches &quot;{q}&quot;.</p>
          ) : (
            <ul className="divide-y divide-hairline" aria-label="People">
              {list.map((c) => {
                const pos = positions.get(c.id);
                const side = netSide(pos?.net ?? 0);
                const active = selected?.id === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      aria-pressed={active}
                      className={`w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-paper-2 ${active ? "bg-paper-2" : ""} ${c.archived ? "opacity-60" : ""}`}
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-ink truncate">{c.name}</span>
                        <span className="block text-2xs text-ink-3 truncate">
                          {CONTACT_RELATION_LABEL[c.relation]}{c.phone ? ` · ${c.phone}` : ""}{c.archived ? " · Archived" : ""}
                        </span>
                      </span>
                      {side !== "settled" && pos && (
                        <span className="text-right flex-shrink-0">
                          <span className="block text-3xs uppercase tracking-wide text-ink-3">{NET_SIDE_LABEL[side]}</span>
                          <Money amount={Math.abs(pos.net)} size="cell" tone={side === "they_owe" ? "positive" : "negative"} autoNegative={false} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ── The person ───────────────────────────────────────────────── */}
        {selected && (
          <PersonDetail
            contact={selected}
            loans={loans.filter((l) => l.contact_id === selected.id)}
            payments={payments}
            oweHold={oweHold.filter((r) => r.contact_id === selected.id)}
            position={positions.get(selected.id) ?? null}
            txs={txQ.data ?? []}
            txLoading={txQ.isLoading}
            onEdit={() => openEdit(selected)}
            onArchive={() => void toggleArchive(selected)}
            archiving={archive.isPending}
          />
        )}
      </div>

      <ContactDialog open={open} onOpenChange={setOpen} form={form} setForm={(p) => { setForm((f) => ({ ...f, ...p })); setIssue(null); }}
        issue={issue} saving={save.isPending} onSave={handleSave} />
    </div>
  );
}

/* ── Detail ──────────────────────────────────────────────────────────────────────────────── */

type Loans = NonNullable<ReturnType<typeof usePersonalLoans>["data"]>;
type Payments = NonNullable<ReturnType<typeof usePersonalLoanPayments>["data"]>;
type OweHoldRows = NonNullable<ReturnType<typeof usePersonalOweHold>["data"]>;
type Txs = NonNullable<ReturnType<typeof usePersonalContactTransactions>["data"]>;

function Tile({ label, amount, tone = "default", hint }: { label: string; amount: number; tone?: "default" | "positive" | "negative"; hint?: string }) {
  return (
    <div className="rounded-lg border border-hairline px-3 py-2.5 min-w-0">
      <p className="text-3xs uppercase tracking-wide text-ink-3">{label}</p>
      <Money amount={amount} size="cell" tone={tone} autoNegative={false} />
      {hint && <p className="text-3xs text-ink-3 mt-0.5">{hint}</p>}
    </div>
  );
}

function PersonDetail({ contact, loans, payments, oweHold, position, txs, txLoading, onEdit, onArchive, archiving }: {
  contact: PersonalContact;
  loans: Loans;
  payments: Payments;
  oweHold: OweHoldRows;
  position: ContactPosition | null;
  txs: Txs;
  txLoading: boolean;
  onEdit: () => void;
  onArchive: () => void;
  archiving: boolean;
}) {
  const pos = position ?? { lent: 0, borrowed: 0, oweHold: 0, net: 0, openLoans: 0, openOweHold: 0 };
  const side = netSide(pos.net);
  const totals = contactTxTotals(txs);
  const details = [contact.phone, contact.email, contact.pan ? `PAN ${contact.pan}` : null].filter(Boolean).join(" · ");

  return (
    <Card className="p-0 overflow-hidden" aria-labelledby="person-name">
      <div className="px-4 py-3 border-b border-hairline flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 id="person-name" className="text-lg font-serif text-ink">{contact.name}</h2>
            <Badge kind="muted" size="sm">{CONTACT_RELATION_LABEL[contact.relation]}</Badge>
            {contact.archived && <Badge kind="warning" size="sm">Archived</Badge>}
          </div>
          {details && <p className="text-xs text-ink-3 mt-0.5">{details}</p>}
          {contact.note && <p className="text-xs text-ink-3 mt-0.5">{contact.note}</p>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={onArchive} loading={archiving}>{contact.archived ? "Restore" : "Archive"}</Button>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className={`rounded-lg px-4 py-3 ${side === "they_owe" ? "bg-emerald-soft" : side === "i_owe" ? "bg-rose-soft" : "bg-paper-2"}`}>
          <p className="text-xs font-medium text-ink">{NET_SIDE_LABEL[side]}</p>
          <Money amount={Math.abs(pos.net)} size="display" tone={side === "they_owe" ? "positive" : side === "i_owe" ? "negative" : "default"} autoNegative={false} />
          <p className="text-3xs text-ink-3 mt-1">Money lent to them − loans from them − money you hold for them (open only).</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <Tile label="Lent to them" amount={pos.lent} tone={pos.lent > 0 ? "positive" : "default"} hint="still to come back" />
          <Tile label="Borrowed from them" amount={pos.borrowed} tone={pos.borrowed > 0 ? "negative" : "default"} hint="still to repay" />
          <Tile label="I owe / hold for them" amount={pos.oweHold} tone={pos.oweHold > 0 ? "negative" : "default"} hint="advance, held money" />
          <Tile label="Received from them" amount={totals.received} hint="income, all time" />
          <Tile label="Paid to them" amount={totals.paid} hint="expenses, all time" />
        </div>
      </div>

      {/* Loans */}
      <Section title="Loans" link={{ href: "/vault/personal/loans", label: "Open Loans" }}>
        {loans.length === 0 ? (
          <Empty>No loans with {contact.name}. In Loans → Add loan, pick “From a person” or “To a person”.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {loans.map((l) => {
              const out = summariseLoan(l, payments).outstanding;
              return (
                <li key={l.id} className={`px-4 py-2 flex items-center gap-3 ${l.status === "open" ? "" : "opacity-70"}`}>
                  <span className="flex-1 min-w-0 text-sm text-ink">
                    {l.direction === "given" ? "Lent to them" : "Borrowed from them"}
                    <span className="text-2xs text-ink-3"> · {loanKindLabel(l.loan_kind, l.direction)} · {formatDate(l.start_date)} · of <Money amount={l.principal} size="inline" /></span>
                  </span>
                  {l.status === "open"
                    ? <span className="text-right"><span className="block text-3xs uppercase tracking-wide text-ink-3">Outstanding</span><Money amount={out} size="cell" tone={l.direction === "given" ? "positive" : "negative"} autoNegative={false} /></span>
                    : <Badge kind="muted" size="sm">Closed</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Owe / hold */}
      <Section title="Money I owe / hold for them" link={{ href: "/vault/personal/banking", label: "Open Banking" }}>
        {oweHold.length === 0 ? (
          <Empty>No advance or held money with {contact.name}.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {oweHold.map((r) => (
              <li key={r.id} className={`px-4 py-2 flex items-center gap-3 ${r.status === "open" ? "" : "opacity-70"}`}>
                <span className="flex-1 min-w-0 text-sm text-ink">
                  {OWE_HOLD_KIND_SHORT[r.kind]}
                  <span className="text-2xs text-ink-3"> · {formatDate(r.occurred_on)}{r.note ? ` · ${r.note}` : ""}</span>
                </span>
                {r.status === "open"
                  ? <Money amount={r.amount} size="cell" tone="negative" autoNegative={false} />
                  : <Badge kind="muted" size="sm">{r.settled_how ? OWE_HOLD_SETTLED_LABEL[r.settled_how] : "Settled"}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Income & expenses */}
      <Section title="Income & expenses" link={{ href: "/vault/personal/expenses", label: "Open Income & Expenses" }}>
        {txLoading ? (
          <Empty>Loading…</Empty>
        ) : txs.length === 0 ? (
          <Empty>Nothing received from or paid to {contact.name} yet.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {txs.slice(0, 20).map((t) => (
              <li key={t.id} className="px-4 py-2 flex items-center gap-3">
                <span className="flex-1 min-w-0 text-sm text-ink truncate">
                  {rowLabel(t)}
                  <span className="text-2xs text-ink-3"> · {formatDate(t.occurred_on)}{t.note ? ` · ${t.note}` : ""}</span>
                </span>
                <Money amount={t.amount} size="cell" autoNegative={false} />
              </li>
            ))}
          </ul>
        )}
        {txs.length > 20 && <p className="px-4 py-2 text-2xs text-ink-3">Latest 20 of {txs.length} shown. Totals above count all of them.</p>}
      </Section>
    </Card>
  );
}

type VaultHref = "/vault/personal/loans" | "/vault/personal/banking" | "/vault/personal/expenses";

function Section({ title, link, children }: { title: string; link: { href: VaultHref; label: string }; children: React.ReactNode }) {
  return (
    <section className="border-t border-hairline">
      <div className="px-4 py-2 bg-paper-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3">{title}</h3>
        <Link href={link.href} className="text-2xs text-primary hover:underline">{link.label}</Link>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-xs text-ink-3">{children}</p>;
}

/* ── Add / edit ─────────────────────────────────────────────────────────────────────────── */

function ContactDialog({ open, onOpenChange, form, setForm, issue, saving, onSave }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  form: FormState;
  setForm: (patch: Partial<FormState>) => void;
  issue: string | null;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit person" : "Add person"}</DialogTitle>
          <DialogDescription className="text-xs">
            Your own people — only you can see them. Not your company&apos;s customers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pc-name" className={LABEL}>Name</label>
              <Input id="pc-name" value={form.name} maxLength={120} placeholder="Ramesh Kumar"
                onChange={(e) => setForm({ name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="pc-relation" className={LABEL}>Relation</label>
              <Select value={form.relation} onValueChange={(v) => setForm({ relation: v as ContactRelation })}>
                <SelectTrigger id="pc-relation"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONTACT_RELATIONS.map((r) => <SelectItem key={r} value={r}>{CONTACT_RELATION_LABEL[r]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pc-phone" className={LABEL}>Phone</label>
              <Input id="pc-phone" value={form.phone} inputMode="tel" maxLength={20} placeholder="optional"
                onChange={(e) => setForm({ phone: e.target.value })} />
            </div>
            <div>
              <label htmlFor="pc-email" className={LABEL}>Email</label>
              <Input id="pc-email" value={form.email} type="email" placeholder="optional"
                onChange={(e) => setForm({ email: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pc-pan" className={LABEL}>PAN</label>
              <Input id="pc-pan" value={form.pan} maxLength={12} placeholder="optional — ABCDE1234F"
                onChange={(e) => setForm({ pan: e.target.value.toUpperCase() })} />
            </div>
            <div>
              <label htmlFor="pc-note" className={LABEL}>Note</label>
              <Input id="pc-note" value={form.note} maxLength={500} placeholder="optional"
                onChange={(e) => setForm({ note: e.target.value })} />
            </div>
          </div>
          {issue && <p role="alert" className="text-xs text-rose">{issue}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={onSave} loading={saving}>{form.id ? "Update" : "Add person"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
