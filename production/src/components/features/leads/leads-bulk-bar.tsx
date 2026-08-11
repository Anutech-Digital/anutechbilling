/**
 * LeadsBulkBar — floating action toolbar shown when ≥1 lead is selected
 * in the desktop power table.
 *
 * Conventions:
 *   - Fixed at viewport bottom (centered, drop-shadow, dark surface).
 *   - Only renders when `count > 0`. Parent should mount unconditionally
 *     and pass `count={selectedIds.size}` so the slide-up animation has
 *     somewhere to mount from.
 *   - Action callbacks operate on the parent's selectedIds set. The bar
 *     itself never reads the leads array — it's pure presentation +
 *     event-emitter, no data fetching.
 *
 * Available actions (first cut):
 *   - Change stage (DropdownMenu)
 *   - Send WhatsApp / email (deferred — wired in v2)
 *   - Deselect all
 *   - Delete (with confirm)
 *
 * @example
 *   <LeadsBulkBar
 *     count={selected.size}
 *     onChangeStage={(s) => bulkUpdateStage(s)}
 *     onDeselectAll={() => setSelected(new Set())}
 *     onDelete={() => bulkDelete()}
 *   />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";

const LEAD_STAGES: { id: Lead["stage"]; label: string; dot: string }[] = [
  { id: "new",     label: "New",          dot: "bg-slate"   },
  { id: "contact", label: "Contacted",    dot: "bg-amber"   },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo"  },
  { id: "trial",   label: "Trial Active", dot: "bg-rose"    },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo"  },
  { id: "won",     label: "Won",          dot: "bg-emerald" },
  { id: "lost",    label: "Lost",         dot: "bg-ink-3"   },
];

interface LeadsBulkBarProps {
  count: number;
  /** Bulk change stage for all selected. */
  onChangeStage: (stage: Lead["stage"]) => void;
  /** Clear the selection set. */
  onDeselectAll: () => void;
  /** Optional — opens a confirm dialog before mutating. */
  onDelete?: () => void;
  /** Optional — mark all selected as junk (spam/fake). */
  onMarkJunk?: () => void;
}

export function LeadsBulkBar({
  count,
  onChangeStage,
  onDeselectAll,
  onDelete,
  onMarkJunk,
}: LeadsBulkBarProps) {
  // Confirm-on-delete state. Two-step prevents an accidental click on a
  // dense toolbar from nuking a stage-worth of leads.
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  React.useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  if (count === 0) return null;

  const handleDelete = () => {
    if (!onDelete) return;
    if (confirmDelete) {
      onDelete();
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
    }
  };

  return (
    <div
      className={cn(
        // Position — fixed bottom centre, above any sticky page footer.
        "fixed left-1/2 -translate-x-1/2 bottom-6 z-40",
        // Surface — dark "command bar" surface contrasts with the page.
        "bg-ink text-paper rounded-full shadow-2xl",
        "px-2 py-1.5 flex items-center gap-1",
        // Soft fade-in
        "animate-in fade-in slide-in-from-bottom-2 duration-150",
      )}
      role="toolbar"
      aria-label={`Bulk actions on ${count} selected leads`}
    >
      {/* Count chip */}
      <div className="px-3 py-1.5 text-xs font-semibold tabular-nums whitespace-nowrap">
        {count} selected
      </div>

      <span className="w-px h-5 bg-paper/20" aria-hidden="true" />

      {/* Change stage */}
      <DropdownMenu>
        <DropdownMenuTrigger className="px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 rounded-full hover:bg-paper/10 focus-visible:outline-none focus-visible:bg-paper/10 transition-colors">
          <Icon name="target" size={13} />
          Move to stage
          <Icon name="chevron_down" size={11} className="opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">
            Move {count} lead{count === 1 ? "" : "s"} to…
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {LEAD_STAGES.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onSelect={() => onChangeStage(s.id)}
              className="text-sm"
            >
              <span className={cn("w-2 h-2 rounded-full mr-2", s.dot)} />
              {s.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mark as junk — moves selected out of the working views */}
      {onMarkJunk && (
        <button
          type="button"
          onClick={onMarkJunk}
          className="px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 rounded-full hover:bg-paper/10 transition-colors"
        >
          <Icon name="alert" size={13} />
          Mark junk
        </button>
      )}

      {/* Delete with confirm */}
      {onDelete && (
        <button
          type="button"
          onClick={handleDelete}
          className={cn(
            "px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 rounded-full transition-colors",
            confirmDelete
              ? "bg-rose text-paper hover:bg-rose/90"
              : "hover:bg-paper/10",
          )}
        >
          <Icon name="trash" size={13} />
          {confirmDelete ? "Tap to confirm" : "Delete"}
        </button>
      )}

      <span className="w-px h-5 bg-paper/20" aria-hidden="true" />

      {/* Deselect — last action so it's easy to dismiss the bar */}
      <button
        type="button"
        onClick={onDeselectAll}
        className="px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 rounded-full hover:bg-paper/10 transition-colors"
        aria-label="Clear selection"
      >
        <Icon name="x" size={13} />
        Clear
      </button>
    </div>
  );
}
