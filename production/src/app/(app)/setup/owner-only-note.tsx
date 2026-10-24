"use client";

import { Icon } from "@/components/ui/icon";
import { memberLabel, useTeamMembers } from "@/lib/queries/team";
import { ownerOnlySetupNote } from "./owner-only";

/** R-1798: shown to a non-owner on /setup — the tenant row is owner-only, so the wizard only looks. */
export function OwnerOnlyNote() {
  const { data: members } = useTeamMembers();
  const owner = members?.find((m) => m.role === "owner");
  return (
    <div role="status" className="mb-6 flex items-start gap-2 rounded-lg border border-hairline bg-paper-2 p-3 text-sm text-ink-2">
      <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-medium text-ink">{ownerOnlySetupNote(owner ? memberLabel(owner) : null)}</p>
        <p className="mt-0.5 text-xs text-ink-3">
          You can look through the steps, but nothing here is saved. Company details are changed by the owner in Settings → Company.
        </p>
      </div>
    </div>
  );
}
