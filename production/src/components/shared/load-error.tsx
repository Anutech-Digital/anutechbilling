"use client";

/**
 * When a money screen's query fails, the page must say so — not fall through to
 * `data ?? []` and print ₹0, which reads as "you have nothing" (S32, 1 Oct 2026).
 *
 * - `<LoadError>`: replaces the screen's content (one query feeds the whole page).
 * - `<LoadErrorInline>`: the same, small enough for a pane or a side rail (R-1534).
 * - `<LoadErrorBanner>`: sits above content built from several queries (dashboard),
 *   warning that the figures below are incomplete until they load.
 *
 * R-1533/R-1535: pass the `error` and the body says WHY in plain words (network, access,
 * session…) via the same mapper the toasts use — never the raw database text, which goes
 * to the console for support instead (CLAUDE.md §11, §24).
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { describeError } from "@/lib/errors/toast-error";

const SAFE = "Your data is safe, it just couldn't be fetched. Check the connection and try again.";

/**
 * The body line for a failed READ. Pure.
 *
 * describeError() passes text it does not recognise through unchanged, because on a SAVE
 * that is usually one of our own guard sentences. A read has no such guards, so here an
 * unrecognised message is treated as plumbing and never shown. Its "Nothing was saved"
 * descriptions are written for saves, so a read gets its own next step instead.
 */
export function loadErrorBody(error: unknown): string {
  if (error == null) return SAFE;
  const d = describeError(error);
  if (!d.translated || !d.raw) return SAFE;
  if (d.description && !/nothing was saved/i.test(d.description)) return `${d.message} ${d.description}`;
  return `${d.message} ${SAFE}`;
}

/** The raw text is for support, not the screen — keep it in the console. */
function useLogLoadError(what: string, error: unknown) {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    if (error != null) console.error(`[load-error] ${what}`, error);
  }, [what, error]);
}

export function LoadError({ what, onRetry, error }: { what: string; onRetry: () => void; error?: unknown }) {
  useLogLoadError(what, error);
  return (
    <Card className="py-2">
      <EmptyState
        icon="alert"
        title={`${what} didn't load`}
        body={loadErrorBody(error)}
        action={<Button variant="primary" icon="refresh" onClick={onRetry}>Try again</Button>}
      />
    </Card>
  );
}

export function LoadErrorInline({ what, onRetry, error }: { what: string; onRetry: () => void; error?: unknown }) {
  useLogLoadError(what, error);
  return (
    <div role="alert" className="m-3 rounded-md border border-rose/40 bg-rose/5 px-3 py-3 text-sm">
      <p className="flex items-start gap-2">
        <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-rose" />
        <b className="text-ink">{what} didn&apos;t load.</b>
      </p>
      <p className="mt-1 text-xs text-ink-2">{loadErrorBody(error)}</p>
      <Button className="mt-2" size="sm" icon="refresh" onClick={onRetry}>Try again</Button>
    </div>
  );
}

export function LoadErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose/40 bg-rose/5 px-4 py-3">
      <div className="flex items-start gap-2 text-sm">
        <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-rose" />
        <span>
          <b className="text-ink">Some numbers didn't load.</b>{" "}
          <span className="text-ink-2">Amounts below may show ₹0 until they do. Your data is safe.</span>
        </span>
      </div>
      <Button size="sm" icon="refresh" onClick={onRetry}>Try again</Button>
    </div>
  );
}
