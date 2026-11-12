/** Secure per-workspace LinkedIn Advertising API key setup. */
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { withRoute } from "@/lib/api/with-route";
import { readLinkedInAdsCredentials, saveLinkedInAdsCredentials } from "@/lib/integrations/linkedin/store";

export const dynamic = "force-dynamic";

export const GET = withRoute({ route: "api/integrations/linkedin-ads", roles: ["owner", "manager"] }, async ({ tenantId, user }) => ({
  configured: !!await readLinkedInAdsCredentials(createAdminClientFor(user.id), tenantId),
}));

const input = z.object({ clientId: z.string().trim().min(3, "Enter the LinkedIn Client ID."), clientSecret: z.string().trim().min(8, "Enter the LinkedIn Client Secret.") });
export const POST = withRoute({ route: "api/integrations/linkedin-ads", input, roles: ["owner", "manager"] }, async ({ input, tenantId, user }) => {
  await saveLinkedInAdsCredentials(createAdminClientFor(user.id), tenantId, input.clientId, input.clientSecret);
  return { configured: true };
});
