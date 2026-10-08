"use client";

/**
 * Settings → Security → Two-step sign-in (R-048 part 2, 4 Oct 2026).
 * TOTP (Google Authenticator, Microsoft Authenticator, Authy…). Opt-in per person.
 * Turn on: scan the QR, type one code — only a code that verifies switches it on, so a
 * half-finished setup can never lock anyone out. After that every sign-in asks for a code
 * (login page + middleware → /mfa).
 */
import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Factor = { id: string; status: string; friendly_name?: string | null; created_at?: string };
type Setup = { factorId: string; qr: string; secret: string };

export function TwoFactorCard() {
  const [loading, setLoading] = React.useState(true);
  const [active, setActive] = React.useState<Factor | null>(null);
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const refresh = React.useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.mfa.listFactors();
    setActive((data?.totp ?? []).find((f) => f.status === "verified") ?? null);
    setLoading(false);
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  async function start() {
    setBusy(true); setMsg(null);
    const supabase = createClient();
    // Clear any setup someone started and never finished — it holds the friendly name.
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of (list?.all ?? []) as Factor[]) {
      if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `ResellerOS ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (error || !data) { setMsg({ tone: "err", text: `Could not start setup: ${error?.message ?? "unknown error"}` }); return; }
    setSetup({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!setup) return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) { setMsg({ tone: "err", text: "Enter the 6-digit code shown in the app." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId: setup.factorId, code: clean });
    setBusy(false);
    if (error) { setMsg({ tone: "err", text: "That code did not match. Use the code showing right now in the app." }); setCode(""); return; }
    setSetup(null); setCode("");
    setMsg({ tone: "ok", text: "Two-step sign-in is on. Next sign-in will ask for a code." });
    await refresh();
  }

  async function cancelSetup() {
    if (setup) await createClient().auth.mfa.unenroll({ factorId: setup.factorId });
    setSetup(null); setCode(""); setMsg(null);
  }

  async function turnOff() {
    if (!active) return;
    setBusy(true); setMsg(null);
    const { error } = await createClient().auth.mfa.unenroll({ factorId: active.id });
    setBusy(false);
    if (error) { setMsg({ tone: "err", text: `Could not turn it off: ${error.message}` }); return; }
    setMsg({ tone: "ok", text: "Two-step sign-in is off." });
    await refresh();
  }

  return (
    <Card className="mt-4">
      <h3 className="font-semibold text-ink mb-1">Two-step sign-in</h3>
      <p className="text-sm text-ink-3 mb-4">
        After your password, also ask for a 6-digit code from an authenticator app on your phone
        (Google Authenticator, Microsoft Authenticator, Authy). Recommended for owners and anyone
        who can see bank details or the password vault.
      </p>

      {loading ? (
        <p className="text-sm text-ink-3">Checking…</p>
      ) : active ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-emerald-ink font-medium">On — every sign-in asks for a code.</span>
          <Button variant="outline" onClick={turnOff} disabled={busy}>Turn off</Button>
        </div>
      ) : setup ? (
        <form onSubmit={confirm} className="space-y-3">
          <ol className="text-sm text-ink-2 list-decimal pl-5 space-y-1">
            <li>Open your authenticator app and scan this code.</li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element -- QR is a runtime data: URL; next.config images.unoptimized (R-331) */}
          <img src={setup.qr} alt="QR code to add ResellerOS to your authenticator app" width={180} height={180} className="rounded-md border border-hairline bg-white p-2" />
          <p className="text-xs text-ink-3">Can&apos;t scan? Enter this key in the app: <span className="font-mono break-all select-all">{setup.secret}</span></p>
          <label htmlFor="tf-code" className="block text-sm font-medium text-ink">Code from the app</label>
          <Input id="tf-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code}
            onChange={(e) => setCode(e.target.value)} className="max-w-[160px] text-center tracking-[0.3em] tabular-nums" />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>{busy ? "Checking…" : "Turn on"}</Button>
            <Button type="button" variant="ghost" onClick={cancelSetup} disabled={busy}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button variant="primary" onClick={start} disabled={busy}>{busy ? "Starting…" : "Set up two-step sign-in"}</Button>
      )}

      {msg && <p className={`mt-3 text-sm ${msg.tone === "ok" ? "text-emerald-ink" : "text-rose-ink"}`} role={msg.tone === "err" ? "alert" : "status"}>{msg.text}</p>}
    </Card>
  );
}
