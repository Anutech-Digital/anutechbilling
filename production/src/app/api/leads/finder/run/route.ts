/** POST /api/leads/finder/run — { profileId } — run the AI Lead Finder for one profile now. */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { runLeadFinder } from "@/lib/leads/lead-finder.server";
import { withRoute, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({ profileId: z.string().min(1, "profileId is required.") });

export const POST = withRoute(
  { route: "api/leads/finder/run", input: schema, roles: ["owner", "manager"] },
  async ({ input, tenantId }) => {
    try {
      return { ...(await runLeadFinder(createAdminClient(), tenantId, input.profileId, "manual")) };
    } catch (e) {
      // Upstream (search / AI) fail — 502; message runner ka apna likha hai, DB text nahi.
      throw new RouteError(502, (e as Error).message || "Run failed");
    }
  },
);
