/**
 * POST /api/settings/logo   (authenticated)
 *
 * Upload / change / remove the company logo. Runs server-side with the admin
 * client so the storage write doesn't depend on client-context RLS (which
 * doesn't resolve current_tenant_id() reliably for browser → storage uploads).
 * Tenant is derived from the signed-in user; the file lands in the public
 * `logos` bucket and its public URL is saved on tenants.logo_url.
 *
 * Body: multipart/form-data with an optional `file`. No file = remove logo.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { sniff, type SniffedKind } from "@/server/postgrest/storage-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* R-1546: no SVG — the logo is served from the app's own origin and an SVG can carry a
   script. The bytes decide the type, not the browser's claim (a .png name with SVG inside
   is refused). */
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const TYPE_OF: Partial<Record<SniffedKind, string>> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "No tenant" }, { status: 400 });
  }
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change the logo" }, { status: 403 });
  }

  const admin = createAdminClientFor(authData.user.id);

  let form: FormData;
  try { form = await req.formData(); } catch { form = new FormData(); }
  const file = form.get("file");

  // Remove logo
  if (!file || typeof file === "string") {
    await admin.from("tenants").update({ logo_url: null }).eq("id", me.tenant_id);
    return NextResponse.json({ ok: true, logoUrl: null });
  }

  const f = file as File;
  if (!ALLOWED.includes(f.type)) {
    return NextResponse.json({ error: "Use PNG, JPG or WEBP" }, { status: 400 });
  }
  if (f.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: "Logo must be under 5 MB" }, { status: 400 });
  }

  const clean = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path  = `${me.tenant_id}/${Date.now()}-${clean}`;
  const buf   = Buffer.from(await f.arrayBuffer());
  const contentType = TYPE_OF[sniff(buf)];
  if (!contentType) {
    return NextResponse.json({ error: "This file is not a PNG, JPG or WEBP image" }, { status: 400 });
  }

  const { error: upErr } = await admin.storage
    .from("logos").upload(path, buf, { upsert: true, contentType });
  if (upErr) {
    /* Logged with its detail — on 2 Oct a production upload failed with only "500" in the
       request log and no way to tell storage RLS from a missing bucket. */
    console.error("[settings/logo] storage upload failed", { tenant: me.tenant_id, message: upErr.message, err: upErr });
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }
  const logoUrl = admin.storage.from("logos").getPublicUrl(path).data.publicUrl;

  const { error: updErr } = await admin.from("tenants").update({ logo_url: logoUrl }).eq("id", me.tenant_id);
  if (updErr) {
    console.error("[settings/logo] tenant update failed", { tenant: me.tenant_id, message: updErr.message, code: updErr.code });
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, logoUrl });
}
