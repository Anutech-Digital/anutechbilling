"use client";

/**
 * R-1903 slice 1 — Settings → Security → Mobile number: verify MY mobile with a 6-digit OTP.
 *
 * Pardeep, 25 Oct 2026: "mobile otp ke through bhi login karne ka option do jaise zoho books me
 * hota hai". Login with the OTP is slice 2; it will only accept a number verified here.
 *
 * Flow: +91 number → Verify (sends the code) → type the code → Confirm code → "Verified".
 * The saved number stays as it is until a new one is verified. On a local server no SMS exists,
 * so the server hands the code back and it shows in the dashed "Local test" box — the routes
 * never do that on staging or live, where an unset SMS provider says so plainly.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadErrorInline } from "@/components/shared/load-error";
import { formatIndianMobile, localDigits, normalizeIndianMobile } from "@/lib/sms/phone";

interface MobileStatus { phone: string | null; verifiedAt: string | null; smsReady: boolean; devMode: boolean }
interface Sent { phone: string; sentTo: string; devCode?: string }
type Msg = { tone: "ok" | "err"; text: string } | null;

const KEY = ["settings", "mobile"] as const;

async function post(path: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(`/api/settings/mobile/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && !json.error, json };
}

export function MobileNumberCard() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<MobileStatus> => {
      const res = await fetch("/api/settings/mobile");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load your mobile number.");
      return j as MobileStatus;
    },
  });

  const [digits, setDigits] = React.useState<string | null>(null);   // null = not edited yet
  const [sent, setSent] = React.useState<Sent | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [wait, setWait] = React.useState(0);

  React.useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const saved = status.data?.phone ?? null;
  const verified = Boolean(status.data?.verifiedAt);
  const value = digits ?? localDigits(saved);
  const phone = normalizeIndianMobile(value);
  const sameAsVerified = verified && phone !== null && phone === normalizeIndianMobile(saved);

  async function send() {
    if (!phone) { setMsg({ tone: "err", text: "Enter a 10-digit Indian mobile number (it starts with 6, 7, 8 or 9)." }); return; }
    setBusy(true); setMsg(null);
    const { ok, json } = await post("send", { phone });
    setBusy(false);
    if (!ok) {
      setMsg({ tone: "err", text: String(json.error ?? "The code could not be sent. Try again in a minute.") });
      if (typeof json.retryAfterSeconds === "number" && json.reason === "cooldown") setWait(json.retryAfterSeconds);
      return;
    }
    setSent({ phone, sentTo: String(json.sentTo ?? ""), devCode: typeof json.devCode === "string" ? json.devCode : undefined });
    setCode("");
    setWait(typeof json.resendAfterSeconds === "number" ? json.resendAfterSeconds : 30);
    setMsg({ tone: "ok", text: `Code sent to ${String(json.sentTo ?? "your mobile")}. It works for 5 minutes.` });
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!sent) return;
    setBusy(true); setMsg(null);
    const { ok, json } = await post("verify", { phone: sent.phone, code: code.trim() });
    setBusy(false);
    if (!ok) { setMsg({ tone: "err", text: String(json.error ?? "The code could not be checked. Try again.") }); return; }
    setSent(null); setCode(""); setDigits(null); setWait(0);
    setMsg({ tone: "ok", text: `${formatIndianMobile(sent.phone)} is verified.` });
    await qc.invalidateQueries({ queryKey: KEY });
  }

  function cancel() {
    setSent(null); setCode(""); setMsg(null);
  }

  return (
    <Card className="mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-ink">Mobile number</h3>
        {status.data && saved && (
          verified
            ? <Badge kind="success" dot>Verified</Badge>
            : <Badge kind="warning" dot>Not verified</Badge>
        )}
      </div>
      <p className="text-sm text-ink-3 mb-4">
        Your own mobile, proven with a one-time code. Soon you can sign in with it instead of a password.
      </p>

      {status.isLoading ? (
        <p className="text-sm text-ink-3">Checking…</p>
      ) : status.isError ? (
        <LoadErrorInline what="Your mobile number" error={status.error} onRetry={() => void status.refetch()} />
      ) : sent ? (
        <form onSubmit={confirm} className="space-y-3">
          <FormField label={`Code sent to ${sent.sentTo}`} required htmlFor="mob-code">
            <Input id="mob-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="max-w-[160px] text-center tracking-[0.3em] tabular-nums" />
          </FormField>
          {sent.devCode && (
            <p className="rounded-md border border-dashed border-amber bg-amber-soft px-3 py-2 text-sm text-amber-ink" data-testid="dev-otp">
              Local test only — no SMS was sent. Your code is <b className="font-mono tracking-widest">{sent.devCode}</b>.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Confirm code"}</Button>
            <Button type="button" variant="outline" onClick={send} disabled={busy || wait > 0}>
              {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
            </Button>
            <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <FormField label="Mobile number" htmlFor="mob-number">
            <Input id="mob-number" type="tel" inputMode="numeric" autoComplete="tel-national" prefix="+91"
              placeholder="98765 43210" maxLength={14} value={value}
              onChange={(e) => { setDigits(e.target.value); setMsg(null); }} />
          </FormField>
          {sameAsVerified ? (
            <p className="text-sm text-emerald-ink">This number is verified.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={send} disabled={busy || !value.trim() || wait > 0}>
                {busy ? "Sending…" : wait > 0 ? `Verify (wait ${wait}s)` : "Verify"}
              </Button>
              {verified && saved && (
                <span className="text-2xs text-ink-3">{formatIndianMobile(saved)} stays saved until the new number is verified.</span>
              )}
            </div>
          )}
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-sm ${msg.tone === "ok" ? "text-emerald-ink" : "text-rose-ink"}`} role={msg.tone === "err" ? "alert" : "status"}>
          {msg.text}
        </p>
      )}
    </Card>
  );
}

export default MobileNumberCard;
