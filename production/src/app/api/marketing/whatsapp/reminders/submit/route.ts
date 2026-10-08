/**
 * POST /api/marketing/whatsapp/reminders/submit  { kinds?: ReminderKind[] }
 *
 * S28 — submits the starter reminder templates (STARTER_REMINDER_TEMPLATES) to Meta for
 * approval from the app: POST https://graph.facebook.com/v18.0/{WABA}/message_templates,
 * one per template, UTILITY, language "en", with one example value per {{n}}.
 *
 * Default: every starter that is not already approved / pending in whatsapp_templates.
 * Each accepted template is written to whatsapp_templates with Meta's status and id, so the
 * reminders screen shows "submitted" at once; "Sync from Meta" keeps it fresh afterwards.
 * "Already exists" on Meta is fine — reported as "pehle se submit hai", nothing written.
 *
 * Owner / manager only; tenant from the session (withRoute). The access token goes only in
 * the Authorization header — never in the response or a log line. Partial success is 200
 * with per-template results (AGENTS.md L3); WhatsApp not connected is 409 (L6).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { withRoute, dbFail } from "@/lib/api/with-route";
import { resolveWhatsAppCreds } from "@/lib/whatsapp/client";
import { isReminderKind, type ReminderKind } from "@/lib/marketing/whatsapp-reminders";
import {
  STARTER_LANGUAGE, appStatusFromMeta, isDuplicateTemplateError, metaErrorText, metaTemplateRequest, startersToSubmit,
} from "@/lib/marketing/whatsapp-reminders-submit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "api/marketing/whatsapp/reminders/submit";

const inputSchema = z.object({
  kinds: z.array(
    z.string().refine((k): k is ReminderKind => isReminderKind(k), "Ye reminder kind nahi hai — page refresh kariye."),
  ).max(20).optional(),
});

interface SubmitResult { kind: ReminderKind; name: string; ok: boolean; status: string | null; error?: string }

export const POST = withRoute(
  {
    route: ROUTE, input: inputSchema, roles: ["owner", "manager"],
    roleHint: "Meta par template sirf owner / manager bhej sakte hain — unse kahiye.",
  },
  async ({ input, tenantId, user }) => {
    const creds = await resolveWhatsAppCreds(tenantId).catch(() => null);
    if (!creds?.businessAccountId) {
      return NextResponse.json({
        ok: false, code: "not_configured",
        error: "WhatsApp Business connect nahi hai (ya Business Account ID nahi bhara). Pehle Settings → Integrations mein WhatsApp Business connect karo.",
      }, { status: 409 });
    }

    const db = createAdminClientFor(user.id);
    const { data: existing, error } = await db.from("whatsapp_templates")
      .select("id, name, language, status").eq("tenant_id", tenantId);
    dbFail(error, "Templates load nahi hue — page refresh karke dobara try kariye.");
    const rows = (existing ?? []) as { id: string; name: string; language: string; status: string }[];

    const todo = startersToSubmit(rows, input.kinds as ReminderKind[] | undefined);
    const results: SubmitResult[] = [];
    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(creds.businessAccountId)}/message_templates`;

    // One at a time: six requests, and Meta rate-limits template creation per WABA.
    for (const s of todo) {
      const payload = metaTemplateRequest(s);
      let res: Response;
      let j: unknown;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        j = await res.json().catch(() => ({}));
      } catch {
        console.warn(`[${ROUTE}] ${s.name}: Meta tak request nahi pahunchi`);
        results.push({ kind: s.kind, name: s.name, ok: false, status: null, error: "Meta tak pahunch nahi paaye (network) — thodi der baad dobara bhejo." });
        continue;
      }

      const prev = rows.find((r) => r.name === s.name && r.language === STARTER_LANGUAGE);
      if (!res.ok) {
        if (isDuplicateTemplateError(j)) {
          results.push(prev?.status === "rejected"
            ? { kind: s.kind, name: s.name, ok: false, status: "rejected",
                error: "Meta par ye naam pehle se hai aur rejected hai — WhatsApp Manager mein edit karke dobara bhejo." }
            : { kind: s.kind, name: s.name, ok: true, status: prev?.status ?? null,
                error: "Pehle se submit hai — status ke liye \"Sync from Meta\" dabao." });
          continue;
        }
        const e = (j as { error?: { code?: number; error_subcode?: number } })?.error;
        console.warn(`[${ROUTE}] ${s.name}: Meta ${res.status} code=${e?.code ?? "-"} subcode=${e?.error_subcode ?? "-"}`);
        results.push({ kind: s.kind, name: s.name, ok: false, status: null, error: metaErrorText(j, res.status, creds.accessToken) });
        continue;
      }

      const created = j as { id?: string; status?: string; category?: string };
      const status = appStatusFromMeta(created.status);
      // Meta can re-categorise; keep what it says when it is one the table allows.
      const category = created.category === "MARKETING" ? "MARKETING" : "UTILITY";
      const now = new Date().toISOString();
      const write = prev
        ? await db.from("whatsapp_templates")
            .update({ body: s.body, status, meta_id: created.id ?? null, category, param_map: s.param_map, updated_at: now })
            .eq("id", prev.id).eq("tenant_id", tenantId)
        : await db.from("whatsapp_templates").insert({
            tenant_id: tenantId, name: s.name, language: STARTER_LANGUAGE, category, body: s.body, status,
            meta_id: created.id ?? null, param_map: s.param_map,
            notes: "Reminder starter (S28) — app se Meta ko bheja; broadcast ke liye nahi.",
            created_by: user.id,
          });
      if (write.error) {
        console.warn(`[${ROUTE}] ${s.name}: Meta ne liya par row save nahi hui: ${write.error.message}`);
        results.push({ kind: s.kind, name: s.name, ok: true, status,
          error: "Meta ne le liya, par app mein status save nahi hua — \"Sync from Meta\" dabao." });
        continue;
      }
      results.push({ kind: s.kind, name: s.name, ok: true, status });
    }

    return { submitted: results.filter((r) => r.ok).length, results };
  },
);
