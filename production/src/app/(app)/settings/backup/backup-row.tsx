/**
 * One restore point on /settings/backup — details on the left, its buttons on the right.
 * R-1450: details and buttons had no breathing room. On a phone the row stacks (details,
 * then buttons) with gap-4 between them; from md: they sit side by side with the same gap.
 */
import * as React from "react";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";

/** Row button size: 44px touch target on a phone (§20), compact from md: up. */
export const BACKUP_ROW_BUTTON = "h-11 md:h-8 px-3 text-[12px]";

export function BackupRow({ label, kind, meta, actions }: {
  label: string;
  kind: string;
  meta: string;
  actions: React.ReactNode;
}) {
  const isAuto = kind === "auto";
  return (
    // The flex layout sits on an inner div, NOT on <Card>: Card wraps its children in its
    // own padded div, so flex/gap classes on Card never reached the details and buttons —
    // that is why they sat flush against each other (R-1450).
    <Card>
      <div data-testid="backup-row" className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex items-center gap-3">
          <span className="grid place-items-center h-9 w-9 rounded-lg bg-emerald/10 text-emerald shrink-0">
            <Icon name="check_circle" size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-ink truncate">{label}</span>
              <Badge kind={isAuto ? "muted" : "info"} size="sm">{isAuto ? "Auto" : "Manual"}</Badge>
            </div>
            <div className="text-2xs text-ink-3 mt-0.5">{meta}</div>
          </div>
        </div>
        <div data-testid="backup-row-actions" className="flex flex-wrap items-center gap-2 shrink-0">
          {actions}
        </div>
      </div>
    </Card>
  );
}
