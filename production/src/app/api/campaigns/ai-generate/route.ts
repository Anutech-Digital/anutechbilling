/**
 * POST /api/campaigns/ai-generate
 *
 * Generate a campaign (subject + responsive HTML body + plain text fallback)
 * from a short natural-language prompt + category. Uses Gemini (env:
 * GEMINI_API_KEY, GEMINI_MODEL). If the key isn't configured, falls back
 * to a deterministic stub so the UX still works in dev.
 *
 * Body:
 *   { prompt: string; category?: 'newsletter'|'offer'|'winback'|'onboarding'|'custom';
 *     includeOffer?: boolean }
 *
 * Returns:
 *   { name: string; subject: string; body_html: string; body_text: string;
 *     mode: 'gemini' | 'stub' }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  prompt:        z.string().min(5).max(2000),
  category:      z.enum(["newsletter","offer","winback","onboarding","custom"]).default("custom"),
  includeOffer:  z.boolean().default(false),
});

const SYSTEM_PROMPT = `You write email campaigns for an Indian cloud reseller business (Google Workspace, Microsoft 365, Zoho). The audience is Indian SME owners and IT managers.

Output ONLY a valid JSON object with these exact keys:
{
  "name":       "<short internal name, under 40 chars>",
  "subject":    "<email subject under 80 chars, may include 1 emoji>",
  "body_html":  "<responsive HTML email — single-column table-based layout, max-width 560px, inline CSS only, no external assets>",
  "body_text":  "<plain-text version, multi-line>"
}

Template variables you MAY reference (substituted at send time):
  {{name}}        first name
  {{company}}     company name
  {{sender}}      reseller's brand name
  {{offer_code}}  promo code  (only when includeOffer = true)
  {{discount}}    discount %  (only when includeOffer = true)
  {{expires}}     formatted offer expiry date (only when includeOffer = true)

HTML rules:
- Use <table role="presentation"> for layout (NO divs for structure)
- Use inline styles ONLY (style="...")  — no <style> tags, no classes
- Font stack: 'Plus Jakarta Sans', Helvetica, Arial, sans-serif
- Background: #f8f6f2 (paper) outer, #ffffff inner card
- Body text: #3a3530, headings: #1c1a17, muted: #8a857d
- Accent (CTAs / highlights): #c2410c (amber)
- Border radius: 8px on the inner card
- Max width: 560px
- One clear CTA per email (e.g., "Reply for a quote" — no buttons that need href)
- Hindi/English mix is OK for tone but keep code in English
- No images. No external scripts. No links to external sites.
- End with a sign-off using {{sender}}

Tone: warm, founder-first-person, brief. No marketing fluff. No "Dear Sir/Madam".

Do NOT include any markdown fences (no \`\`\`json). Output the JSON object directly.`;

interface GenResult {
  name:      string;
  subject:   string;
  body_html: string;
  body_text: string;
}

function stubResult(prompt: string, category: string): GenResult {
  const subj = category === "offer"
    ? "{{discount}}% off Workspace — code {{offer_code}}"
    : category === "winback"
      ? "Checking in on {{company}}"
      : "Update from {{sender}}";
  return {
    name:    `${category[0].toUpperCase()}${category.slice(1)} draft`,
    subject: subj,
    body_html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8f6f2;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;color:#1c1a17;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f2;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #e7e2db;">
      <tr><td style="padding:32px;">
        <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#3a3530;">Hi {{name}},</p>
        <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#3a3530;">${escapeHtml(prompt.slice(0, 500))}</p>
        <p style="margin:24px 0 0 0;font-size:14px;color:#8a857d;">Cheers,<br><b style="color:#1c1a17;">{{sender}}</b></p>
      </td></tr>
    </table>
    <p style="margin:12px 0 0 0;font-size:11px;color:#8a857d;">[Stub draft — set GEMINI_API_KEY for real AI generation]</p>
  </td></tr>
</table></body></html>`,
    body_text: `Hi {{name}},\n\n${prompt.slice(0, 600)}\n\nCheers,\n{{sender}}`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function callGemini(apiKey: string, model: string, prompt: string, category: string, includeOffer: boolean): Promise<GenResult | null> {
  const userPrompt = `Category: ${category}
Include offer block (use {{offer_code}}/{{discount}}/{{expires}}): ${includeOffer}

Operator's brief:
${prompt}

Return ONLY the JSON object as specified.`;

  {
    /* Pehle apna `fetch` tha — geminiJson ki hu-ba-hu copy, uski suraksha ke bina.
       Fence kaatna bhi wahin ho chuka hai. */
    const parsed = await geminiJson<GenResult>({
      apiKey, model,
      system: SYSTEM_PROMPT,
      user: userPrompt,
      temperature: 0.8,
      label: "campaigns/ai-generate",
    });
    if (!parsed) return null;

    if (!parsed.subject || !parsed.body_html) return null;
    return {
      name:      parsed.name      ?? "AI draft",
      subject:   parsed.subject,
      body_html: parsed.body_html,
      body_text: parsed.body_text ?? "",
    };
  }
  /* try/catch chala gaya — geminiJson khud "never throws" hai. */
}

export async function POST(req: Request) {
  // Authn
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  const { prompt, category, includeOffer } = parsed.data;

  // Resolve tenant's Gemini config (tenant key → env → stub)
  const { data: me } = await userClient.from("users").select("tenant_id, role").eq("id", authData.user.id).maybeSingle();
  /* R-1470: a campaign is written for the roles that may send one (ACTION_ROLES campaign.send —
     owner, manager); the composer's Send campaign item is hidden from sales on Leads too. */
  if (!mayDo(me?.role, "campaign.send")) {
    return NextResponse.json({ error: forbiddenMessage("campaign.send") }, { status: 403 });
  }
  const gemini = await resolveGeminiConfig(userClient, me?.tenant_id ?? null);

  // Try Gemini; fall back to stub
  const result = gemini.apiKey ? await callGemini(gemini.apiKey, gemini.model, prompt, category, includeOffer) : null;
  if (result) {
    return NextResponse.json({ ...result, mode: "gemini" });
  }
  return NextResponse.json({ ...stubResult(prompt, category), mode: "stub" });
}
