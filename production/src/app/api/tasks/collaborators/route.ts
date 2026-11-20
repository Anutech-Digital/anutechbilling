/**
 * POST /api/tasks/collaborators — { taskId, userIds }
 * R-2933: set who works WITH a task's owner (up to 3 teammates) and tell the people just added
 * (bell notice + email). The Add / Edit task dialog calls it after saving the task. Any role
 * that can open Tasks.
 */
import { z } from "zod";
import { RouteError, withRoute } from "@/lib/api/with-route";
import { setTaskCollaborators } from "@/lib/tasks/collaborators.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The limit itself is checked in setTaskCollaborators (the owner in the list does not count);
// 20 only bounds the request.
const schema = z.object({ taskId: z.string().uuid(), userIds: z.array(z.string().uuid()).max(20) });

export const POST = withRoute(
  { route: "api/tasks/collaborators", input: schema, pages: ["/tasks"] },
  async ({ input, supabase, tenantId, user }) => {
    const r = await setTaskCollaborators(supabase, { taskId: input.taskId, tenantId, actorId: user.id, userIds: input.userIds });
    if (!r.ok) throw new RouteError(r.status, r.error);
    return { userIds: r.userIds, added: r.added.length, removed: r.removed.length, notified: r.notified };
  },
);
