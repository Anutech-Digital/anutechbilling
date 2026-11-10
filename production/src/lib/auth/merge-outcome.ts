/**
 * What the operator is told after `merge_stranded_user_into_tenant()` runs.
 *
 * ─── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * This lived inline in the Claim & Merge card's `onSuccess`. It is the one place
 * where a database outcome becomes a sentence an owner reads and believes, and it
 * has four cases that are easy to blur — in particular "moved" (their old
 * workspace was deleted) versus "attached" (there was no old workspace at all).
 * Telling someone a workspace was removed when none existed is a small lie that
 * costs a support conversation; telling them nothing was removed when one WAS is
 * worse. Pure and separate, so both can be asserted.
 *
 * The RPC's own error text is deliberately NOT translated anywhere: those messages
 * carry the reason and the next step (CLAUDE.md §24) and are surfaced verbatim.
 */

/** What the RPC reports it did. Mirrors migration 0243's `v_action`; R-2477 added
    "added" (a membership here, they keep their other company) and "rejoined" (an ended
    membership here re-opened). */
export type MergeAction = "attached" | "moved" | "already_member" | "role_updated" | "added" | "rejoined";

export interface MergeResult {
  action:             MergeAction;
  email:              string;
  role:               string;
  old_tenant_name:    string | null;
  old_tenant_deleted: boolean;
}

/**
 * One sentence stating exactly what changed — including, when a workspace was
 * removed, that it was removed and which one.
 */
export function describeMergeOutcome(r: MergeResult): string {
  /* 0243 always sets a name on the `moved` path, so null here means something
     upstream changed. Interpolating it anyway printed the literal word "null" to
     the operator — caught by merge-user.test.ts, which is exactly the class of
     bug that survives code review and embarrasses you in a screenshot. Degrade to
     a true, vaguer phrase rather than to a lie or to "null". */
  const from = r.old_tenant_name?.trim()
    ? `"${r.old_tenant_name.trim()}"`
    : "their previous workspace";

  switch (r.action) {
    case "moved":
      return r.old_tenant_deleted
        ? `${r.email} is now in your workspace as ${r.role} — moved out of ${from} and that empty workspace was removed.`
        : `${r.email} is now in your workspace as ${r.role} — moved out of ${from}.`;

    case "attached":
      // No old workspace existed. Saying "moved" here would invent one.
      return `${r.email} is now in your workspace as ${r.role} — they had no workspace at all before this.`;

    case "role_updated":
      return `${r.email} was already here. Role changed to ${r.role}.`;

    case "already_member":
      return `${r.email} is already in your workspace as ${r.role}. Nothing changed.`;

    /* R-2477: never names their other company (the RPC does not return it for these). */
    case "added":
      return `${r.email} is now also in your company as ${r.role}. They keep the other company they work in and pick yours from the company switcher in the top bar.`;

    case "rejoined":
      return `${r.email} is back in your company as ${r.role}.`;
  }
}

/**
 * Did this call actually change anything? Drives whether the UI needs to refetch.
 * `already_member` is a successful no-op and must not be reported as a change.
 */
export function mergeChangedSomething(r: MergeResult): boolean {
  return r.action !== "already_member";
}
