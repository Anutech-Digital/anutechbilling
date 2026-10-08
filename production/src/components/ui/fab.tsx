/**
 * FAB — Floating Action Button (mobile-first primary action).
 *
 * Material-style fixed circular/pill button anchored to bottom-right
 * (above the bottom-nav, in the thumb zone). Used as the primary
 * call-to-action on listing pages where the desktop "+ Add" sits in the
 * header — too far to thumb-reach on mobile.
 *
 * Draggable (since 2026-05-26): if the user long-presses + drags the FAB,
 * it follows their finger. Drop position persists in localStorage so the
 * button stays where they left it across reloads. This helps when the
 * default bottom-right position covers important content below it
 * (last lead card, totals row, etc.). Tap-only invokes the action; drag
 * suppresses the click.
 *
 * Secondary action (since 2026-05-27): if `quickAction` is supplied, a
 * smaller mini-FAB is stacked just above the main FAB. Both share the
 * same drag transform (they live inside the same wrapper) so they move
 * together when the user drags. Used on /leads to surface the 4-field
 * Quick add as a secondary mobile entry point — main FAB still opens
 * the full lead form.
 *
 * Convention:
 *   - md:hidden by default — phones only. Desktop already has the
 *     header button. Pass `showOnDesktop` to override for special cases.
 *   - Positioned `right-4 bottom-20` (above the 64px bottom nav).
 *   - Branded amber background, white text.
 *   - When label provided, renders as a pill (extended FAB) — better
 *     affordance than icon-only. Icon-only available via `icon`-only.
 *
 * @example
 *   <FAB
 *     icon="plus"
 *     label="Add lead"
 *     onClick={() => router.push('/quotes/new')}
 *     quickAction={{ icon: "zap", label: "Quick", ariaLabel: "Quick add lead", onClick: () => setQuickOpen(true) }}
 *   />
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface FABQuickAction {
  /** lucide icon name (from our Icon component). */
  icon: string;
  /** Optional label — when set, mini-FAB renders as a pill. */
  label?: string;
  /** Required for a11y — describes what the secondary action does. */
  ariaLabel: string;
  onClick: () => void;
}

interface FABBaseProps {
  /** lucide icon name (from our Icon component). */
  icon:  string;
  /** When set, renders as a pill (extended FAB) with text. */
  label?: string;
  /** Override default md:hidden — render on desktop too. */
  showOnDesktop?: boolean;
  /** Extra classes for fine-tuning position. */
  className?: string;
  ariaLabel?: string;
  /** Optional secondary mini-FAB stacked above the main one.
   *  Shares the same drag offset (moves together when user drags). */
  quickAction?: FABQuickAction;
}

type FABButtonProps = FABBaseProps & {
  onClick: () => void;
  href?: never;
};

type FABLinkProps = FABBaseProps & {
  href: string;
  onClick?: never;
};

export type FABProps = FABButtonProps | FABLinkProps;

// Positioning — applied to the outer wrapper so both main + mini FABs
// share the same anchor + drag transform.
const positionStyles = cn(
  // Phones: 1rem above the bottom tab bar. --bottom-nav-h (app shell) already carries the
  // safe area, so the margin is desktop-only — R-268 had two drifting copies of that height.
  "fixed right-4 bottom-[calc(var(--bottom-nav-h,56px)+1rem)] md:bottom-6 z-30",
  "md:mb-[env(safe-area-inset-bottom)]",
  // Step aside while a BulkActionBar (data-bulk-bar) is open — same thumb zone.
  "[body:has([data-bulk-bar])_&]:hidden",
  // Drag handling
  "touch-none select-none",
);

// Stack — mini FAB on top, main FAB on bottom, right-aligned, small gap.
const stackStyles = "flex flex-col items-end gap-2.5";

// Main FAB — amber pill, generous touch target (h-14 = 56px).
const mainButtonStyles = cn(
  "inline-flex items-center justify-center gap-2",
  "rounded-full bg-amber text-white shadow-lg shadow-amber/30",
  "h-14 px-5",
  "hover:brightness-105 active:brightness-95 transition-shadow",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
);

// Mini FAB — paper-bg pill, smaller (h-11 = 44px, still ≥ minimum touch).
const miniButtonStyles = cn(
  "inline-flex items-center justify-center gap-1.5",
  "h-11 px-3.5 rounded-full bg-paper border border-hairline-strong text-ink shadow-md",
  "hover:bg-paper-2 transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
);

const STORAGE_KEY = "fab-offset";
const DRAG_THRESHOLD_PX = 6;  // any movement < this = treated as a click

