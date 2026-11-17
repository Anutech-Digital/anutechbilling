/**
 * POST /api/leads/finder/contacts — { ids?: string[], force?: boolean, mode?: "site" | "people" }
 * mode "people": contact person from public records for cards whose site names nobody (10 per call).
 * Read published email/phone from the candidates' own websites. Without ids: the 25
 * best-scored candidates that were never checked (older runs predate this step).
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { enrichCandidateContacts, searchPeople } from "@/lib/leads/lead-finder.server";
import { withRoute, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  ids: z.array(z.string().uuid()).max(50).optional(),
  force: z.boolean().optional(),
  mode: z.enum(["site", "people"]).optional(),
});

export const POST = withRoute(
  { route: "api/leads/finder/contacts", input: schema, roles: ["owner", "manager", "marketing"] },
  async ({ input, tenantId }) => {
    if (input.mode === "people") {
      try { return await searchPeople(createAdminClient(), tenantId, { ids: input.ids }); }
      catch (e) { throw new RouteError(502, (e as Error).message || "Search failed"); }
    }
    return enrichCandidateContacts(createAdminClient(), tenantId, { ids: input.ids, force: input.force });
  },
);
