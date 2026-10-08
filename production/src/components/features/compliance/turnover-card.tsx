/**
 * R-337 — Settings → Company → "Aggregate turnover": which e-invoice rules apply.
 *
 * Above ₹5 Cr, B2B invoices need an IRN; ₹10 Cr or more, within 30 days. The app does not
 * generate IRNs yet, so the answer only switches on warnings (issue dialog, invoice page,
 * /invoices ageing). "Not sure" = no warnings = today's behaviour.
 *
 * Its own Save, like ComplianceProfileCard, because the column arrives in its own
 * migration: until that is applied the card says so and stays read-only.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  TURNOVER_BRACKETS, TURNOVER_BRACKET_LABEL, TURNOVER_BRACKET_HINT, type TurnoverBracket,
} from "@/lib/compliance/einvoice";
import { useTurnoverBracket, useSaveTurnoverBracket } from "@/lib/compliance/turnover";

type Choice = TurnoverBracket | "unsure";
const CHOICES: Choice[] = [...TURNOVER_BRACKETS, "unsure"];
const LABEL: Record<Choice, string> = { ...TURNOVER_BRACKET_LABEL, unsure: "Not sure" };
const HINT: Record<Choice, string> = { ...TURNOVER_BRACKET_HINT, unsure: "No e-invoice warnings are shown." };

export function TurnoverCard({ isOwner }: { isOwner: boolean }) {
  const { data: saved, isLoading, isError } = useTurnoverBracket();
  const save = useSaveTurnoverBracket();
  const [choice, setChoice] = React.useState<Choice>("unsure");

  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!saved || loaded.current) return;
    loaded.current = true;
    setChoice(saved.bracket ?? "unsure");
  }, [saved]);

  const savedChoice: Choice = saved?.bracket ?? "unsure";
  const missing = Boolean(saved?.columnMissing);
  const dirty = !!saved && choice !== savedChoice;
  const disabled = !isOwner || missing || save.isPending || isLoading;
  const canSave = isOwner && !missing && dirty && !save.isPending;

  return (
    <Card className="p-5 max-w-3xl" data-turnover-card>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Aggregate turnover (highest FY since 2017-18)</p>
        {missing ? <Badge kind="muted">Coming soon</Badge>
          : !isOwner ? <Badge kind="muted">Owner-only · view</Badge>
          : dirty ? <Badge kind="warning" dot>Unsaved changes</Badge>
          : null}
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Decides whether invoices warn about e-invoice IRN. The app does not generate IRNs yet.
        {missing && " Needs a database update before it can be saved — no warnings till then."}
      </p>

      {isError ? (
        <p className="text-xs text-rose">Could not load the turnover. Refresh to try again.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div role="group" aria-label="Aggregate turnover" className="flex flex-wrap gap-1.5">
              {CHOICES.map((o) => {
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
                    {LABEL[o]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-3xs text-ink-3">{HINT[choice]}</p>
          </div>
          {isOwner && !missing && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="primary" icon="check"
                loading={save.isPending} disabled={!canSave}
                onClick={() => save.mutate(choice === "unsure" ? null : choice)}>
                Save turnover
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setChoice(savedChoice)}>
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
