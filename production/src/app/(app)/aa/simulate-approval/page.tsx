/**
 * /aa/simulate-approval?handle=<consent_handle_id>
 *
 * Mock-mode stand-in for Setu's actual consent screen. In production this
 * page is never visited — Setu's real domain handles approval. In dev (no
 * SETU_AA_* env keys), createConsent() points users here so the consent
 * → active → fetch flow can be exercised end-to-end on localhost.
 */
"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";

function SimulateApprovalInner() {
  const router = useRouter();
  const params = useSearchParams();
  const handle = params?.get("handle") ?? "";
  /* R-879: the signed state consent/init issued — the callback refuses without it. */
  const state = params?.get("state") ?? "";
  const [submitting, setSubmitting] = React.useState<"approve" | "reject" | null>(null);

  const callback = (approved: boolean) => {
    setSubmitting(approved ? "approve" : "reject");
    // The callback API route handles the redirect back to the bank account page
    router.push(
      `/api/aa/setu/callback?handle=${encodeURIComponent(handle)}&approved=${approved}&state=${encodeURIComponent(state)}` as Route,
    );
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      <Card>
        <div className="p-2">
          <div className="flex items-center gap-2 mb-3">
            <Badge kind="warning" size="sm" dot>Mock mode</Badge>
            <p className="text-2xs text-ink-3">
              (In production, this screen is on Setu&apos;s domain.)
            </p>
          </div>

          <div className="flex items-start gap-3 mb-5">
            <div className="w-10 h-10 rounded-full bg-amber-soft flex items-center justify-center">
              <Icon name="lock" size={18} className="text-amber-ink" />
            </div>
            <div>
              <h1 className="font-serif text-2xl text-ink leading-tight">
                Share bank data with ResellerOS
              </h1>
              <p className="text-sm text-ink-3 mt-1">
                ResellerOS is requesting read-only access to your bank transactions
                for the past 180 days, via the Account Aggregator framework.
              </p>
            </div>
          </div>

          <div className="rounded-md border border-hairline bg-paper-2/40 p-4 space-y-2 mb-5 text-sm">
            <Row label="What gets shared" value="Bank transactions (read-only)" />
            <Row label="Period"           value="Past 180 days + ongoing daily sync" />
            <Row label="Purpose"          value="Auto-reconcile customer payments + vendor expenses" />
            <Row label="Consent valid"    value="365 days, revocable anytime" />
            <Row label="Your VUA"         value={handle ? `(handle: ${handle.slice(0, 14)}…)` : "(no handle)"} />
          </div>

          <p className="text-2xs text-ink-3 mb-4 leading-relaxed">
            Under RBI&apos;s Account Aggregator regulations, your bank only shares the
            data ResellerOS asked for, only for the period you approve, and you
            can revoke this consent anytime from your AA app. Nothing else.
          </p>

          <div className="flex gap-3 justify-end">
            <Button
              variant="ghost"
              onClick={() => callback(false)}
              disabled={submitting !== null}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              icon="check_circle"
              onClick={() => callback(true)}
              loading={submitting === "approve"}
              disabled={submitting !== null}
            >
              Approve &amp; share data
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-2xs uppercase tracking-wider text-ink-3 font-semibold whitespace-nowrap">
        {label}
      </span>
      <span className="text-sm text-ink-2 text-right">{value}</span>
    </div>
  );
}

export default function SimulateApprovalPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading…</div>}>
      <SimulateApprovalInner />
    </React.Suspense>
  );
}
