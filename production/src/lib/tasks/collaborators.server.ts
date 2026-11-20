/**
 * R-2933 — set who works WITH a task's owner (up to 3 people) and tell the people just added
 * (bell + email). Server-only. Called by POST /api/tasks/collaborators after the Add / Edit task
 * dialog saved the task.
 *
 * Trust: the task and its current collaborators are read, and the rows written, through the
 * CALLER'S session (RLS: own company only) and pinned to their tenant. The people picked are
 * checked against the active members of that tenant. Everything said in the notice comes from
 * the task row and the users table — nothing from the request body except ids.
 */
import "server-only";
import { createAdminClient, type createClient } from "@/lib/supabase/server";
import { sendInternalEmail } from "@/lib/messaging";
import { notifyPeople } from "@/lib/notifications/notify.server";
import { appUrl } from "@/lib/app-url";
import { mayOpenPage } from "@/lib/api/with-route";
import { relatedOf, type AssignedTask } from "./assign-notice";
import { cleanCollaborators, collaboratorDiff, collaboratorEmail, collaboratorNotification, NOT_AN_ACTIVE_MEMBER, TOO_MANY_COLLABORATORS } from "./collaborators";

export type SetCollaboratorsResult =
  | { ok: true; userIds: string[]; added: string[]; removed: string[]; notified: number }
  | { ok: false; status: 404 | 409; error: string };

type UserClient = ReturnType<typeof createClient>;

/**
 * R-2941: the database holds the same two rules (trigger task_collaborators_guard) and answers
 * with its own SQLSTATE — 23514 = already 3 people (a second save at the same moment),
 * 23503 = the task or the person is not in this company (they left / were deactivated meanwhile).
 */
const DB_REFUSAL: Record<string, string> = { "23514": TOO_MANY_COLLABORATORS, "23503": NOT_AN_ACTIVE_MEMBER };

const TASK_COLUMNS = "id, title, notes, due_at, owner_id, lead_id, quote_id, customer_id, subscription_id, leads(company, contact_name), customers(name), quotes(customer_name)";

type TaskRead = AssignedTask & {
  leads?: { company: string | null; contact_name: string | null } | null;
  customers?: { name: string | null } | null;
  quotes?: { customer_name: string | null } | null;
};
type U = { id: string; full_name: string | null; email: string | null; is_active: boolean | null; role: string | null };

export async function setTaskCollaborators(
  supabase: UserClient,
  input: { taskId: string; tenantId: string; actorId: string; userIds: readonly string[] },
): Promise<SetCollaboratorsResult> {
  const { taskId, tenantId, actorId } = input;

  const { data: taskRow, error: taskErr } = await supabase
    .from("tasks").select(TASK_COLUMNS).eq("id", taskId).eq("tenant_id", tenantId).maybeSingle();
  if (taskErr) throw new Error(`task read failed: ${taskErr.message}`);
  const task = taskRow as unknown as TaskRead | null;
  if (!task) return { ok: false, status: 404, error: "This task no longer exists — refresh the page." };

  const admin = createAdminClient();
  const { data: users, error: usersErr } = await admin
    .from("users").select("id, full_name, email, is_active, role").eq("tenant_id", tenantId);
  if (usersErr) throw new Error(`users read failed: ${usersErr.message}`);
  const team = ((users ?? []) as U[]).filter((u) => u.is_active !== false);
  const byId = new Map(team.map((u) => [u.id, u]));

  const cleaned = cleanCollaborators({ userIds: input.userIds, ownerId: task.owner_id, activeMemberIds: new Set(byId.keys()) });
  if (!cleaned.ok) return { ok: false, status: 409, error: cleaned.error };

  const { data: currentRows, error: curErr } = await supabase
    .from("task_collaborators").select("user_id").eq("task_id", task.id).eq("tenant_id", tenantId);
  if (curErr) throw new Error(`collaborators read failed: ${curErr.message}`);
  const current = ((currentRows ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const { add, remove } = collaboratorDiff(current, cleaned.userIds);

  // Remove first, so a swap at the limit (3 → drop one, add one) never holds 4 rows.
  if (remove.length) {
    const { error } = await supabase.from("task_collaborators")
      .delete().eq("task_id", task.id).eq("tenant_id", tenantId).in("user_id", remove);
    if (error) throw new Error(`collaborators delete failed: ${error.message}`);
  }
  if (add.length) {
    const { error } = await supabase.from("task_collaborators")
      .insert(add.map((user_id) => ({ tenant_id: tenantId, task_id: task.id, user_id, added_by: actorId })));
    // The people removed above stay removed; the dialog reloads the task after a refusal.
    const refused = error?.code ? DB_REFUSAL[error.code] : undefined;
    if (refused) return { ok: false, status: 409, error: refused };
    if (error) throw new Error(`collaborators insert failed: ${error.message}`);
  }

  // Tell the people just added — never the person who did the adding.
  const nameOf = (u: U | null | undefined) => u?.full_name?.trim() || u?.email?.split("@")[0] || "A teammate";
  const actorName = nameOf(byId.get(actorId));
  const ownerName = task.owner_id && byId.get(task.owner_id) ? nameOf(byId.get(task.owner_id)) : null;
  const toTell = add.filter((id) => id !== actorId).map((id) => byId.get(id)).filter((u): u is U => !!u);
  let companyName: string | null = null;
  for (const person of toTell) {
    const canOpenTasks = mayOpenPage(person.role, ["/tasks"]);
    const n = collaboratorNotification({ task, actorName, canOpenTasks });
    await notifyPeople({ tenantId, kind: n.kind, title: n.title, body: n.body, href: n.href, entityId: n.entityId }, { userIds: [person.id] });
    if (!person.email) continue;
    // The email is best effort: the row and the bell notice are written.
    try {
      if (companyName === null) {
        const { data: tenant } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
        companyName = (tenant as { name?: string | null } | null)?.name?.trim() || "your company";
      }
      const mail = collaboratorEmail({
        task, assigneeName: nameOf(person), actorName, ownerName, companyName, baseUrl: appUrl(), canOpenTasks,
        related: relatedOf(task, {
          lead: task.leads?.company?.trim() || task.leads?.contact_name,
          quote: task.quotes?.customer_name,
          customer: task.customers?.name,
        }),
      });
      const sent = await sendInternalEmail({
        to: person.email, subject: mail.subject, text: mail.text, html: mail.html,
        route: { tenantId }, kind: "task_collaborator",
      });
      if (sent.status === "failed") console.error("[tasks/collaborators] email failed:", sent.errorMessage);
    } catch (e) {
      console.error("[tasks/collaborators] email crashed:", (e as Error).message);
    }
  }

  return { ok: true, userIds: cleaned.userIds, added: add, removed: remove, notified: toTell.length };
}
