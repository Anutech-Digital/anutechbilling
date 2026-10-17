/**
 * GET /api/v1/documents/statement/{customerId}/pdf?token=<hmac>
 *
 * R-1526: the public, signed link to a customer's "Statement of pending dues" — what the
 * WhatsApp text carries (a customer opens it without a login). Same capability-token model as
 * the invoice / quote PDF routes (lib/pdf/pdf-token): the token binds (statement, customer,
 * tenant) and expires (the app mints 7-day links). The customer row gives the tenant; a token
 * minted for another customer or company does not verify. Every read after that is pinned to
 * that tenant (pending-dues.server.ts) — the service role has no RLS.
 *
 * It shows the dues as they are when OPENED, so a customer who paid sees the smaller balance.
 */
import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyPdfToken } from "@/lib/pdf/pdf-token";
import { istToday } from "@/lib/dates/ist";
import { pendingDuesFileName } from "@/lib/collections/pending-dues";
import { pendingDuesPdfFor } from "@/lib/collections/pending-dues.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deny(status: number, msg: string) {
  return new Response(msg, { status, headers: { "content-type": "text/plain" } });
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!UUID.test(id) || !token) return deny(403, "Invalid or missing token");

  const admin = createAdminClient();
  const { data: cust } = await admin.from("customers").select("id, tenant_id").eq("id", id).maybeSingle();
  const tenantId = (cust as { tenant_id?: string } | null)?.tenant_id;
  if (!tenantId || !verifyPdfToken("statement", id, tenantId, token)) return deny(403, "Invalid or expired link");

  const out = await pendingDuesPdfFor(admin, { customerId: id, tenantId, today: istToday() });
  if (!out) return deny(404, "Statement not found");

  return new Response(new Uint8Array(out.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pendingDuesFileName(out.statement.customerName, out.statement.asOn)}"`,
      "cache-control": "private, no-store",
    },
  });
}
