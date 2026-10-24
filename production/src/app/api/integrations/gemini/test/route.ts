/**
 * POST /api/integrations/gemini/test — verify the saved Gemini key actually
 * works by issuing one tiny generateContent ping. Owner-only. Never returns the
 * key. Uses the resolver so it tests exactly what the AI features will use
 * (tenant key → env fallback).
 *
 * ─── YE JAAN-BOOJHKAR `geminiJson` SE NAHI GUZARTA ──────────────────────────
 * 28 Aug 2026 ko baaki SAARE Gemini call `lib/ai/gemini.ts` par le aaye gaye, taaki sabko
 * timeout, circuit breaker aur retry mile. Ye ek route apna `fetch` rakhta hai, aur wajah
 * seedhi hai: is route ka kaam hi "abhi, is key se, kya hota hai" batana hai.
 *
 * Breaker module-scoped hai. Agar kisi doosre feature ne abhi teen baar fail kiya hai, to
 * breaker khula hoga aur geminiJson bina Google ko chhue `null` laut ayega — aur ye page
 * "aapki key kaam nahi karti" dikha dega, jabki key bilkul theek hai. Ek diagnostic ko
 * doosre feature ki haalat par nirbhar karna use diagnostic hi nahi rehne deta.
 *
 * Isi tarah retry bhi nahi chahiye: yahan ek koshish ka SACH chahiye, chhupa hua dobara
 * prayaas nahi.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function POST() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 403 });
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me) return NextResponse.json({ ok: false, error: "User not linked to a tenant" }, { status: 403 });
  if (me.role !== "owner") return NextResponse.json({ ok: false, error: "Owner only" }, { status: 403 });

  const admin = createAdminClient();
  /* R-1759: this tests the GEMINI key even when AI runs on Claude — never send the Claude key to Google. */
  const { geminiKey: apiKey, geminiModel: model } = await resolveGeminiConfig(admin, me.tenant_id);
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "No Gemini key configured (tenant or env)." }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
          generationConfig: { maxOutputTokens: 5, temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[integrations/gemini/test] failed:", res.status, detail.slice(0, 300));

      // Make the error actionable: list the key's available generateContent
      // models (esp. for 404 = stale/invalid model name).
      let suggest = "";
      try {
        const lm = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (lm.ok) {
          const j = (await lm.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
          const names = (j.models ?? [])
            .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
            .map((m) => (m.name ?? "").replace(/^models\//, ""))
            .filter((n) => n.startsWith("gemini"))
            .slice(0, 8);
          if (names.length) suggest = ` Available models: ${names.join(", ")}.`;
        }
      } catch { /* best-effort */ }

      const base =
        res.status === 400 ? "Key rejected by Google — check the key + that the Generative Language API is enabled."
        : res.status === 403 ? "Access denied — enable the Generative Language API for this key."
        : res.status === 404 ? `Model "${model}" not found for this key — set a valid model in the Model field.`
        : `Gemini returned ${res.status}.`;
      return NextResponse.json({ ok: false, error: base + suggest }, { status: 200 });
    }
    return NextResponse.json({ ok: true, model });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Network error" }, { status: 200 });
  }
}
