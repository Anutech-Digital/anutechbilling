/**
 * POST /api/marketing/whatsapp/templates/sync
 *
 * Pulls the company's message templates from Meta (GET /{WABA_ID}/message_templates) and
 * brings whatsapp_templates in line: each template's approval status and Meta id are
 * updated; one not yet in the app is added with its body, and a guessed slot mapping that
 * the page flags for checking. A body already in the app is never overwritten — the
 * mapping of slots to lead fields was chosen by a person against that exact text.
 *
 * Needs WhatsApp connected with the business account id (tenant_secrets); 409 otherwise.
 * Authentication templates (OTP) are skipped — they are not for broadcasts.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { resolveWhatsAppCreds } from "@/lib/whatsapp/client";
import { paramCount, type ParamField } from "@/lib/marketing/whatsapp-broadcast";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Record<string, string> = {
  APPROVED: "approved", REJECTED: "rejected", PENDING: "submitted", IN_APPEAL: "submitted",
  PAUSED: "paused", DISABLED: "paused", LIMIT_EXCEEDED: "paused",
};
const GUESS: ParamField[] = ["first_name", "sender", "company"];

interface MetaTemplate {
  id: string; name: string; language: string; status: string; category: string;
  components?: { type: string; text?: string }[];
}

/* R-051: the company's WhatsApp Business account — same gate as connecting company accounts
   (the page is owner/manager in nav; the API took any signed-in member). */
export const POST = withRoute({
  route: "api/marketing/whatsapp/templates/sync",
  roles: ACTION_ROLES["integration.company"],
  roleHint: forbiddenMessage("integration.company"),
}, async ({ tenantId, user }) => {
  const creds = await resolveWhatsAppCreds(tenantId);
  if (!creds?.businessAccountId) {
    return NextResponse.json({ ok: false, error: "WhatsApp connect nahi hai, ya Business Account ID nahi bhara — Settings mein jodo.", code: "not_configured" }, { status: 409 });
  }

  const found: MetaTemplate[] = [];
  let url: string | null =
    `https://graph.facebook.com/v18.0/${encodeURIComponent(creds.businessAccountId)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  for (let page = 0; url && page < 10; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Meta ka apna jawab (upstream) — DB text nahi; 502 kyunki upstream ne mana kiya.
      throw new RouteError(502, `Meta ne mana kiya: ${j?.error?.message ?? res.status}`);
    }
    found.push(...((j.data ?? []) as MetaTemplate[]));
    url = j.paging?.next ?? null;
  }

  // S21: whatsapp_templates generated types me hai — typed admin client, tenant filter explicit.
  const db = createAdminClient();
  const { data: existing } = await db.from("whatsapp_templates").select("id, name, language").eq("tenant_id", tenantId);
  const have = new Map(((existing ?? []) as { id: string; name: string; language: string }[]).map((t) => [`${t.name}|${t.language}`, t.id]));

  let updated = 0, added = 0;
  for (const t of found) {
    if (t.category === "AUTHENTICATION") continue;
    const status = STATUS[t.status] ?? "submitted";
    const category = t.category === "UTILITY" ? "UTILITY" : "MARKETING";
    const id = have.get(`${t.name}|${t.language}`);
    if (id) {
      await db.from("whatsapp_templates").update({ status, meta_id: t.id, category, updated_at: new Date().toISOString() }).eq("id", id);
      updated++;
    } else {
      const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
      if (!body) continue;
      const n = paramCount(body);
      await db.from("whatsapp_templates").insert({
        tenant_id: tenantId, name: t.name, language: t.language, category, body, status, meta_id: t.id,
        param_map: Array.from({ length: n }, (_, i) => GUESS[i] ?? "first_name"),
        notes: n > 0 ? "Meta se aaya — har {{n}} ka field check karo" : null,
        created_by: user.id,
      });
      added++;
    }
  }
  return { found: found.length, updated, added };
});
