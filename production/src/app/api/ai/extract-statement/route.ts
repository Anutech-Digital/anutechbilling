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
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { fixStatementDates } from "@/lib/banking/statement-dates";
import { localDateISO } from "@/lib/leads/outcomes";

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

/* When the configured model is busy (503) or does not answer in time, one attempt on a
   lighter model. Measured 25 Sep 2026: gemini-3.5-flash returned 503 "high demand" twice
   and then timed out, while gemini-flash-lite-latest answered in ~1.5s. Not used for a
   4xx — a file Gemini cannot open stays unopenable on any model. */
const FALLBACK_MODEL = "gemini-flash-lite-latest";
const isBusyOrSlow = (reason: string) =>
  /\b503\b|high demand|unavailable|overload|jawab nahi diya|timed out|paused/i.test(reason);

async function extractWithFallback(
  apiKey: string, model: string, mimeType: string, base64: string,
): Promise<{ rows: AiRow[] | null; reason: string }> {
  let reason = "";
  const first = await extractWithGemini(apiKey, model, mimeType, base64, (r) => { reason = r; });
  if (first) return { rows: first, reason: "" };
  if (model !== FALLBACK_MODEL && isBusyOrSlow(reason)) {
    console.warn(`[ai/extract-statement] ${model} failed (${reason}) — trying ${FALLBACK_MODEL}`);
    const second = await extractWithGemini(apiKey, FALLBACK_MODEL, mimeType, base64, (r) => { reason = r; });
    if (second) return { rows: second, reason: "" };
  }
  return { rows: null, reason };
}

async function extractWithGemini(
  apiKey: string, model: string, mimeType: string, base64: string, onFailure?: (reason: string) => void,
): Promise<AiRow[] | null> {
  /* Pehle yahan apna `fetch` tha — aur iske paas timeout bhi nahi tha. Ye bank statement
     padhta hai, yaani seedha paise ka data, aur ek atki hui call operator ko spinner par
     baithaye rakhti.

     Prompt `user` part me hi rehta hai (systemInstruction nahi) — statement padhne ka
     prompt column-order aur date-format ke bahut se niyam rakhta hai, aur use doosri jagah
     sarkane se nateeja badal sakta tha. Isliye geminiJson ka `system` optional hai.

     Timeout 60s: pehle KOI nahi tha, phir 30s — par 25 Sep 2026 ko ek poore mahine ki
     statement 30s me do baar time out hui. PDF ka jawab text se dheema aata hai, aur
     operator ke saamne progress spinner chalta rehta hai. */
  const json = await geminiJson<{ rows?: AiRow[] }>({
    apiKey, model,
    user: PROMPT,
    attachment: { mimeType, base64 },
    temperature: 0,
    timeoutMs: 60_000,
    label: "ai/extract-statement",
    onFailure,
  });
  if (!json) return null;
  return Array.isArray(json.rows) ? json.rows : [];
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

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  /* R-1470: only roles that open Banking (statement import) — before any read, AI call or spend. */
  if (!mayOpenPage(me?.role, ["/accounting/banking"])) return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) {
    return NextResponse.json(
      { error: "AI reading isn't set up. Add your Gemini key in Settings → Integrations → AI, or upload the CSV instead." },
      { status: 400 },
    );
  }

  const { rows: ai, reason } = await extractWithFallback(gemini.apiKey, gemini.model, parsed.mimeType, parsed.fileBase64);
  if (!ai) {
    /* Say WHICH failure it was. "Couldn't read this statement" used to cover a busy
       Google, a timeout and an unopenable file alike — three different next steps. */
    const why = isBusyOrSlow(reason)
      ? "Google's AI is busy or slow right now. Try again in a minute"
      : /\b400\b|invalid argument/i.test(reason)
        ? "The AI couldn't open this file (a password-protected or damaged PDF does this)"
        : reason
          ? `The AI reader failed — ${reason.replace(/\.$/, "")}`
          : "The AI reader failed";
    return NextResponse.json(
      { error: `${why}. The CSV / "Delimited" download from net banking always works and needs no AI.` },
      { status: 502 },
    );
  }

  const clean = sanitizeRows(ai);
  /* Real calendar dates only (the reader has returned "2026-21-08" for 21 Aug). Swaps are
     decided for the whole statement; a date impossible either way is dropped and counted. */
  const fix = fixStatementDates(clean.rows.map((r) => r.txn_date), localDateISO(new Date(Date.now() + 86_400_000)));   // +1 day: server clock may be UTC
  const rows = clean.rows.flatMap((r, i) => (fix.dates[i] ? [{ ...r, txn_date: fix.dates[i]! }] : []));
  const skipped = clean.skipped + (clean.rows.length - rows.length);
  return NextResponse.json({ rows, skipped, mode: "gemini", datesSwapped: fix.swapped, datesSwappedAll: fix.swappedAll });
}
