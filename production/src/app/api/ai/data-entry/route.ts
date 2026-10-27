/**
 * POST /api/ai/data-entry — read pasted text and/or a photo/PDF into PROPOSED records.
 *
 * Writes nothing (see lib/ai/data-entry.ts). The operator reviews each proposal and saves
 * it through the normal form mutation. Each proposal comes back with any existing lead,
 * customer or vendor that shares its phone, email, GSTIN or name, so a repeat enquiry is
 * opened rather than entered twice.
 *
 * Without a Gemini key the text still reads: the regex extractor (lib/inbound/extract.ts)
 * proposes one lead from name / email / phone / seats, and the response says it was the
 * fallback, so nobody mistakes it for the AI having read the input.
 *
 * Body: { text?: string, fileBase64?: string, mimeType?: string }
 * Returns: { entries: ProposalWithMatches[], mode: "gemini" | "basic" } | { error }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { dataEntryPrompt, sanitizeEntries, sanitizeNotes, proposalKeys, MAX_INPUT_CHARS, type EntryProposal, type AiLawNote } from "@/lib/ai/data-entry";
import { extractEntities } from "@/lib/inbound/extract";
import { rateLimit } from "@/lib/security/rate-limit";
import { istToday, fyStartISO } from "@/lib/dates/ist";
import { logAiDecision } from "@/lib/ai/audit";

const READABLE = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;
const MAX_FILE_B64 = 8 * 1024 * 1024; // ~6 MB file

const bodySchema = z.object({
  text: z.string().max(MAX_INPUT_CHARS).optional(),
  fileBase64: z.string().max(MAX_FILE_B64).optional(),
  mimeType: z.string().max(60).optional(),
}).refine((b) => (b.text?.trim().length ?? 0) > 0 || !!b.fileBase64, "Paste some text or add a photo/PDF.");

export interface ExistingMatch { type: "lead" | "customer" | "vendor"; id: string; label: string; by: string }
export interface ProposalContext {
  /** Already paid to this vendor this financial year (expenses + vendor bills) — TDS thresholds are yearly. */
  vendorYtd?: number;
}
export type ProposalWithMatches = EntryProposal & { matches: ExistingMatch[]; context: ProposalContext };

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const rl = rateLimit(`ai-data-entry:${user.id}`, { limit: 30, windowMs: 10 * 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ error: `Too many reads — try again in ${rl.retryAfterSec}s.` }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : null;
    return NextResponse.json({ error: msg ?? "Invalid request." }, { status: 400 });
  }
  if (body.fileBase64 && !READABLE.test(body.mimeType ?? "")) {
    return NextResponse.json({ error: "Add a photo (JPG/PNG) or a PDF." }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  /* R-1470: only roles that open the AI Entry page — before any read, AI call or spend. */
  if (!mayOpenPage(me?.role, ["/ai-entry"])) return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  const today = istToday();
  const text = body.text?.trim() ?? "";

  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  let entries: EntryProposal[] = [];
  let notes: AiLawNote[] = [];
  let mode: "gemini" | "basic" = "gemini";

  if (gemini.apiKey) {
    const raw = await geminiJson<unknown>({
      apiKey: gemini.apiKey,
      model: gemini.model,
      tenantId: gemini.tenantId,
      system: dataEntryPrompt(today),
      user: text || "Read the attached file.",
      attachment: body.fileBase64 ? { mimeType: body.mimeType!, base64: body.fileBase64 } : undefined,
      temperature: 0.1,
      timeoutMs: 30_000,
      label: "ai-data-entry",
    });
    if (raw === null) {
      await logAiDecision(supabase, { action: "ai_fallback", entity: "data_entry", label: "Gemini did not answer — basic read" });
      mode = "basic";
    } else {
      entries = sanitizeEntries(raw, today);
      notes = sanitizeNotes(raw);
    }
  } else {
    mode = "basic";
  }

  if (mode === "basic") {
    if (!text) {
      return NextResponse.json({ error: "Reading photos needs AI. Add your Gemini key in Settings → Integrations → AI, or type the details." }, { status: 400 });
    }
    const x = extractEntities({ fromName: null, fromEmail: null, subject: null, body: text });
    if (x.name.value || x.email.value || x.phone.value) {
      entries = sanitizeEntries({ entries: [{ kind: "lead", confidence: 0.4, why: "Basic read (no AI): name / email / phone found in the text",
        fields: { contact_name: x.name.value, contact_email: x.email.value, contact_phone: x.phone.value, seats: x.seats.value, notes: text.slice(0, 300) } }] }, today);
    }
  }

  const fyStart = fyStartISO(today);
  const withMatches: ProposalWithMatches[] = await Promise.all(entries.map(async (p) => {
    const context: ProposalContext = {};
    if (p.kind === "expense" && p.fields.vendor_name) context.vendorYtd = await vendorYtd(supabase, p.fields.vendor_name, fyStart);
    return { ...p, matches: await findMatches(supabase, p), context };
  }));
  return NextResponse.json({ entries: withMatches, notes, mode });
}

/** Existing records that share a phone, email, GSTIN or exact name with a proposal. RLS-scoped. */
async function findMatches(supabase: ReturnType<typeof createClient>, p: EntryProposal): Promise<ExistingMatch[]> {
  const k = proposalKeys(p);
  const out: ExistingMatch[] = [];
  const seen = new Set<string>();
  const push = (m: ExistingMatch) => { const key = `${m.type}:${m.id}`; if (!seen.has(key) && out.length < 5) { seen.add(key); out.push(m); } };
  const last10 = (ph: string) => ph.replace(/\D/g, "").slice(-10);

  if (p.kind === "lead" || p.kind === "customer" || p.kind === "task" || p.kind === "payment") {
    for (const ph of k.phones) {
      const d = last10(ph);
      const [{ data: l }, { data: c }] = await Promise.all([
        supabase.from("leads").select("id, company").ilike("contact_phone", `%${d}`).limit(3),
        supabase.from("customers").select("id, name").ilike("contact_phone", `%${d}`).limit(3),
      ]);
      (l ?? []).forEach((r) => push({ type: "lead", id: r.id, label: r.company || r.id, by: "phone" }));
      (c ?? []).forEach((r) => push({ type: "customer", id: r.id, label: r.name, by: "phone" }));
    }
    for (const em of k.emails) {
      const [{ data: l }, { data: c }] = await Promise.all([
        supabase.from("leads").select("id, company").ilike("contact_email", em).limit(3),
        supabase.from("customers").select("id, name").ilike("contact_email", em).limit(3),
      ]);
      (l ?? []).forEach((r) => push({ type: "lead", id: r.id, label: r.company || r.id, by: "email" }));
      (c ?? []).forEach((r) => push({ type: "customer", id: r.id, label: r.name, by: "email" }));
    }
    const names = [...k.names, ...(p.kind === "task" && p.fields.company ? [p.fields.company] : []), ...(p.kind === "payment" && p.fields.payer ? [p.fields.payer] : [])];
    for (const n of names) {
      const [{ data: l }, { data: c }] = await Promise.all([
        supabase.from("leads").select("id, company").ilike("company", n).limit(3),
        supabase.from("customers").select("id, name").ilike("name", n).limit(3),
      ]);
      (l ?? []).forEach((r) => push({ type: "lead", id: r.id, label: r.company || r.id, by: "name" }));
      (c ?? []).forEach((r) => push({ type: "customer", id: r.id, label: r.name, by: "name" }));
    }
    for (const g of k.gstins) {
      const { data: c } = await supabase.from("customers").select("id, name").eq("gstin", g).limit(3);
      (c ?? []).forEach((r) => push({ type: "customer", id: r.id, label: r.name, by: "GSTIN" }));
    }
  }
  if (p.kind === "vendor_bill" || p.kind === "expense") {
    const vName = p.fields.vendor_name;
    const vGstin = p.kind === "vendor_bill" ? p.fields.vendor_gstin : null;
    if (vGstin) {
      const { data } = await supabase.from("vendors").select("id, name").eq("gstin", vGstin).limit(3);
      (data ?? []).forEach((r) => push({ type: "vendor", id: r.id, label: r.name, by: "GSTIN" }));
    }
    if (vName) {
      const { data } = await supabase.from("vendors").select("id, name").ilike("name", vName).limit(3);
      (data ?? []).forEach((r) => push({ type: "vendor", id: r.id, label: r.name, by: "name" }));
    }
  }
  return out;
}

/** Paid / billed to a vendor (by name) since the start of this financial year. RLS-scoped. */
async function vendorYtd(supabase: ReturnType<typeof createClient>, vendorName: string, fyStart: string): Promise<number> {
  const [{ data: ex }, { data: vb }] = await Promise.all([
    supabase.from("expenses").select("amount").ilike("vendor_name", vendorName).gte("expense_date", fyStart).limit(1000),
    supabase.from("vendor_bills").select("total").ilike("vendor_name", vendorName).gte("bill_date", fyStart).limit(1000),
  ]);
  return Math.round((ex ?? []).reduce((a, r) => a + Number(r.amount || 0), 0) + (vb ?? []).reduce((a, r) => a + Number(r.total || 0), 0));
}
