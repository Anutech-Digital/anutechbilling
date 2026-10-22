/**
 * POST /api/marketing/gbp/reply — publish a reply to a Google review.
 * Body: { reviewId, comment }. The reply is written on Google first; the local row is
 * updated only from Google's answer, so the page never shows a reply Google rejected.
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { getFreshGbpAccessToken, replyToReview } from "@/lib/google/gbp-api";
import { withRoute, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  reviewId: z.string({ message: "Reply text is required." }).min(1, "Reply text is required."),
  comment: z.string({ message: "Reply text is required." }).trim()
    .min(1, "Reply text is required.")
    .max(4096, "Keep the reply under 4096 characters (Google's limit)."),
});

export const POST = withRoute(
  { route: "api/marketing/gbp/reply", input: schema, roles: ["owner", "manager"] },
  async ({ input, tenantId, user }) => {
    const admin = createAdminClient();
    const { data: review } = await admin.from("gbp_reviews")
      .select("id, review_name, location_id, gbp_locations!gbp_reviews_location_id_fkey(connected_user_id)")
      .eq("id", input.reviewId).eq("tenant_id", tenantId).maybeSingle();
    if (!review) throw new RouteError(404, "Review not found.");
    const syncUser = (review as unknown as { gbp_locations?: { connected_user_id: string } | null }).gbp_locations?.connected_user_id ?? user.id;

    try {
      const token = await getFreshGbpAccessToken(admin, syncUser);
      const reply = await replyToReview(token, review.review_name, input.comment);
      await admin.from("gbp_reviews").update({ reply_comment: reply.comment ?? input.comment, replied_at: reply.updateTime ?? new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", review.id);
      return { reply };
    } catch (e) {
      throw new RouteError(502, (e as Error).message || "Reply failed");
    }
  },
);
