/**
 * guardErrorToast — show a blocked-action error that is NEVER a dead end.
 *
 * Per CLAUDE.md §24: when a guard blocks an action, tell the user what happened
 * (the RPC message already states the next step in words) AND give a button to
 * the place where they can do that next step. Uses window.location so it works
 * from any query hook without threading a router through.
 */
import { toast } from "sonner";

export function guardErrorToast(err: unknown, next?: { label: string; href: string }): void {
  const msg =
    err instanceof Error
      ? err.message
      : String((err as { message?: string } | null)?.message ?? err ?? "Something went wrong");
  toast.error(msg, next ? { action: { label: next.label, onClick: () => window.location.assign(next.href) } } : undefined);
}
