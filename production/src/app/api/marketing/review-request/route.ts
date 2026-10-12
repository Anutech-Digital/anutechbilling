/**
 * POST /api/marketing/review-request  { customerId, force? }
 *
 * Emails one customer the company's Google review link and logs it in review_requests
 * (migration 20260926220000). Refuses — sends nothing — when there is no review link, no
 * email on the customer, or the customer was asked in the last 30 days (unless force).
 *
 * Runs as the signed-in user: the customer, the link and the log all go through RLS, so a
 * user can only ask their own company's customers.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { sendCustomerEmail } from "@/lib/messaging";
import { replyToAddress } from "@/lib/email/reply-to";
import { isValidReviewLink, reviewEmail, tooSoon, REVIEW_COOLDOWN_DAYS } from "@/lib/marketing/review-request";
import { withRoute, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  customerId: z.string({ message: "Customer chuno." }).uuid("Customer chuno."),
  force: z.boolean().optional(),
});

export const POST = withRoute(
  { route: "api/marketing/review-request", input: schema },
  async ({ input, supabase, tenantId, user }) => {
    const { customerId, force } = input;
    // S21: marketing_tools / review_requests ab generated types me — alag untyped handle nahi.

    const { data: customer } = await supabase.from("customers")
      .select("id, name, display_name, contact_name, contact_first_name, contact_email")
      .eq("id", customerId).single();
    if (!customer) throw new RouteError(404, "Customer nahi mila.");
    const to = (customer.contact_email ?? "").trim();
    if (!to) throw new RouteError(400, "Is customer ki email nahi hai — WhatsApp se bhejo ya email jodo.");

    const { data: tool } = await supabase.from("marketing_tools").select("review_link").eq("tool_key", "google-business").maybeSingle();
    const link = (tool?.review_link ?? "").trim();
    if (!isValidReviewLink(link)) throw new RouteError(400, "Pehle Google review link save karo (upar wala box).");

    if (!force) {
      const { data: last } = await supabase.from("review_requests").select("created_at")
        .eq("customer_id", customerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (tooSoon(last?.created_at)) {
        return NextResponse.json(
          { ok: false, error: `Is customer ko pichhle ${REVIEW_COOLDOWN_DAYS} din mein poocha ja chuka hai.`, code: "too_soon" },
          { status: 409 },
        );
      }
    }

    const { data: tenant } = await supabase.from("tenants").select("name, email").eq("id", tenantId).single();
    const { data: boxes } = await supabase.from("user_google_tokens").select("google_email").eq("tenant_id", tenantId);
    const sender = tenant?.name ?? "Our team";
    const msg = reviewEmail({
      contactName: customer.contact_first_name || customer.contact_name,
      company: customer.display_name || customer.name,
      sender, link,
    });

    const result = await sendCustomerEmail({
      to,
      from: process.env.RESEND_FROM_DEFAULT?.trim() || undefined,
      replyTo: replyToAddress(boxes, tenant?.email),
      route: { tenantId },
      kind: "review_request",
      subject: msg.subject, text: msg.text, html: msg.html,
    });

    const status = result.status === "failed" ? "failed" : result.status === "stubbed" ? "stubbed" : "sent";
    await supabase.from("review_requests").insert({
      tenant_id: tenantId, customer_id: customerId, channel: "email", sent_to: to,
      status, error: result.status === "failed" ? (result.errorMessage ?? "failed") : null, created_by: user.id,
    });

    if (status === "failed") throw new RouteError(502, result.errorMessage ?? "Mail nahi gaya.");
    return { status, to };
  },
);
