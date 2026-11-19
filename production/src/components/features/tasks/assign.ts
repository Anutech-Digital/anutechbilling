/**
 * R-2925 — the "Assign to" rules of the Add / Edit task dialog, as plain functions.
 *
 * Bug this fixes: editing a teammate's task and choosing "Me (myself)" sent no owner change,
 * so the task stayed with the teammate while the form said "Me".
 */

/** The select's value for "Me (myself)". */
export const ASSIGN_ME = "__me__";

/**
 * The owner part of the save. `{}` = leave the owner as it is (a new task defaults to its
 * creator; an edit of a task with NO owner keeps it unassigned unless a person is picked).
 * A change of owner also says who handed it over (delegated_by / delegated_at): the server
 * tells the new owner only when the caller is the one who delegated (POST /api/tasks/assigned).
 */
export interface OwnerPatch {
  owner_id?: string; delegated_by?: string | null; delegated_at?: string | null;
  /** R-2927: a task that changes hands starts again as Not started (the new owner has not begun). */
  progress?: "not_started";
}

export function ownerPatch(input: {
  assignee: string | null | undefined;
  isEdit: boolean;
  meId: string | null | undefined;
  currentOwnerId: string | null | undefined;
  now?: Date;
}): OwnerPatch {
  const picked = input.assignee && input.assignee !== ASSIGN_ME ? input.assignee : null;
  const current = input.currentOwnerId ?? null;
  // "Me (myself)" on an edit of a TEAMMATE'S task takes the task.
  const next = picked ?? (input.isEdit && current && input.meId && current !== input.meId ? input.meId : null);
  if (!next) return {};
  if (input.isEdit && next === current) return {}; // same owner: nothing to say
  const restart = input.isEdit ? { progress: "not_started" as const } : {};
  if (next === input.meId) return { owner_id: next, ...(input.isEdit ? { delegated_by: null, delegated_at: null } : {}), ...restart };
  return {
    owner_id: next,
    ...(input.meId ? { delegated_by: input.meId, delegated_at: (input.now ?? new Date()).toISOString() } : {}),
    ...restart,
  };
}

/**
 * Who is saving. The profile (useCurrentUser) waits on a slow call, so for the first seconds
 * after the page opens it is not loaded; a task given to a teammate in that time was saved
 * without delegated_by and the teammate was never told. The signed-in session answers at once
 * (public.users.id is the session's user id). Never throws: null = really unknown.
 */
export async function meIdForSave(
  profileId: string | null | undefined,
  readSessionUserId: () => Promise<string | null | undefined>,
): Promise<string | null> {
  if (profileId) return profileId;
  try {
    return (await readSessionUserId()) ?? null;
  } catch {
    return null;
  }
}

/** "Me (myself)" was picked on a teammate's task but we do not know who "me" is yet — the save must wait. */
export function meNotKnownYet(input: {
  assignee: string | null | undefined; isEdit: boolean; meId: string | null | undefined; currentOwnerId: string | null | undefined;
}): boolean {
  const pickedMe = !input.assignee || input.assignee === ASSIGN_ME;
  return input.isEdit && pickedMe && !!input.currentOwnerId && !input.meId;
}

/** Whom to tell about this save: the new owner, when it is someone else and they were not the owner already. */
export function assigneeToTell(input: {
  newOwnerId: string | null | undefined;
  previousOwnerId: string | null | undefined;
  meId: string | null | undefined;
}): string | null {
  const next = input.newOwnerId ?? null;
  if (!next || next === input.meId || next === (input.previousOwnerId ?? null)) return null;
  return next;
}

/** What the assigner reads when the notice could not be sent (the task itself is saved). */
export const NOT_TOLD_MESSAGE = "Task saved, but we could not notify the assignee — please tell them yourself.";

/**
 * Ask the server to tell the new owner (bell + email). The task is already saved, so a failed
 * notice never fails the save — it answers false and the caller tells the assigner.
 */
export async function tellAssignee(taskId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/tasks/assigned", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    if (!res.ok) console.error("[tasks] assignee notice failed", res.status);
    return res.ok;
  } catch (e) {
    console.error("[tasks] assignee notice failed", e);
    return false;
  }
}
