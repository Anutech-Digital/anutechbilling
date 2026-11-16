/**
 * Who to show on an Activity Log row (R-016).
 *
 * Staff rows carry `user_id` and join `users` for a name. A portal customer is not
 * in `users`, so their rows have `user_id = null` and the trigger writes
 * `actor_label = 'Customer <name>'` instead (migration 20260930200001). Before that
 * the customer's change failed outright on the user_id FK.
 */
export type ActivityActorFields = {
  actor_label?: string | null;
  /** R-2778: 'ai' when the Help AI made the change for this person (their own login). */
  via?: string | null;
  actor: { full_name: string | null; initials: string | null; color: string | null } | null;
};

export function activityActorName(r: ActivityActorFields): string {
  return r.actor?.full_name || r.actor_label || "Someone";
}

export function activityActorInitials(r: ActivityActorFields): string {
  if (r.actor?.initials) return r.actor.initials;
  if (r.actor) return "?";
  const label = r.actor_label?.trim();
  return label ? label[0].toUpperCase() : "?";
}

/** R-2778: the AI-on-behalf-of line for a row the Help AI changed for a person, else null. */
export function activityViaLabel(r: ActivityActorFields): string | null {
  if (r.via !== "ai") return null;
  const name = r.actor?.full_name || r.actor_label;
  return name ? `AI on behalf of ${name}` : "AI on behalf of a team member";
}
