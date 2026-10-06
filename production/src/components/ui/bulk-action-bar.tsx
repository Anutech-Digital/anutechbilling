/**
 * BulkActionBar — the one floating toolbar that appears when rows are selected.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Six pages already have checkbox multi-select, and two of them had grown their own bar:
 * `leads-bulk-bar.tsx` and the block inside `app/(app)/invoices/page.tsx`. Same intent, same
 * dark pill at the bottom of the viewport — and different padding (`px-2 py-1.5` against
 * `px-5 py-2.5`), different button styling, one with a border and one without, and the
 * dismiss action called "Clear" on one and "Deselect" on the other.
 *
 * None of that is a bug. It is drift, and drift in a toolbar is the kind a user feels rather
 * than reports: the same gesture on two screens produces two slightly different things, and
 * the app starts to feel assembled rather than designed. The third page to add bulk actions
 * would have copied whichever file its author happened to open.
 *
 * ─── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It holds no selection state, reads no rows, and fetches nothing. The parent owns the
 * `Set<string>` and passes a count; the bar is presentation plus an event emitter. That is
 * how `leads-bulk-bar.tsx` already worked, and it is why adopting this changed no behaviour
 * on either page.
 *
 * ─── THE CONFIRM STEP IS PART OF THE PRIMITIVE, DELIBERATELY ────────────────
 * `BulkBarConfirmButton` carries the two-step confirm that the leads bar had invented for its
 * delete. It lives here rather than in each page because the risk is a property of the SHAPE:
 * a dense pill of small buttons, a pointer already moving, and an action that applies to
 * every selected row at once. A destructive bulk action that fires on one click is a bad
 * afternoon regardless of which table it sits on.
 */
"use client";

import * as React from "react";
import { Icon, type IconProps } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * The icon vocabulary, taken from Icon itself rather than re-declared — a second list would
 * drift the first time somebody adds an icon.
 */
type IconName = IconProps["name"];

/** How long the armed confirm stays armed before disarming itself. */
const CONFIRM_TIMEOUT_MS = 4000;

export interface BulkActionBarProps {
  /** Number of selected rows. The bar renders nothing at 0. */
  count: number;
  /**
   * Singular noun for what is selected — "lead", "invoice". Pluralised here, so no caller
   * has to remember the `s`, and so the accessible label reads as a sentence.
   */
  noun: string;
  /** Clears the parent's selection set. */
  onClear: () => void;
  /** The actions. Use BulkBarButton / BulkBarConfirmButton / BulkBarDivider. */
  children?: React.ReactNode;
}

export function BulkActionBar({ count, noun, onClear, children }: BulkActionBarProps) {
  if (count === 0) return null;

  const plural = count === 1 ? noun : `${noun}s`;

  return (
    <div
      className={cn(
        /* Fixed bottom centre. On phones it must clear the bottom tab bar (same z-40, 56px +
           home indicator) — R-268: at bottom-6 it sat underneath it. --bottom-nav-h is set
           once on the app shell (app/(app)/layout.tsx) and already includes the safe area;
           desktop has no tab bar, so it keeps bottom-6 plus the safe-area margin (§20). */
        "fixed bottom-[calc(var(--bottom-nav-h,56px)+0.75rem)] left-1/2 z-40 -translate-x-1/2",
        "md:bottom-6 md:mb-[env(safe-area-inset-bottom)]",
        /* Never wider than a 375px phone; extra actions scroll inside the pill. */
        "max-w-[calc(100vw-1.5rem)] overflow-x-auto",
        /* Dark command surface, so it reads as an overlay rather than as page furniture. */
        "rounded-full bg-ink text-paper shadow-2xl",
        "flex items-center gap-1 px-2 py-1.5",
        "animate-in fade-in slide-in-from-bottom-2 duration-150",
      )}
      role="toolbar"
      /* The FAB hides itself while this is on screen (fab.tsx) — two floating controls in
         the same thumb zone is one too many. */
      data-bulk-bar=""
      aria-label={`Bulk actions on ${count} selected ${plural}`}
    >
      <div className="whitespace-nowrap px-3 py-1.5 text-xs font-semibold tabular-nums">
        {count} selected
      </div>

      <BulkBarDivider />

      {children}

      {children ? <BulkBarDivider /> : null}

      {/* Last, so dismissing the bar is the easiest thing to reach. */}
      <BulkBarButton icon="x" onClick={onClear} label="Clear selection">
        Clear
      </BulkBarButton>
    </div>
  );
}

export function BulkBarDivider() {
  return <span className="h-5 w-px bg-paper/20" aria-hidden="true" />;
}

export interface BulkBarButtonProps {
  icon?: IconName;
  onClick: () => void;
  /** Accessible label when the visible text is not enough on its own. */
  label?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  children: React.ReactNode;
}

export function BulkBarButton({
  icon, onClick, label, disabled, tone = "default", children,
}: BulkBarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        "focus-visible:bg-paper/10 focus-visible:outline-none",
        disabled
          ? "cursor-not-allowed opacity-40"
          : tone === "danger"
            ? "hover:bg-rose hover:text-paper"
            : "hover:bg-paper/10",
      )}
    >
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}

export interface BulkBarConfirmButtonProps {
  icon?: IconName;
  onConfirm: () => void;
  /** Resting label, e.g. "Delete". */
  children: React.ReactNode;
  /** Armed label. Defaults to "Tap to confirm". */
  confirmLabel?: string;
}

/**
 * A bulk action that needs two clicks.
 *
 * Arms on the first click and disarms itself after {@link CONFIRM_TIMEOUT_MS}, so a bar left
 * armed while the user goes to read something does not fire later on a stray click. The
 * timeout is the part worth keeping: a confirm that stays armed forever is a confirm the user
 * stops seeing.
 */
export function BulkBarConfirmButton({
  icon, onConfirm, children, confirmLabel = "Tap to confirm",
}: BulkBarConfirmButtonProps) {
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      /* Announced, not just recoloured — a screen-reader user gets no benefit from the button
         turning red, and this is the click that cannot be undone. */
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        armed ? "bg-rose text-paper hover:bg-rose/90" : "hover:bg-paper/10",
      )}
    >
      {icon && <Icon name={icon} size={13} />}
      {armed ? confirmLabel : children}
    </button>
  );
}
