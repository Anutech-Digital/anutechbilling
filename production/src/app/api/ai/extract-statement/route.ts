/**
 * POST /api/ai/extract-statement
 *
 * Reads an uploaded BANK STATEMENT (PDF or image) with Gemini vision and returns
 * the transaction rows to pre-fill the Import dialog. ZERO money-write — it only
 * returns parsed rows; the operator REVIEWS the preview before importing. Bank
 * PDF layouts vary wildly (and are often image-only), so AI is far more reliable
 * than text extraction. Tenant-scoped Gemini key (Settings → Integrations → AI).
 *
 * Body: { fileBase64: string (raw base64, no data: prefix), mimeType: string }
 * Returns: { rows: [{txn_date, description, debit, credit, balance_after}], mode } or { error }.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";

const bodySchema = z.object({
  fileBase64: z.string().min(20, "Empty file"),
  mimeType: z.string().min(3),
});

const PROMPT =
  "You are reading an INDIAN bank account statement (HDFC/ICICI/SBI/Axis/Kotak/etc.). " +
  "Extract EVERY transaction row. Return ONLY JSON:\n" +
  "{ \"rows\": [ { \"date\": string, \"description\": string, \"debit\": number, \"credit\": number, \"balance\": number|null } ] }\n" +
  "RULES: date as YYYY-MM-DD (Indian statements are DD/MM/YYYY — convert). " +
  "A row is EITHER a debit (money out / withdrawal) OR a credit (money in / deposit) — put the amount in the right field and 0 in the other; never both. " +
  "Amounts are plain numbers, no commas or ₹. balance = running/closing balance if the statement shows one, else null. " +
  "description = the narration/particulars text (UPI/NEFT/cheque details). " +
  "SKIP non-transaction lines: opening balance, closing balance, sub-totals, carried-forward, page headers/footers. " +
  "Keep chronological order as printed. If you cannot read it, return { \"rows\": [] }.";

type AiRow = { date?: string; description?: string; debit?: number; credit?: number; balance?: number | null };

function toDate(input: unknown): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    let yy = m[3];
    if (yy.length === 2) yy = (parseInt(yy, 10) > 50 ? "19" : "20") + yy;
    return `${yy}-${mm}-${dd}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const toInt = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

/** Turn the AI rows into the ParsedRow shape the import expects; drop junk. */
function sanitizeRows(rows: AiRow[]) {
  const out: { txn_date: string; description: string; debit: number; credit: number; balance_after: number | null; reference: null }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const date = toDate(r.date);
    const debit = toInt(r.debit);
    const credit = toInt(r.credit);
    if (!date || (debit === 0 && credit === 0) || (debit > 0 && credit > 0)) { skipped++; continue; }
    const balRaw = r.balance;
    out.push({
      txn_date: date,
      description: String(r.description ?? "").trim() || "(no description)",
      debit, credit,
      balance_after: balRaw == null ? null : (toInt(balRaw) || null),
      reference: null,
    });
  }
  return { rows: out, skipped };
}

async function extractWithGemini(apiKey: string, model: string, mimeType: string, base64: string): Promise<AiRow[] | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[ai/extract-statement] Gemini failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const json = JSON.parse(cleaned) as { rows?: AiRow[] };
    return Array.isArray(json.rows) ? json.rows : [];
  } catch (err) {
    console.error("[ai/extract-statement] Gemini crashed:", err);
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

  if (!/^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i.test(parsed.mimeType)) {
    return NextResponse.json({ error: "Upload a PDF or photo of the statement." }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) {
    return NextResponse.json(
      { error: "AI reading isn't set up. Add your Gemini key in Settings → Integrations → AI, or upload the CSV instead." },
      { status: 400 },
    );
  }

  const ai = await extractWithGemini(gemini.apiKey, gemini.model, parsed.mimeType, parsed.fileBase64);
  if (!ai) {
    return NextResponse.json({ error: "Couldn't read this statement. Try the CSV download from net banking instead." }, { status: 502 });
  }

  const { rows, skipped } = sanitizeRows(ai);
  return NextResponse.json({ rows, skipped, mode: "gemini" });
}