export function FAB(props: FABProps) {
  const { icon, label, showOnDesktop, className, ariaLabel, quickAction } = props;
  const visibility = showOnDesktop ? "" : "md:hidden";

  // Drag-offset state. (0,0) = default anchored position (right-4, above the bottom nav).
  // Negative x → moves left of right-anchor. Negative y → moves up.
  const [offset, setOffset] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = React.useState(false);

  // Track pointer-down state across pointermove / pointerup. Stored in a ref
  // because we don't need to re-render mid-drag for it.
  const dragState = React.useRef<{
    startX:        number;
    startY:        number;
    initialOffset: { x: number; y: number };
    didDrag:       boolean;
  } | null>(null);

  // Suppress the click that fires immediately after a drag-pointerup. Lives
  // across the pointerup → click event sequence (~50ms).
  const lastWasDragRef = React.useRef(false);

  // Restore saved position on mount (browser only)
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { x?: number; y?: number };
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          setOffset({ x: parsed.x, y: parsed.y });
        }
      }
    } catch {
      // localStorage unavailable / corrupt JSON — fall back to default position
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // Only respond to primary buttons / touch / pen
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // IMPORTANT: do NOT call setPointerCapture here.
    // The pointer handlers live on the wrapper div but the actual clickable
    // elements are the child buttons (main FAB + optional mini-FAB).
    // Capturing the pointer on the wrapper at pointerdown steals click-event
    // synthesis from the child buttons — a tap on the mini-FAB never fires
    // its onClick. We defer capture to onPointerMove and only call it once
    // the drag threshold (DRAG_THRESHOLD_PX) is actually crossed.
    dragState.current = {
      startX:        e.clientX,
      startY:        e.clientY,
      initialOffset: offset,
      didDrag:       false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (!dragState.current.didDrag && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
      dragState.current.didDrag = true;
      setIsDragging(true);
      // Drag confirmed — NOW capture the pointer so pointermove keeps flowing
      // even if the finger leaves the FAB bounds. Wrap in try/catch in case
      // the pointer is no longer active (Safari occasionally).
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore — drag still works without capture, just less robust
        // when pointer leaves the element bounds.
      }
    }
    if (dragState.current.didDrag) {
      setOffset({
        x: dragState.current.initialOffset.x + dx,
        y: dragState.current.initialOffset.y + dy,
      });
    }
  };

  const finishDrag = () => {
    if (!dragState.current) return;
    const didDrag = dragState.current.didDrag;
    dragState.current = null;
    setIsDragging(false);
    if (didDrag) {
      // Persist new position
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
      } catch {
        // ignore quota / SSR
      }
      // Suppress the imminent click event so onClick / href navigation
      // doesn't fire just because the user moved the button.
      lastWasDragRef.current = true;
      setTimeout(() => { lastWasDragRef.current = false; }, 100);
    }
  };

  const handleMainClick = (e: React.MouseEvent<HTMLElement>) => {
    if (lastWasDragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ("onClick" in props && props.onClick) {
      props.onClick();
    }
  };

  const handleQuickClick = (e: React.MouseEvent<HTMLElement>) => {
    if (lastWasDragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    quickAction?.onClick();
  };

  // Drag transform applied to the outer wrapper — moves both stacked FABs together.
  const dragStyle: React.CSSProperties = {
    transform: `translate(${offset.x}px, ${offset.y}px)`,
    transition: isDragging ? "none" : "transform 200ms cubic-bezier(0.2, 0, 0, 1)",
    cursor: isDragging ? "grabbing" : undefined,
  };

  const mainContent = (
    <>
      <Icon name={icon} size={20} />
      {label && <span className="text-sm font-semibold whitespace-nowrap">{label}</span>}
    </>
  );

  const mainButton = "href" in props && props.href ? (
    <Link
      href={props.href as never}
      className={cn(mainButtonStyles, className)}
      aria-label={ariaLabel ?? label ?? icon}
      onClick={handleMainClick}
    >
      {mainContent}
    </Link>
  ) : (
    <button
      type="button"
      className={cn(mainButtonStyles, className)}
      aria-label={ariaLabel ?? label ?? icon}
      onClick={handleMainClick}
    >
      {mainContent}
    </button>
  );

  return (
    <div
      className={cn(positionStyles, visibility, stackStyles)}
      style={dragStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {/* Secondary mini-FAB (optional) — stacked above the main one. */}
      {quickAction && (
        <button
          type="button"
          className={miniButtonStyles}
          aria-label={quickAction.ariaLabel}
          onClick={handleQuickClick}
        >
          <Icon name={quickAction.icon} size={14} className="text-amber" />
          {quickAction.label && (
            <span className="text-xs font-semibold whitespace-nowrap">{quickAction.label}</span>
          )}
        </button>
      )}
      {mainButton}
    </div>
  );
}
