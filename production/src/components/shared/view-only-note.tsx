import { Icon } from "@/components/ui/icon";

/**
 * R-254 (7 Oct 2026): billing SEES Payroll, Employees and Banking, but the database lets only
 * owner / manager / accountant save them (MONEY_WRITE_ROLES in lib/nav). Instead of buttons
 * that fail with a permission error, the page hides them and shows this one line.
 */
export function ViewOnlyNote({ what }: { what: string }) {
  return (
    <div role="note" className="mb-4 flex items-start gap-2 rounded-md border border-hairline bg-paper-2/60 px-3 py-2 text-sm text-ink-2">
      <Icon name="lock" size={14} className="mt-0.5 shrink-0 text-ink-3" />
      <span><b className="text-ink">View only</b> — ask the owner or accountant to {what}.</span>
    </div>
  );
}
