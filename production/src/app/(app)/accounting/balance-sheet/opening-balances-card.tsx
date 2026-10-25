/** Balance Sheet → the CA's opening balances card — moved out of page.tsx (lint max-lines), no change. */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/providers/confirm-provider";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSetOpeningBalances, type OpeningBalances } from "@/lib/queries/balance-sheet";
import { addDaysISO } from "@/lib/dates/ist";
import { parseWholeRupees } from "./format";
import { SectionTitle, BSLine } from "./bs-lines";

/* S45 slice 2: CA ke opening balances. Khaali by default — app kabhi khud nahi bharta.
   Sirf owner badal sakta hai (set_opening_balances bhi yahi jaanchta hai); baaki dekh sakte hain. */
export function OpeningBalancesCard({ capitalLabel, opening, loading, failed, fyStart, today }: {
  capitalLabel: string; opening: OpeningBalances | null; loading: boolean; failed: boolean; fyStart: string; today: string;
}) {
  const isOwner = useCurrentUser().data?.role === "owner";
  const save = useSetOpeningBalances();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState(false);
  const [asOf, setAsOf] = React.useState("");
  const [capital, setCapital] = React.useState("");
  const [reserves, setReserves] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  function startEdit() {
    setAsOf(opening?.asOf ?? addDaysISO(fyStart, -1));
    setCapital(opening?.ownerCapital != null ? String(opening.ownerCapital) : "");
    setReserves(opening?.retainedEarnings != null ? String(opening.retainedEarnings) : "");
    setNotes(opening?.notes ?? "");
    setErr(null);
    setEditing(true);
  }

  async function submit() {
    const c = parseWholeRupees(capital);
    const r = parseWholeRupees(reserves);
    if (c === "bad" || r === "bad") { setErr("Whole rupees only, e.g. 500000 (no paise)."); return; }
    if (c !== null && c < 0) { setErr(`${capitalLabel} cannot be negative — enter the figure from your CA's balance sheet.`); return; }
    if (c === null && r === null) { setErr("Enter at least one figure, or use Remove."); return; }
    if (!asOf || asOf > today) { setErr("Pick the date of your CA's last balance sheet (not a future date)."); return; }
    await save.mutateAsync({ asOf, ownerCapital: c, retainedEarnings: r, notes: notes.trim() || null });
    setEditing(false);
  }

  async function remove() {
    if (!(await confirm({ title: "Remove opening balances?", body: "The Difference line comes back on the Balance Sheet and Trial Balance.", confirmLabel: "Remove", danger: true }))) return;
    await save.mutateAsync(null);
  }

  return (
    <Card id="opening-balances" className="mt-6 p-5 md:p-6 scroll-mt-20">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <SectionTitle>Opening balances</SectionTitle>
          <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
            Enter opening balances from your CA to remove the Difference line. Use the figures from your CA&apos;s last
            balance sheet (usually 31 March). If you already added a {capitalLabel} line above, don&apos;t enter it again here.
          </p>
        </div>
        {isOwner && !editing && !loading && !failed && (
          <div className="flex gap-2">
            <Button size="sm" variant={opening ? "default" : "primary"} icon={opening ? "edit" : "plus"} onClick={startEdit}>
              {opening ? "Edit" : "Enter opening balances"}
            </Button>
            {opening && <Button size="sm" variant="ghost" onClick={remove} loading={save.isPending}>Remove</Button>}
          </div>
        )}
      </div>

      {failed ? (
        <p role="alert" className="mt-3 text-sm text-rose">Could not load opening balances. Reload the page.</p>
      ) : loading ? (
        <Skeleton className="mt-3 h-10 w-full" />
      ) : editing ? (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <FormField label="As at (date of CA's balance sheet)" htmlFor="ob-as-of">
            <Input id="ob-as-of" name="ob-as-of" type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} />
          </FormField>
          <FormField label={`${capitalLabel} (₹)`} htmlFor="ob-capital">
            <Input id="ob-capital" name="ob-capital" inputMode="numeric" placeholder="From your CA" value={capital} onChange={(e) => setCapital(e.target.value)} />
          </FormField>
          <FormField label="Retained earnings b/f (₹, minus for a loss)" htmlFor="ob-retained">
            <Input id="ob-retained" name="ob-retained" inputMode="numeric" placeholder="From your CA" value={reserves} onChange={(e) => setReserves(e.target.value)} />
          </FormField>
          <div className="sm:col-span-3">
            <FormField label="Note (optional)" htmlFor="ob-notes">
              <Input id="ob-notes" name="ob-notes" maxLength={500} placeholder="e.g. As per audited balance sheet FY 2025-26" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </div>
          {err && <p role="alert" className="sm:col-span-3 text-sm text-rose">{err}</p>}
          <div className="sm:col-span-3 flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={submit} loading={save.isPending}>Save</Button>
          </div>
        </div>
      ) : opening ? (
        <div className="mt-3 space-y-1">
          <div className="text-xs text-ink-3">As at {formatDate(opening.asOf)}</div>
          <BSLine label={capitalLabel} amount={opening.ownerCapital ?? 0} hint={opening.ownerCapital == null ? "not entered" : undefined} />
          <BSLine label="Retained earnings b/f" amount={opening.retainedEarnings ?? 0} hint={opening.retainedEarnings == null ? "not entered" : undefined} />
          {opening.notes && <p className="text-xs text-ink-3">{opening.notes}</p>}
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-3">
          Not entered yet.{!isOwner && " Only the owner can enter these."}
        </p>
      )}
    </Card>
  );
}
