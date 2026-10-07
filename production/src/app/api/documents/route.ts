/**
 * POST /api/documents   (authenticated)
 *
 * Upload a document to the vault. Server-side (admin client) so the storage
 * write doesn't depend on browser-context RLS. Tenant is derived from the
 * signed-in user; the file lands in the private `documents` bucket and a
 * documents row is inserted.
 *
 * Body: multipart/form-data — file, title, category, expiry_date?, notes?
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES = ["legal", "finance", "hr", "operations", "sales_marketing", "admin", "branding", "other"];

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Bad form" }, { status: 400 }); }

  const file = form.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "No file" }, { status: 400 });
  const f = file as File;
  if (f.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File must be under 20 MB" }, { status: 400 });

  const title    = String(form.get("title") ?? "").trim();
  const category = String(form.get("category") ?? "other");
  const expiry   = String(form.get("expiry_date") ?? "").trim() || null;
  const notes    = String(form.get("notes") ?? "").trim() || null;
  if (title.length < 2) return NextResponse.json({ error: "Title required" }, { status: 400 });
  const cat = (CATEGORIES.includes(category) ? category : "other") as
    "legal" | "finance" | "hr" | "operations" | "sales_marketing" | "admin" | "branding" | "other";

  const admin = createAdminClientFor(authData.user.id);
  const clean = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path  = `${me.tenant_id}/${crypto.randomUUID()}-${clean}`;
  const buf   = Buffer.from(await f.arrayBuffer());

  const { error: upErr } = await admin.storage
    .from("documents").upload(path, buf, { upsert: false, contentType: f.type || undefined });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { error: insErr } = await admin.from("documents").insert({
    tenant_id:   me.tenant_id,
    title,
    category:    cat,
    file_path:   path,
    file_name:   f.name,
    mime_type:   f.type || null,
    size_bytes:  f.size,
    expiry_date: expiry,
    notes,
    uploaded_by: authData.user.id,
  });
  if (insErr) {
    await admin.storage.from("documents").remove([path]);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
