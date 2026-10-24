"use client";

/**
 * R-1679: what the customer sees on a quote that can no longer be accepted — expired (its
 * validity date passed, or marked expired) or rejected.
 *
 * Staging 19 Oct (Q-5F40-27-0096, "Valid until 18 Oct"): the page still showed a big
 * "Accept this quote · ₹38,232" a day later; pressing it only produced an error. Now: an honest
 * line (when it ran out), and ONE next step — "Request a fresh quote", which tells the reseller's
 * sales team in the app (POST …/request-fresh) instead of a mailto: link that did nothing when the
 * reseller had no email on record. Email / phone stay as plain fallbacks.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";

export function ExpiredQuote({ quoteId, status, expiresDate, token, tenantName, tenantEmail, tenantPhone }: {
  quoteId: string;
  status: "expired" | "rejected";
  expiresDate: string | null;
  token: string;
  tenantName: string;
  tenantEmail: string | null;
  tenantPhone?: string | null;
}) {
  const [state, setState] = React.useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [message, setMessage] = React.useState("");

  const request = async () => {
    setState("sending");
    try {
      const res = await fetch(`/api/public/quote/${encodeURIComponent(quoteId)}/request-fresh?t=${encodeURIComponent(token)}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not send the request.");
      setMessage(body.message ?? `${tenantName} has been told and will send you a fresh quote.`);
      setState("sent");
    } catch (e) {
      setMessage((e as Error).message);
      setState("failed");
    }
  };

  const expired = status === "expired";
  return (
    <div className="min-h-screen bg-paper-2/30 flex items-start justify-center py-10 px-4">
      <div className="max-w-2xl w-full bg-paper rounded-xl shadow-sm border border-hairline p-8 md:p-12 text-center">
        <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-rose/15 grid place-items-center">
          <Icon name="alert" size={32} className="text-rose" />
        </div>
        <h1 className="font-serif text-3xl text-ink mb-2">
          {expired ? "This quote has expired" : "This quote is no longer available"}
        </h1>
        <p className="text-sm text-ink-3">
          Quote <span className="font-mono">{quoteId}</span>
          {expired && expiresDate ? <> was valid until <b className="text-ink">{formatDate(expiresDate)}</b>, so it</> : null}
          {" "}can no longer be accepted online. Prices may have changed since — {tenantName} can send you an
          up-to-date quote.
        </p>

        {state === "sent" ? (
          <p role="status" className="mt-6 rounded-md border border-emerald/40 bg-emerald/10 px-4 py-3 text-sm text-ink">
            {message}
          </p>
        ) : (
          <Button variant="primary" className="mt-6" loading={state === "sending"} onClick={request}>
            Request a fresh quote
          </Button>
        )}
        {state === "failed" && (
          <p role="alert" className="mt-3 text-sm text-rose">{message}</p>
        )}

        {(tenantEmail || tenantPhone) && (
          <p className="mt-4 text-xs text-ink-3">
            Or contact {tenantName}
            {tenantEmail && <> at <a className="underline" href={`mailto:${tenantEmail}?subject=${encodeURIComponent(`New quote request (ref ${quoteId})`)}`}>{tenantEmail}</a></>}
            {tenantPhone && <> {tenantEmail ? "or" : "on"} <a className="underline" href={`tel:${tenantPhone}`}>{tenantPhone}</a></>}.
          </p>
        )}
      </div>
    </div>
  );
}
