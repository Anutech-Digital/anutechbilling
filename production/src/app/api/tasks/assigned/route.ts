/**
 * POST /api/tasks/assigned — { taskId }
 * R-2925: tell the task's owner that it was given to them (bell notice + email). The Add / Edit
 * task dialog calls it after saving a task for someone else. Any role that can open Tasks.
 */
import { z } from "zod";
import { withRoute } from "@/lib/api/with-route";
import { sendTaskAssignedNotice } from "@/lib/tasks/assign-notice.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ taskId: z.string().uuid() });

export const POST = withRoute(
  { route: "api/tasks/assigned", input: schema, pages: ["/tasks"] },
  async ({ input, supabase, tenantId, user }) => {
    const r = await sendTaskAssignedNotice(supabase, { taskId: input.taskId, tenantId, actorId: user.id });
    return { notified: r.notified, emailed: r.emailed, ...(r.reason ? { reason: r.reason } : {}) };
  },
);
