/**
 * POST /api/ai/classify-junk
 *
 * AI junk-lead classifier. Given a batch of lead ids, decides for each whether
 * it looks like spam / fake / test noise vs a real potential customer, with a
 * short reason and a confidence score. ZERO writes — it only returns verdicts;
 * the operator confirms + marks junk via the existing useSetLeadJunk mutation
 * (marking is reversible, so a human always stays in the loop).
 *
 * Stub-or-Gemini (same contract as /api/ai/draft-followup): when no Gemini key
 * is configured it falls back to the deterministic looksLikeJunk() heuristic, so
 * the feature never hard-fails. `mode: "gemini" | "stub"` tells the client which
 * ran, so it can nudge the operator to add a key for smarter results.
 *
 * Tenant-safe: leads are fetched via the operator's SESSION client (RLS), so a
 * user can only classify their own tenant's leads.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { looksLikeJunk } from "@/lib/leads/junk";

const bodySchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1).max(50),
});

interface Verdict {
  id: string;
  suspect: boolean;
  reason: string;
  /** 0..1 — model's confidence that this lead is junk. Stub uses 0 / 0.5. */
  confidence: number;
}

type LeadCtx = {
  id: string;
  company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  plan: string | null;
  seats: number | null;
  source: string | null;
  notes: string | null;
};

async function classifyWithGemini(apiKey: string, model: string, leads: LeadCtx[]): Promise<Verdict[] | null> {
  const system =
    "You are a spam/junk-lead detector for an Indian cloud-software reseller's CRM " +
    "(they sell Google Workspace, Microsoft 365, Zoho to SME businesses). " +
    "For each lead decide whether it is JUNK — i.e. fake, test, bot, or spam with no " +
    "real buying intent — versus a genuine potential customer. " +
    "Signals of junk: gibberish or placeholder names/companies (test, asdf, dummy, xxx), " +
    "no usable phone AND no usable email, obviously fake/disposable emails, " +
    "nonsense or contradictory fields, single-character or numeric-only names. " +
    "Signals of REAL: a plausible business/person name with at least one real contact " +
    "channel, a sensible plan/seats, notes describing a genuine need. " +
    "BE CONSERVATIVE: real leads are valuable, so when in doubt mark suspect=false. " +
    "Never mark a lead junk only because some optional fields are blank. " +
    'Return ONLY a JSON array, one object per input lead, same order: ' +
    '[{"id": string, "suspect": boolean, "reason": string (max 8 words), "confidence": number 0..1}].';

  const user =
    "Classify these leads:\n" +
    JSON.stringify(
      leads.map((l) => ({
        id: l.id,
        company: l.company,
        name: l.contact_name,
        email: l.contact_email,
        phone: l.contact_phone,
        plan: l.plan,
        seats: l.seats,
        source: l.source,
        notes: l.notes ? l.notes.slice(0, 300) : null,
      })),
    );

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[ai/classify-junk] Gemini failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const arr = JSON.parse(cleaned) as Array<Partial<Verdict>>;
    if (!Array.isArray(arr)) return null;
    // Keep only well-formed rows whose id matched an input lead.
    const ids = new Set(leads.map((l) => l.id));
    const verdicts: Verdict[] = [];
    for (const v of arr) {
      if (typeof v.id !== "string" || !ids.has(v.id)) continue;
      const conf = typeof v.confidence === "number" ? Math.min(1, Math.max(0, v.confidence)) : (v.suspect ? 0.6 : 0);
      verdicts.push({
        id: v.id,
        suspect: !!v.suspect,
        reason: (v.reason ?? "").toString().slice(0, 80),
        confidence: conf,
      });
    }
    return verdicts.length ? verdicts : null;
  } catch (err) {
    console.error("[ai/classify-junk] Gemini crashed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);

  // Fetch the leads via the SESSION client (RLS) — a user only ever sees theirs.
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, company, contact_name, contact_email, contact_phone, plan, seats, source, notes")
    .in("id", parsed.leadIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!leads || leads.length === 0) return NextResponse.json({ verdicts: [], mode: "stub" });

  const ai = gemini.apiKey ? await classifyWithGemini(gemini.apiKey, gemini.model, leads as LeadCtx[]) : null;

  // Deterministic fallback (also fills any lead the model skipped) — reuses the
  // SAME heuristic the leads page uses, so behaviour matches when no key is set.
  const byId = new Map<string, Verdict>((ai ?? []).map((v) => [v.id, v]));
  const verdicts: Verdict[] = leads.map((l) => {
    const fromAi = byId.get(l.id);
    if (fromAi) return fromAi;
    const h = looksLikeJunk(l);
    return { id: l.id, suspect: h.suspect, reason: h.reason || (h.suspect ? "Looks like junk" : "Looks genuine"), confidence: h.suspect ? 0.5 : 0 };
  });

  return NextResponse.json({ verdicts, mode: ai ? "gemini" : "stub" });
}
