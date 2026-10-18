/**
 * R-1529 — Settings → Company → "GST registration".
 *
 * Registered (Tax Invoice + GST) / Not registered (Bill of Supply, no GST) / Composition
 * scheme (Bill of Supply + "composition taxable person" line; the business pays the
 * composition rate on its turnover itself). Plus the registration effective date (q4: Tax
 * Invoices from that date).
 *
 * Its own Save, like TurnoverCard, because the columns arrive in their own migration: until
 * that is applied the card says so and stays read-only. Rules live in
 * lib/compliance/gst-registration.ts; the database enforces them again at issue.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  GST_REGISTRATIONS, GST_REGISTRATION_HINT, GST_REGISTRATION_LABEL, DEFAULT_COMPOSITION_RATE,
  effectiveGstRegistration, gstRegistrationProblem, type GstRegistration,
} from "@/lib/compliance/gst-registration";
import { useGstRegistration, useSaveGstRegistration } from "@/lib/compliance/gst-registration-query";

export function GstRegistrationCard({ isOwner, gstin }: { isOwner: boolean; gstin: string | null | undefined }) {
  const { data: saved, isLoading, isError } = useGstRegistration();
  const save = useSaveGstRegistration();

  const savedChoice = saved ? effectiveGstRegistration(saved.saved, gstin) : null;
  const [choice, setChoice] = React.useState<GstRegistration | null>(null);
  const [rate, setRate] = React.useState<string>(String(DEFAULT_COMPOSITION_RATE));
  const [from, setFrom] = React.useState<string>("");

  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!saved || loaded.current) return;
    loaded.current = true;
    setChoice(effectiveGstRegistration(saved.saved, gstin));
    setRate(String(saved.compositionRate));
    setFrom(saved.registeredFrom ?? "");
  }, [saved, gstin]);

  const missing = Boolean(saved?.columnMissing);
  const dirty = !!saved && (
    choice !== savedChoice
    || (choice === "composition" && Number(rate) !== saved.compositionRate)
    || (from || null) !== saved.registeredFrom
    /* Never chosen but defaulted from the GSTIN: saving makes the default explicit. */
    || (saved.saved === null && choice !== null)
  );
  const problem = choice
    ? gstRegistrationProblem({ status: choice, gstin, compositionRate: rate, registeredFrom: from || null })
    : null;
  const disabled = !isOwner || missing || save.isPending || isLoading;
  const canSave = isOwner && !missing && dirty && !!choice && !problem && !save.isPending;

  const discard = () => {
    setChoice(savedChoice);
    setRate(String(saved?.compositionRate ?? DEFAULT_COMPOSITION_RATE));
    setFrom(saved?.registeredFrom ?? "");
  };

  return (
    <Card className="p-5 max-w-3xl" data-gst-registration-card>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">GST registration</p>
        {missing ? <Badge kind="muted">Coming soon</Badge>
          : !isOwner ? <Badge kind="muted">Owner-only · view</Badge>
          : dirty ? <Badge kind="warning" dot>Unsaved changes</Badge>
          : null}
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Decides whether you issue a Tax Invoice (with GST) or a Bill of Supply (no GST). Invoices
        already issued never change.
        {missing && " Needs a database update before it can be saved — invoices stay Tax Invoices till then."}
      </p>

      {isError ? (
        <p className="text-xs text-rose">Could not load the GST registration. Refresh to try again.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div role="group" aria-label="GST registration" className="flex flex-wrap gap-1.5">
              {GST_REGISTRATIONS.map((o) => {
                const on = choice === o;
                return (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => setChoice(o)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed ${
                      on ? "bg-amber text-white border-amber" : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
                    }`}
                  >
                    {GST_REGISTRATION_LABEL[o]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-3xs text-ink-3">
              {choice ? GST_REGISTRATION_HINT[choice] : "Not chosen yet — invoices are issued as Tax Invoices, which need your GSTIN."}
            </p>
          </div>

          {(choice === "composition" || choice === "registered") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {choice === "composition" && (
                <div>
                  <label htmlFor="settings-gst-composition-rate" className="block text-xs font-medium text-ink-2 mb-1">
                    Composition rate (% of turnover)
                  </label>
                  <Input
                    id="settings-gst-composition-rate"
                    type="number"
                    min={0.01}
                    max={10}
                    step={0.01}
                    className="font-mono"
                    value={rate}
                    disabled={disabled}
                    onChange={(e) => setRate(e.target.value)}
                  />
                  <p className="mt-1 text-3xs text-ink-3">
                    Services: 6%. You pay this on your turnover every quarter — it is never added to a customer&apos;s bill.
                  </p>
                </div>
              )}
              <div>
                <label htmlFor="settings-gst-registered-from" className="block text-xs font-medium text-ink-2 mb-1">
                  Registration effective date (optional)
                </label>
                <Input
                  id="settings-gst-registered-from"
                  type="date"
                  value={from}
                  disabled={disabled}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <p className="mt-1 text-3xs text-ink-3">
                  The date on your GST registration certificate. Bills dated before it are issued as Bills of Supply.
                </p>
              </div>
            </div>
          )}

          {problem && (
            <p role="alert" className="text-xs text-rose">{problem}</p>
          )}

          {isOwner && !missing && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="primary" icon="check"
                loading={save.isPending} disabled={!canSave}
                onClick={() => choice && save.mutate({ status: choice, gstin, compositionRate: rate, registeredFrom: from || null })}>
                Save GST registration
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={discard}>
                  Discard
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
