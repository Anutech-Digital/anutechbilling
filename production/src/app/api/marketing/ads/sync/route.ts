/** POST /api/marketing/ads/sync — pull spend from enabled ad accounts, optionally selected by ID. */
import { createAdminClient } from "@/lib/supabase/server";
import { syncTenantAds } from "@/lib/marketing/ad-sync";
import { linkedInHistoryChunks } from "@/lib/marketing/linkedin-history";
import { istToday } from "@/lib/dates/ist";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const inputSchema = z.object({ from: z.string().optional(), to: z.string().optional(), accountId: z.string().uuid().optional(), accountIds: z.array(z.string().uuid()).min(1).max(50).optional() }).refine(
  ({ from, to }) => Boolean(from) === Boolean(to),
  "Choose both a start and end date.",
).refine(({ accountId, accountIds }) => !accountId || !accountIds, "Choose one account selection method.")
  .refine(({ accountIds }) => !accountIds || new Set(accountIds).size === accountIds.length, "Choose each account only once.");

export const POST = withRoute(
  { route: "api/marketing/ads/sync", roles: ["owner", "manager"], input: inputSchema },
  async ({ tenantId, input }) => {
    try {
      let window;
      if (input.from && input.to) {
        const chunks = linkedInHistoryChunks(input.from, input.to, istToday());
        if (chunks.length !== 1 || chunks[0].from !== input.from || chunks[0].to !== input.to) {
          throw new RouteError(400, "Choose one full-month or 90-day LinkedIn history window.");
        }
        window = { platform: "linkedin-ads" as const, ...chunks[0], accountId: input.accountId };
      }
      const r = await syncTenantAds(createAdminClient(), tenantId, "manual", window, input.accountId, input.accountIds);
      return { ...r, ok: r.errors.length === 0 };
    } catch (e) {
      if (e instanceof RouteError) throw e;
      if (e instanceof Error && (e.message.startsWith("Choose ") || e.message.startsWith("Selected "))) throw new RouteError(400, e.message);
      throw new RouteError(502, (e as Error).message || "Sync failed");
    }
  },
);
