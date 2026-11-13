/**
 * Settings → Branding → "Website theme": switch the public website between its Classic look and
 * the "Warm & approachable" theme (docs/WEBSITE-THEME.md), and back.
 *
 * Renders nothing unless the signed-in person is the OWNER of the workspace that owns the
 * website — the route (/api/settings/website-theme) decides that. Theme only: no page text,
 * price or link changes with the switch.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useSetWebsiteTheme, useWebsiteTheme } from "@/lib/queries/website-theme";
import { WEBSITE_THEMES, WEBSITE_THEME_LABELS, type WebsiteTheme } from "@/lib/website-theme";

/** A small preview of each theme's ground + main colours, so the choice is not words alone. */
const SWATCHES: Record<WebsiteTheme, string[]> = {
  classic: ["#FFFFFF", "#1668E3", "#0C1116"],
  warm: ["#F5F7F4", "#0E6B5C", "#F4B740"],
};

export default function WebsiteThemeCard() {
  const { data, isLoading } = useWebsiteTheme();
  const setTheme = useSetWebsiteTheme();
  const confirm = useConfirm();

  if (isLoading || !data?.visible) return null;

  const current = data.theme;
  const disabled = !data.ready || setTheme.isPending;

  const choose = async (theme: WebsiteTheme) => {
    if (theme === current || disabled) return;
    const ok = await confirm({
      title: `Switch the website to ${WEBSITE_THEME_LABELS[theme].name}?`,
      body:
        "Every visitor to the public website sees the new look on their next page load. " +
        "Only colours, fonts and shapes change — no text, price or link.\nYou can switch back here at any time.",
      confirmLabel: "Switch theme",
      icon: "paint",
    });
    if (ok) setTheme.mutate(theme);
  };

  return (
    <Card className="p-5 md:p-6 max-w-2xl mt-6">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-serif text-xl text-ink">Website theme</h2>
        <Badge kind="muted">Owner only</Badge>
      </div>
      <p className="text-sm text-ink-3 mt-1 mb-5">
        How the public website looks. Switching changes colours, fonts and shapes only — every page keeps its text.
      </p>

      {!data.ready && data.error && (
        <p role="status" className="mb-4 rounded-md border border-hairline bg-paper-2 px-3 py-2 text-sm text-ink-2">
          {data.error}
        </p>
      )}

      <div role="group" aria-label="Website theme" className="grid gap-3 sm:grid-cols-2">
        {WEBSITE_THEMES.map((t) => {
          const on = current === t;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              disabled={disabled && !on}
              onClick={() => void choose(t)}
              className={`text-left rounded-lg border p-4 min-h-[44px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed ${
                on ? "border-amber bg-amber-soft" : "border-hairline bg-paper hover:border-hairline-strong"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{WEBSITE_THEME_LABELS[t].name}</span>
                {on && <Badge kind="success">In use</Badge>}
              </span>
              <span aria-hidden="true" className="mt-3 flex gap-1.5">
                {SWATCHES[t].map((c) => (
                  <span key={c} className="h-5 w-5 rounded-full border border-hairline" style={{ backgroundColor: c }} />
                ))}
              </span>
              <span className="mt-2 block text-sm text-ink-3">{WEBSITE_THEME_LABELS[t].description}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-sm text-ink-3">
        <a href="/" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-2 hover:text-amber">
          Open the website
        </a>{" "}
        to see the theme in use.
      </p>
    </Card>
  );
}
