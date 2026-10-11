"use client";

/**
 * ExpenseClaimClient — the public expense-claim form (rendered by /expense-claim).
 *
 * Two steps so logging many expenses stays quick:
 *   1. Identify — pick your name + enter your attendance PIN once. We verify it
 *      and show how much of your advance is left to claim.
 *   2. Log — add expense after expense (amount, category, purpose, date, optional
 *      receipt) WITHOUT re-entering the PIN. Each one is filed as a PENDING claim
 *      for the office to approve; the running balance and list update live.
 *
 * The PIN is held in memory for the session only (never stored) and sent with
 * each submit over HTTPS. Every claim still needs owner approval before it hits
 * the books.
 */
import * as React from "react";

import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { EXPENSE_CATEGORIES } from "@/lib/queries/expenses";
import { istToday } from "@/lib/dates/ist";

function todayISO(): string {
  return istToday();
}

type Session = { employeeId: string; employeeName: string; pin: string; remaining: number };
type Logged = { id: string; category: string; amount: number; spentOn: string; purpose: string | null };

export function ExpenseClaimClient({
  tid, sig, exp, brandName, employees,
}: {
  tid: string;
  sig: string;
  exp: string;
  brandName: string;
  employees: Array<{ id: string; name: string }>;
}) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [logged, setLogged]   = React.useState<Logged[]>([]);

  return (
    <div className="min-h-screen bg-paper-2">
      <div className="mx-auto max-w-lg px-4 py-8 md:py-12">
        {/* Brand header */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-paper font-serif text-lg">
            {brandName.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="font-serif text-base leading-none text-ink">{brandName}</div>
            <div className="mt-1 text-xs text-ink-3">Expense claim</div>
          </div>
        </div>

        <div className="rounded-2xl border border-hairline bg-paper p-6 shadow-sm md:p-8">
          {session ? (
            <LogStep
              tid={tid}
              sig={sig}
              exp={exp}
              brandName={brandName}
              session={session}
              setSession={setSession}
              logged={logged}
              setLogged={setLogged}
              onSwitch={() => { setSession(null); setLogged([]); }}
              employeeName={employees.find((e) => e.id === session.employeeId)?.name ?? session.employeeName}
            />
          ) : (
            <IdentifyStep tid={tid} sig={sig} exp={exp} employees={employees} onVerified={setSession} />
          )}
        </div>

        <p className="mt-4 text-center text-xs text-ink-3">
          Every submission is reviewed by the office before it is recorded.
        </p>
      </div>
    </div>
  );
}

/* ── Step 1: pick name + PIN ─────────────────────────────────────────────── */
function IdentifyStep({
  tid, sig, exp, employees, onVerified,
}: {
  tid: string;
  sig: string;
  exp: string;
  employees: Array<{ id: string; name: string }>;
  onVerified: (s: Session) => void;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [pin, setPin]   = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr]   = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!employeeId) { setErr("Pick your name"); return; }
    if (!/^\d{4,6}$/.test(pin)) { setErr("Enter your 4–6 digit PIN"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/public/expense-claim/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tid, sig, exp, employeeId, pin }),
      });
      const json = await res.json();
      if (!res.ok) { setErr(json.error ?? "Could not verify. Please try again."); return; }
      const name = employees.find((x) => x.id === employeeId)?.name ?? "";
      onVerified({ employeeId, employeeName: name, pin, remaining: Number(json.remaining ?? 0) });
    } catch {
      setErr("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-5">
        <p className="text-3xs font-semibold uppercase tracking-wider text-ink-3">Expense advance</p>
        <h1 className="mt-1 font-serif text-2xl leading-tight text-ink">Log your expenses</h1>
        <p className="mt-1 text-sm text-ink-3">
          Enter your PIN once, then add as many expenses as you need. The office reviews them.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <FormField label="Your name" required htmlFor="employeeId">
          <select
            id="employeeId"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            <option value="" disabled>Select your name</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </FormField>

        <FormField label="Your PIN" required htmlFor="pin">
          <Input id="pin" type="password" inputMode="numeric" autoComplete="off"
            placeholder="4–6 digit attendance PIN" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </FormField>

        {err && (
          <div className="rounded-md border border-rose/40 bg-rose-soft px-3 py-2 text-sm text-rose-ink">{err}</div>
        )}

        <Button type="submit" variant="primary" className="w-full" loading={busy}>Continue</Button>
      </form>
    </>
  );
}

