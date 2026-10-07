"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { COPY } from "@/lib/copy";

export function UnsubscribeClient({ t, e, s, c }: { t: string; e: string; s: string; c: string }) {
  const [state, setState] = React.useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  if (!t || !e || !s) {
    return <p className="text-ink-2">This link is incomplete. Open the full &ldquo;Unsubscribe&rdquo; link from the email.</p>;
  }

  async function confirm() {
    setState("busy");
    try {
      const res = await fetch("/api/public/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t, e, s, c: c || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setState("error"); setMessage(j.error ?? "Something went wrong."); return; }
      setState("done");
    } catch {
      setState("error"); setMessage("Check your internet connection and try again.");
    }
  }

  if (state === "done") {
    return (
      <div className="space-y-2">
        <p className="text-lg text-ink">{COPY.done} — <b>{e}</b> will no longer get marketing emails.</p>
        <p className="text-sm text-ink-3">You will still get important emails about invoices, renewals and your orders.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-ink-2">Stop offers and marketing emails to <b className="text-ink">{e}</b>?</p>
      <Button onClick={confirm} disabled={state === "busy"}>{state === "busy" ? "Working…" : "Yes, unsubscribe"}</Button>
      {state === "error" && message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  );
}
