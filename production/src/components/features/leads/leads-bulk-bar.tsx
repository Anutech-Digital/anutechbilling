/**
 * LeadsBulkBar — the lead-specific actions inside the shared floating toolbar.
 *
 * The shell (position, surface, count chip, dividers, clear button, the two-step confirm) now
 * lives in `components/ui/bulk-action-bar.tsx`. This file keeps only what is actually about
 * LEADS: the stage vocabulary and the three callbacks.
 *
 * ─── NOTHING ABOUT THE BEHAVIOUR CHANGED ────────────────────────────────────
 * Same props, same callbacks, same two-step delete, same render-nothing-at-zero. The parent
 * page was not edited. That was the point of extracting rather than rewriting: a toolbar
 * refactor that also changes what the buttons do is impossible to review, and this one sits
 * on a table where "Delete" applies to every selected row.
 *
 * The one visible difference is on the invoices page, not here — its bar used to say
 * "Deselect" where this one said "Clear". They now say the same word, which is the whole
 * reason the shell was extracted.
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
import {
  BulkActionBar,
  BulkBarButton,
  BulkBarConfirmButton,
} from "@/components/ui/bulk-action-bar";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import { STAGE_META } from "@/lib/leads/stage-meta";

/* R-290: the stage menu reads the one funnel-ordered table (quote → demo → trial) with Lost
   at the end — this file used to keep its own copy in demo → trial → quote order. */
const LEAD_STAGES = STAGE_META;

interface LeadsBulkBarProps {
  count: number;
  /** Bulk change stage for all selected. */
  onChangeStage: (stage: Lead["stage"]) => void;
  /** Clear the selection set. */
  onDeselectAll: () => void;
  /** Optional — two-step confirm before mutating. */
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
  return (
    <BulkActionBar count={count} noun="lead" onClear={onDeselectAll}>
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors hover:bg-paper/10 focus-visible:bg-paper/10 focus-visible:outline-none">
          <Icon name="target" size={13} />
          Change stage
          <Icon name="chevron_down" size={11} className="opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top">
          <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
            Move {count} lead{count === 1 ? "" : "s"} to…
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {LEAD_STAGES.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => onChangeStage(s.id)} className="text-sm">
              <span className={cn("mr-2 h-2 w-2 rounded-full", s.dot)} />
              {s.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Moves selected out of the working views. Not destructive, so no confirm. */}
      {onMarkJunk && (
        <BulkBarButton icon="alert" onClick={onMarkJunk}>
          Mark as junk
        </BulkBarButton>
      )}

      {onDelete && (
        <BulkBarConfirmButton icon="trash" onConfirm={onDelete}>
          Delete
        </BulkBarConfirmButton>
      )}
    </BulkActionBar>
  );
}