/* ── Step 2: log expenses (repeat) ───────────────────────────────────────── */
function LogStep({
  tid, sig, exp, brandName, session, setSession, logged, setLogged, onSwitch, employeeName,
}: {
  tid: string;
  sig: string;
  exp: string;
  brandName: string;
  session: Session;
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  logged: Logged[];
  setLogged: React.Dispatch<React.SetStateAction<Logged[]>>;
  onSwitch: () => void;
  employeeName: string;
}) {
  const [amount, setAmount]     = React.useState("");
  const [spentOn, setSpentOn]   = React.useState(todayISO());
  const [category, setCategory] = React.useState("");
  const [purpose, setPurpose]   = React.useState("");
  const [photo, setPhoto]       = React.useState<string | null>(null);
  const [busy, setBusy]         = React.useState(false);
  const [err, setErr]           = React.useState<string | null>(null);
  const [flash, setFlash]       = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const remaining = session.remaining;

  function resetFields() {
    setAmount(""); setCategory(""); setPurpose(""); setPhoto(null); setSpentOn(todayISO());
    setEditingId(null);
  }

  function startEdit(l: Logged) {
    setEditingId(l.id);
    setAmount(String(l.amount));
    setCategory(l.category);
    setPurpose(l.purpose ?? "");
    setSpentOn(l.spentOn);
    setErr(null); setFlash(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function doDelete(l: Logged) {
    setErr(null); setFlash(null);
    try {
      const res = await fetch("/api/public/expense-claim/manage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", tid, sig, exp, employeeId: session.employeeId, pin: session.pin, claimId: l.id }),
      });
      const json = await res.json();
      if (!res.ok) { setErr(json.error ?? "Couldn't delete. Please try again."); return; }
      setLogged((prev) => prev.filter((x) => x.id !== l.id));
      setSession((s) => (s ? { ...s, remaining: Number(json.remaining ?? s.remaining + l.amount) } : s));
      if (editingId === l.id) resetFields();
      setFlash(`Removed ${rupee(l.amount)} · ${l.category}`);
    } catch {
      setErr("Network error. Please try again.");
    }
  }

  function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) { setPhoto(null); return; }
    if (file.size > 4_000_000) { setErr("Receipt photo is too large (max 4 MB)."); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => setPhoto(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null); setFlash(null);
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) { setErr("Enter a valid amount"); return; }
    if (!category) { setErr("Choose a category"); return; }
    setBusy(true);
    try {
      if (editingId) {
        // Editing an existing pending claim.
        const res = await fetch("/api/public/expense-claim/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "edit", tid, sig, exp, employeeId: session.employeeId, pin: session.pin,
            claimId: editingId, amount: amt, category, purpose: purpose || null, spentOn,
          }),
        });
        const json = await res.json();
        if (!res.ok) { setErr(json.error ?? "Couldn't save changes."); return; }
        setLogged((prev) => prev.map((x) => x.id === editingId
          ? { ...x, amount: amt, category, purpose: purpose || null, spentOn } : x));
        setSession((s) => (s ? { ...s, remaining: Number(json.remaining ?? s.remaining) } : s));
        setFlash(`Updated ${rupee(amt)} · ${category}`);
        resetFields();
        return;
      }

      if (amt > remaining) { setErr(`That's more than your remaining advance (${rupee(remaining)})`); return; }
      const res = await fetch("/api/public/expense-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tid, sig, exp, employeeId: session.employeeId, pin: session.pin,
          amount: amt, category, purpose: purpose || null, spentOn, photo,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setErr(json.error ?? "Something went wrong. Please try again."); return; }
      setLogged((prev) => [{ id: json.claimId, category, amount: amt, spentOn, purpose: purpose || null }, ...prev]);
      setSession((s) => (s ? { ...s, remaining: Number(json.remaining ?? Math.max(0, s.remaining - amt)) } : s));
      setFlash(`Added ${rupee(amt)} · ${category}`);
      resetFields();
    } catch {
      setErr("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const spent = logged.reduce((s, l) => s + l.amount, 0);
  const noneLeft = remaining <= 0;

  return (
    <>
      {/* Who + remaining */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-3xs font-semibold uppercase tracking-wider text-ink-3">Logging for</p>
          <h1 className="mt-0.5 font-serif text-xl leading-tight text-ink">{employeeName}</h1>
        </div>
        <button type="button" onClick={onSwitch} className="text-xs text-ink-3 underline hover:text-ink">
          Not you?
        </button>
      </div>

      <div className="mb-5 rounded-xl border border-hairline bg-paper-2 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-3">Left to claim</span>
          <span className="font-serif text-2xl text-ink">{rupee(remaining)}</span>
        </div>
        {logged.length > 0 && (
          <div className="mt-1 text-xs text-ink-3">{logged.length} logged this session · {rupee(spent)}</div>
        )}
      </div>

      {(noneLeft && !editingId) ? (
        <div className="rounded-lg border border-emerald/30 bg-emerald-soft px-4 py-5 text-center">
          <Icon name="check_circle" size={28} className="mx-auto text-emerald" />
          <p className="mt-2 text-sm text-ink-2">Your advance is fully claimed. Thank you!</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {editingId && (
            <div className="flex items-center justify-between rounded-md border border-amber/40 bg-amber-soft px-3 py-2 text-xs text-amber-ink">
              <span>Editing an entry</span>
              <button type="button" className="underline" onClick={resetFields}>Cancel</button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Amount spent (₹)" required htmlFor="amount">
              <Input id="amount" type="number" min={1} inputMode="numeric" placeholder="e.g. 1200"
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Date" required htmlFor="spentOn">
              <Input id="spentOn" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
            </FormField>
          </div>

          <FormField label="Category" required htmlFor="category">
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              <option value="" disabled>Select category</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </FormField>

          <FormField label="What was it for? (optional)" htmlFor="purpose">
            <Input id="purpose" placeholder="e.g. Client visit auto fare"
              value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </FormField>

          {!editingId && (
            <div>
              <label htmlFor="expense-claim-receipt" className="mb-1.5 block text-sm font-medium text-ink">Receipt photo (optional)</label>
              <input id="expense-claim-receipt"
                type="file" accept="image/*" capture="environment" onChange={onPhoto}
                className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-paper-2 file:px-3 file:py-2 file:text-sm file:text-ink hover:file:bg-hairline"
              />
              {photo && <p className="mt-1 text-xs text-emerald">Receipt attached ✓</p>}
            </div>
          )}

          {err && (
            <div className="rounded-md border border-rose/40 bg-rose-soft px-3 py-2 text-sm text-rose-ink">{err}</div>
          )}
          {flash && (
            <div className="rounded-md border border-emerald/30 bg-emerald-soft px-3 py-2 text-sm text-emerald">{flash} ✓</div>
          )}

          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            {editingId ? "Save changes" : "Add expense"}
          </Button>
        </form>
      )}

      {/* Session list */}
      {logged.length > 0 && (
        <div className="mt-6 border-t border-hairline pt-4">
          <p className="mb-2 text-3xs font-semibold uppercase tracking-wider text-ink-3">Submitted just now</p>
          <ul className="space-y-1.5">
            {logged.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 rounded-md bg-paper-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-ink-2">{l.category}</span>
                    <span className="font-mono text-ink">{rupee(l.amount)}</span>
                  </div>
                  {l.purpose && <div className="truncate text-xs text-ink-3">{l.purpose}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => startEdit(l)} aria-label="Edit"
                    className="rounded p-1 text-ink-3 hover:bg-hairline hover:text-ink">
                    <Icon name="edit" size={15} />
                  </button>
                  <button type="button" onClick={() => doDelete(l)} aria-label="Delete"
                    className="rounded p-1 text-ink-3 hover:bg-rose-soft hover:text-rose">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-center text-xs text-ink-3">
            All sent to {brandName} for approval. You can edit or remove any of them above until then.
          </p>
        </div>
      )}
    </>
  );
}
