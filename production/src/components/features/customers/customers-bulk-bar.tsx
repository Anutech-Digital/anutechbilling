/**
 * CustomersBulkBar — the customer-specific actions inside the shared floating toolbar.
 *
 * The shell (position, count chip, dividers, Clear, the two-step confirm) is
 * `components/ui/bulk-action-bar.tsx`, the same one Leads and Invoices use. This file
 * holds only what is about CUSTOMERS.
 *
 * ─── WHY ARCHIVE SITS TO THE LEFT OF DELETE ─────────────────────────────────
 * Archive is the money-safe action and the one that is almost always meant: it hides the
 * customer while keeping every invoice, payment and GST record. Delete is genuinely
 * destructive and the server refuses it for anyone carrying a document, so it is last,
 * it is rose, and it needs a second press. Putting them the other way round would make
 * the irreversible one the easy reach.
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
import type { CustomerGroup } from "@/lib/supabase/database.types";

interface CustomersBulkBarProps {
  count: number;
  /** Parent accounts to move the selection into. */
  groups: CustomerGroup[];
  onExport: () => void;
  onArchive: () => void;
  onReactivate: () => void;
  /** `null` detaches them from whatever group they are in. */
  onSetGroup: (groupId: string | null) => void;
  onDelete: () => void;
  onDeselectAll: () => void;
  busy?: boolean;
  /** R-255: a view-only role (the accountant) gets Export and nothing that changes data. */
  readOnly?: boolean;
}

export function CustomersBulkBar({
  count, groups, onExport, onArchive, onReactivate, onSetGroup, onDelete, onDeselectAll, busy, readOnly = false,
}: CustomersBulkBarProps) {
  return (
    <BulkActionBar count={count} noun="customer" onClear={onDeselectAll}>
      {/* Read-only, so it comes first and needs no confirmation. */}
      <BulkBarButton icon="download" label="Export selected to CSV" onClick={onExport} disabled={busy}>
        Export
      </BulkBarButton>

      {!readOnly && (<>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-paper/90 hover:bg-paper/10 transition-colors disabled:opacity-50"
          >
            <Icon name="layout" size={14} />
            Parent account
            <Icon name="chevron_down" size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-[220px]">
          <DropdownMenuLabel>Move {count} to</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {groups.length === 0 && (
            /* §24: not an empty menu. Say why it is empty and where to fix it. */
            <DropdownMenuItem disabled>
              No parent accounts yet — create one in Billing → Parent Accounts
            </DropdownMenuItem>
          )}
          {groups.map((g) => (
            <DropdownMenuItem key={g.id} onSelect={() => onSetGroup(g.id)}>
              {g.name}
            </DropdownMenuItem>
          ))}
          {groups.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => onSetGroup(null)}>
            Remove from parent account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Both directions, because a list filtered to Archived needs the way back and
          the bar is the only place the selection exists. */}
      <BulkBarButton icon="inbox" label="Archive selected" onClick={onArchive} disabled={busy}>
        Archive
      </BulkBarButton>
      <BulkBarButton icon="refresh" label="Reactivate selected" onClick={onReactivate} disabled={busy}>
        Reactivate
      </BulkBarButton>

      <BulkBarConfirmButton icon="trash" onConfirm={onDelete}>
        Delete
      </BulkBarConfirmButton>
      </>)}
    </BulkActionBar>
  );
}
