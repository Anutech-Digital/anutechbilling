/**
 * POST /api/contacts/import
 *
 * Bulk import contacts from a parsed Google Contacts CSV (parsing happens
 * client-side via lib/contacts/parse-google-csv.ts; this endpoint just
 * upserts the chosen rows into the contacts table).
 *
 * Body:
 *   {
 *     source: 'google_csv' | 'manual' | ...,
 *     rows: Array<{ fullName, email?, phone?, company?, title?, notes?, tags?[] }>
 *   }
 *
 * Returns: { imported, skipped, duplicates, total }
 *
 * Dedup: same tenant + same lowercase email → skipped (silent, counts as
 * duplicate). Rows without email are always inserted.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";
import type { ContactSource } from "@/lib/supabase/database.types";
import { CONTACT_IMPORT_RETIRED, contactImportRetired } from "@/lib/contacts/retired";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const rowSchema = z.object({
  fullName: z.string().min(1).max(200),
  email:    z.string().email().optional().nullable(),
  phone:    z.string().max(50).optional().nullable(),
  company:  z.string().max(200).optional().nullable(),
  title:    z.string().max(200).optional().nullable(),
  notes:    z.string().max(2000).optional().nullable(),
  tags:     z.array(z.string().max(50)).optional(),
});

const schema = z.object({
  source: z.enum(["manual","google_csv","google_api","outlook","linkedin","event","other"]).default("google_csv"),
  rows:   z.array(rowSchema).min(1).max(2000),
});

function newContactId(): string {
  return "C-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
}

export async function POST(req: Request) {
  /* RETIRED 10 Sep 2026 — see lib/contacts/retired.ts. `contacts` is now only a
     customer's people; anybody who is not a customer yet is a LEAD. Fails closed, so
     no new address-book row can be written whatever still calls this. */
  if (CONTACT_IMPORT_RETIRED) return contactImportRetired();

  // Authn
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: me } = await userClient
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }
  /* S19: signed in + same tenant is not enough for this one. */
  if (!mayDo((me as { role?: string | null }).role, "contacts.import")) {
    return NextResponse.json({ error: forbiddenMessage("contacts.import") }, { status: 403 });
  }

  // Body
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  const { source, rows } = parsed.data;

  const admin = createAdminClientFor(authData.user.id);

  // ── Pre-fetch existing emails in this tenant for dedup ──────────
  const incomingEmails = rows
    .map((r) => r.email?.toLowerCase().trim())
    .filter((e): e is string => !!e);

  let existingEmails = new Set<string>();
  if (incomingEmails.length > 0) {
    const { data: existing } = await admin
      .from("contacts")
      .select("email")
      .eq("tenant_id", me.tenant_id)
      .in("email", incomingEmails);
    existingEmails = new Set((existing ?? []).map((c) => c.email!.toLowerCase()));
  }

  // ── Build payload, skipping duplicates ──────────────────────────
  const payload: Array<{
    id: string; tenant_id: string; full_name: string;
    email: string | null; phone: string | null; company: string | null; title: string | null;
    source: ContactSource; notes: string | null; tags: string[]; imported_by: string;
  }> = [];

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
    payload.push({
      id:          newContactId(),
      tenant_id:   me.tenant_id,
      full_name:   r.fullName.trim(),
      email:       emailLower,
      phone:       r.phone?.trim() || null,
      company:     r.company?.trim() || null,
      title:       r.title?.trim() || null,
      source,
      notes:       r.notes?.trim() || null,
      tags:        r.tags ?? [],
      imported_by: authData.user.id,
    });
    if (emailLower) existingEmails.add(emailLower);
  }

  // ── Batch insert ────────────────────────────────────────────────
  let imported = 0;
  if (payload.length > 0) {
    const { error: insErr, count } = await admin
      .from("contacts")
      .insert(payload, { count: "exact" });
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
    imported = count ?? payload.length;
  }

  return NextResponse.json({
    imported,
    skipped,
    duplicates,
    total: rows.length,
  });
}
