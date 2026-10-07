/**
 * POST /api/payments/[id]/receipt   (authenticated)
 *
 * Attach an optional proof-of-payment file (screenshot / PDF) to a payment.
 * Server-side (admin client) so the storage write doesn't depend on browser
 * RLS. Reuses the private `documents` bucket, tenant-foldered at
 * {tenant_id}/payments/{payment_id}-{name}. Stores the PATH on the payment row
 * (payments.receipt_file_path); viewers mint a short-lived signed URL.
 *
 * Best-effort by design — the caller only fires this AFTER record_payment has
 * succeeded, and treats a failure as a warning (the money is already recorded).
 *
 * Body: multipart/form-data — file
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const paymentId = params.id;
  if (!paymentId) return NextResponse.json({ error: "No payment id" }, { status: 400 });

  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  // The payment must exist AND belong to the caller's tenant — never let one
  // tenant attach a file to another tenant's payment id.
  const { data: pay } = await supabase
    .from("payments").select("id, tenant_id").eq("id", paymentId).single();
  if (!pay || pay.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Bad form" }, { status: 400 }); }

  const file = form.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "No file" }, { status: 400 });
  const f = file as File;
  if (f.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File must be under 20 MB" }, { status: 400 });
  if (f.type && !ALLOWED.includes(f.type)) {
    return NextResponse.json({ error: "Only images (JPG/PNG/WEBP) or PDF" }, { status: 400 });
  }

  const admin = createAdminClientFor(authData.user.id);
  const clean = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path  = `${me.tenant_id}/payments/${paymentId}-${clean}`;
  const buf   = Buffer.from(await f.arrayBuffer());

  const { error: upErr } = await admin.storage
    .from("documents").upload(path, buf, { upsert: true, contentType: f.type || undefined });
  if (upErr) {
    /* R-025: this was `upErr.message` — storage's own text, which names the bucket and
       the object path (which contains the tenant id). */
    logDbError("payments/receipt:upload", upErr);
    return NextResponse.json(
      { error: "Could not store the receipt file. Try again, or attach it from the payment row." },
      { status: 500 },
    );
  }

  const { error: updErr } = await admin
    .from("payments").update({ receipt_file_path: path }).eq("id", paymentId).eq("tenant_id", me.tenant_id);
  if (updErr) {
    await admin.storage.from("documents").remove([path]);
    /* R-025. A guard of ours (P0001) still speaks for itself — its message is the next
       step. Anything else is Postgres naming our columns and constraints. */
    logDbError("payments/receipt:link", updErr);
    return NextResponse.json(
      { error: safeDbMessage(updErr, "The file uploaded but could not be linked to the payment. Nothing was saved — try again.") },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, path });
}
