/**
 * R-1860 — Settings → Company → "What do you sell?" (Subscriptions / One-time products &
 * services / Both). Owner-only, changeable any time, its own Save.
 *
 * It only decides what the menu and dashboard put first (R-1861 / R-1862). Nothing is
 * switched off: every page still opens from its link or Ctrl+K, and each user can show all
 * modules from the bottom of the menu.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SELL_MODES, SELL_MODE_HINT, SELL_MODE_LABEL, type SellMode } from "@/lib/sell-mode";
import { useSaveSellMode, useSellMode } from "@/lib/queries/sell-mode";

export function SellModeCard({ isOwner }: { isOwner: boolean }) {
  const { data: saved, isLoading, isError } = useSellMode();
  const save = useSaveSellMode();
  const [mode, setMode] = React.useState<SellMode | null>(null);

  React.useEffect(() => {
    if (saved && mode === null) setMode(saved.mode);
  }, [saved, mode]);

  const missing = Boolean(saved?.columnMissing);
  const dirty = !!saved && mode !== null && mode !== saved.mode;
  const disabled = !isOwner || missing || save.isPending || isLoading;
  const headingId = React.useId();

  return (
    <Card id="sell-mode" role="region" className="p-5 max-w-3xl scroll-mt-20" aria-labelledby={headingId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p id={headingId} className="text-sm font-semibold text-ink">What do you sell?</p>
        {missing ? <Badge kind="muted">Coming soon</Badge>
          : !isOwner ? <Badge kind="muted">Owner-only · view</Badge>
          : dirty ? <Badge kind="warning" dot>Unsaved changes</Badge>
          : null}
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Decides what the menu and dashboard show first. Nothing is switched off — every page still
        opens from its link or Ctrl+K.
        {missing && " Needs a database update before it can be saved — everything is shown till then."}
      </p>

      {isError ? (
        <p className="text-xs text-rose">Could not load this setting. Refresh to try again.</p>
      ) : (
        <div className="space-y-3">
          <div role="group" aria-label="What do you sell?" className="flex flex-wrap gap-1.5">
            {SELL_MODES.map((o) => {
              const on = mode === o;
              return (
                <button
                  key={o}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => setMode(o)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed ${
                    on ? "bg-amber text-white border-amber" : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
                  }`}
                >
                  {SELL_MODE_LABEL[o]}
                </button>
              );
            })}
          </div>
          {mode && <p className="text-3xs text-ink-3">{SELL_MODE_HINT[mode]}</p>}
          {isOwner && !missing && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="primary" icon="check"
                loading={save.isPending} disabled={!dirty || save.isPending}
                onClick={() => mode && save.mutate(mode)}>
                Save
              </Button>
              {dirty && saved && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setMode(saved.mode)}>
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
