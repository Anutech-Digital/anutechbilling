/**
 * GET /api/customers/{id}/pending-dues/pdf — R-1526: the customer's "Statement of pending dues"
 * PDF for the person previewing it (opens inline in a new tab).
 *
 * Gate: the roles that can open /collections. Read on the caller's session (RLS) with explicit
 * tenant filters; every list pages past 1000 (pending-dues.server.ts).
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { istToday } from "@/lib/dates/ist";
import { pendingDuesFileName } from "@/lib/collections/pending-dues";
import { pendingDuesPdfFor } from "@/lib/collections/pending-dues.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export const GET = withRoute(
  {
    route: "api/customers/pending-dues/pdf",
    pages: ["/collections"],
    roleHint: "Your role cannot open pending-dues statements. Ask your manager to give you access to Payment Follow-up.",
  },
  async ({ supabase, params, tenantId }) => {
    const customerId = params.id ?? "";
    if (!idSchema.safeParse(customerId).success) throw new RouteError(404, "Customer not found — reload the page and try again.");

    const out = await pendingDuesPdfFor(supabase, { customerId, tenantId, today: istToday() });
    if (!out) throw new RouteError(404, "This customer is not in your list any more — reload the page and pick them again.");

    return new Response(new Uint8Array(out.pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pendingDuesFileName(out.statement.customerName, out.statement.asOn)}"`,
        "cache-control": "private, no-store",
      },
    });
  },
);
