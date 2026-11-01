"use client";

/**
 * R-2013: the "Your data" request form, in two steps on one page.
 *   1. Name, email (the code goes there), mobile (optional, helps us find your records),
 *      what you want, details → POST /api/public/privacy-request → a code is emailed.
 *   2. The 6-digit code → POST /api/public/privacy-request/verify → "received, answer by <date>".
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTurnstile } from "@/components/shared/turnstile";
import { cn } from "@/lib/utils";
import { PRIVACY_REQUEST_KINDS, DPDP_RESPONSE_DAYS, type PrivacyRequestKind } from "@/lib/privacy/requests";

type Step = { at: "form" } | { at: "code"; requestId: string; email: string; minutes: number } | { at: "done"; dueBy: string | null; kind: string | null };

export function formatDue(iso: string | null): string {
  if (!iso) return `within ${DPDP_RESPONSE_DAYS} days`;
  const d = new Date(`${iso}T00:00:00Z`);
  return `by ${d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
}

export function PrivacyRequestClient() {
  const [step, setStep] = React.useState<Step>({ at: "form" });
  const [fullName, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [kind, setKind] = React.useState<PrivacyRequestKind | "">("");
  const [details, setDetails] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const ts = useTurnstile();

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json: json as Record<string, unknown> };
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!kind) { setError("Choose what you want us to do."); return; }
    setBusy(true);
    try {
      const { ok, json } = await post("/api/public/privacy-request", { fullName, email, phone, kind, details }, ts.headers);
      if (!ok) { ts.reset(); setError(String(json.error ?? "Something went wrong. Please try again.")); return; }
      setStep({ at: "code", requestId: String(json.requestId), email: email.trim().toLowerCase(), minutes: Number(json.minutes) || 15 });
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (step.at !== "code") return;
    setError(null);
    setBusy(true);
    try {
      const { ok, json } = await post("/api/public/privacy-request/verify", { requestId: step.requestId, code });
      if (!ok) { setError(String(json.error ?? "We could not check the code. Try again.")); return; }
      setStep({ at: "done", dueBy: (json.dueBy as string | null) ?? null, kind: (json.kind as string | null) ?? null });
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const selected = PRIVACY_REQUEST_KINDS.find((k) => k.id === kind);
  const detailsNeeded = kind === "correction" || kind === "nominate";

  return (
    <div className="min-h-screen bg-paper-2">
      <main className="mx-auto max-w-lg px-4 py-8 md:py-12">
        <div className="rounded-2xl border border-hairline bg-paper p-6 shadow-sm md:p-8">
          {step.at === "done" ? (
            <div className="py-4 text-center" data-testid="privacy-request-done">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-soft">
                <Icon name="check" size={28} className="text-emerald" />
              </div>
              <h1 className="font-serif text-2xl text-ink">Request received</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm text-ink-2">
                Your email is confirmed. We will answer {formatDue(step.dueBy)}.
                {step.kind === "withdraw_consent" && " Offers, greetings and follow-ups to you have already stopped."}
              </p>
            </div>
          ) : step.at === "code" ? (
            <form onSubmit={onVerify} className="space-y-4">
              <div>
                <p className="text-3xs font-semibold uppercase tracking-wider text-ink-3">Step 2 of 2</p>
                <h1 className="mt-1 font-serif text-2xl leading-tight text-ink">Enter the code</h1>
                <p className="mt-1 text-sm text-ink-3">
                  We emailed a 6-digit code to <b className="text-ink-2 [overflow-wrap:anywhere]">{step.email}</b>. It works for {step.minutes} minutes.
                </p>
              </div>
              <FormField label="Code" required htmlFor="pr-code">
                <Input id="pr-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 digits"
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
              </FormField>
              {error && <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft px-3 py-2 text-sm text-rose-ink">{error}</div>}
              <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== 6}>
                Confirm my request
              </Button>
              <button type="button" className="w-full text-center text-xs text-ink-3 underline" onClick={() => { setStep({ at: "form" }); setCode(""); setError(null); }}>
                Wrong email? Start again
              </button>
            </form>
          ) : (
            <form onSubmit={onSend} className="space-y-4">
              <div>
                <p className="text-3xs font-semibold uppercase tracking-wider text-ink-3">Your data</p>
                <h1 className="mt-1 font-serif text-2xl leading-tight text-ink">Make a request about your data</h1>
                <p className="mt-1 text-sm text-ink-3">
                  We confirm your email with a code, then answer within {DPDP_RESPONSE_DAYS} days.
                </p>
              </div>

              <FormField label="Your name" required htmlFor="pr-name">
                <Input id="pr-name" autoComplete="name" value={fullName} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Email" required htmlFor="pr-email" hint="We send the code here">
                  <Input id="pr-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </FormField>
                <FormField label="Mobile" htmlFor="pr-phone" hint="Optional — helps us find your records">
                  <Input id="pr-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </FormField>
              </div>

              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">What do you want us to do? <span className="text-rose">*</span></legend>
                <div className="space-y-2">
                  {PRIVACY_REQUEST_KINDS.map((k) => (
                    <label key={k.id} className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2",
                      kind === k.id ? "border-amber bg-amber-soft" : "border-hairline bg-paper",
                    )}>
                      <input type="radio" name="pr-kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} className="mt-1" />
                      <span>
                        <span className="block text-sm font-medium text-ink">{k.label}</span>
                        <span className="block text-xs text-ink-3">{k.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <FormField
                label={kind === "correction" ? "What is wrong, and what should it be?" : kind === "nominate" ? "Who do you nominate? (name and email or phone)" : "Details"}
                required={detailsNeeded} htmlFor="pr-details">
                <textarea id="pr-details" rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)}
                  placeholder={selected?.id === "erasure" ? "Optional — e.g. which account or order" : "Optional"}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber/40" />
              </FormField>

              {error && <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft px-3 py-2 text-sm text-rose-ink">{error}</div>}
              <p className="text-xs text-ink-3">
                We use these details only to answer this request. <a href="/privacy-policy#your-rights" className="underline">Your rights</a>
              </p>
              {ts.widget}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                Email me a code
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
