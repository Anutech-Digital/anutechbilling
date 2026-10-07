/**
 * POST /api/leads/google-import
 *
 * Bulk import contacts as LEADS (not the standalone contacts table).
 * Used by the GoogleContactsImportDialog when the operator wants chosen
 * Google contacts to land in the Deal Pipeline directly.
 *
 * Body: { rows: Array<{ fullName, email?, phone?, company?, title?, notes?, source? }> }
 * Returns: { imported, duplicates, skipped, total }
 *
 * Dedup: same tenant + same lowercase email → silently skipped.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const rowSchema = z.object({
  fullName: z.string().min(1).max(200),
  email:    z.string().email().optional().nullable(),
  phone:    z.string().max(50).optional().nullable(),
  company:  z.string().max(200).optional().nullable(),
  title:    z.string().max(200).optional().nullable(),
  notes:    z.string().max(2000).optional().nullable(),
});

const schema = z.object({
  rows:   z.array(rowSchema).min(1).max(2000),
  source: z.string().default("google-import"),
});

export async function POST(req: Request) {
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: me } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const admin  = createAdminClientFor(authData.user.id);
  const { rows, source } = parsed.data;

  // Pre-fetch existing emails in this tenant
  const incomingEmails = rows
    .map((r) => r.email?.toLowerCase().trim())
    .filter((e): e is string => !!e);

  const existingEmails = new Set<string>();
  if (incomingEmails.length > 0) {
    const { data: existing } = await admin
      .from("leads")
      .select("contact_email")
      .eq("tenant_id", me.tenant_id)
      .in("contact_email", incomingEmails);
    for (const r of existing ?? []) {
      if (r.contact_email) existingEmails.add(r.contact_email.toLowerCase());
    }
  }

  let imported   = 0;
  let duplicates = 0;
  let skipped    = 0;

  for (const r of rows) {
    const emailLower = r.email?.toLowerCase().trim() || null;
    if (emailLower && existingEmails.has(emailLower)) {
      duplicates++;
      continue;
    }
    if (!r.fullName.trim()) {
      skipped++;
      continue;
    }

    const leadId = "L-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
    const { error: insErr } = await admin.from("leads").insert({
      id:            leadId,
      tenant_id:     me.tenant_id,
      company:       r.company?.trim() || r.fullName.trim(),
      contact_name:  r.fullName.trim(),
      contact_email: emailLower,
      contact_phone: r.phone?.trim() || null,
      stage:         "new",
      source,
      notes:         [
        `Imported from Google Contacts (${source})`,
        r.title  ? `Title: ${r.title.trim()}`  : null,
        r.notes  ? `Notes: ${r.notes.trim()}`  : null,
      ].filter(Boolean).join("\n"),
    });

    if (insErr) {
      // Continue importing rest; just log
      console.error("[google-import] lead insert failed:", insErr);
      skipped++;
      continue;
    }

    imported++;
    if (emailLower) existingEmails.add(emailLower);
  }

  return NextResponse.json({
    imported,
    duplicates,
    skipped,
    total: rows.length,
  });
}
