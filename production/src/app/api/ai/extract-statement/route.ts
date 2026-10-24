/**
 * POST /api/ai/extract-statement
 *
 * Reads an uploaded BANK STATEMENT (PDF or image) with Gemini vision and returns
 * the transaction rows to pre-fill the Import dialog. ZERO money-write — it only
 * returns parsed rows; the operator REVIEWS the preview before importing. Bank
 * PDF layouts vary wildly (and are often image-only), so AI is far more reliable
 * than text extraction. Tenant-scoped Gemini key (Settings → Integrations → AI).
 *
 * Body: { fileBase64: string (raw base64, no data: prefix), mimeType: string,
 *         pages?: { from, to, total } }   ← R-1690: read only these pages of a PDF
 * Returns: { rows: [{txn_date, description, debit, credit, balance_after}], mode, chunk?,
 *            rowCount (the model's own count of lines on those pages, or null), rowsReturned }
 *          or { error, kind } with 504 (timeout), 503 (busy) or 502 (anything else).
 *
 * R-1690 (19 Oct 2026): a one-month statement in ONE call timed out at 60 s on both models,
 * every time. The import dialog now counts the pages and asks for a few at a time
 * (lib/banking/statement-chunks.ts has the why, the merge and the money rules). With
 * `pages`, the rows' dates come back as read — the dialog fixes day/month swaps once over
 * the merged statement, because that decision is for the whole statement, not two pages.
 * Images, and a PDF sent without `pages`, are one call exactly as before.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { fixStatementDates } from "@/lib/banking/statement-dates";
import { localDateISO } from "@/lib/leads/outcomes";
import { classifyStatementFailure } from "@/lib/banking/statement-chunks";

/* Worst case for ONE request: 60 s + retry 60 s on the main model, then the same on the
   lighter one ≈ 4 min. Cloud Run's request timeout is 600 s (cloudbuild.yaml --timeout=600);
   this keeps a platform that reads `maxDuration` from cutting it shorter. A chunked statement
   is several such requests, each well inside the limit — never one long one. */
export const maxDuration = 300;

const bodySchema = z.object({
  fileBase64: z.string().min(20, "Empty file"),
  mimeType: z.string().min(3),
  pages: z.object({
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    total: z.number().int().min(1).max(1000),
  }).refine((p) => p.from <= p.to && p.to <= p.total, "Bad page range").optional(),
});

type Pages = { from: number; to: number; total: number };

/** Added to the prompt for one chunk. Names the pages, and who owns a row split by a page
    break, so each row is read once — the merge drops an exact repeat at a border, but it
    cannot bring back a row that both chunks skipped. */
function pagesPrompt(p: Pages): string {
  return `\n\nThis PDF has ${p.total} pages. Read ONLY pages ${p.from} to ${p.to} (page 1 = the first page of the file). ` +
    "Return only the transaction rows printed on those pages and ignore every other page. " +
    `A row that starts on page ${p.to} and continues onto the next page belongs to you` +
    (p.from > 1 ? `; a row that started on page ${p.from - 1} and continues onto page ${p.from} does not. ` : ". ") +
    "If those pages have no transaction rows, return { \"rows\": [] }.";
}

/* R-1693 (20 Oct 2026): every chunk of a 24-page HDFC PDF came back 200, yet lines were
   simply missing from the answers — ₹7,96,835 short after import. So the prompt now insists
   on every line and asks the model to COUNT the lines per page; the browser compares that
   count with the rows written, and checks the running-balance chain (statement-verify.ts). */
const PROMPT =
  "You are reading an INDIAN bank account statement (HDFC/ICICI/SBI/Axis/Kotak/etc.). " +
  "Extract EVERY transaction line printed — one JSON row per printed line. Never summarise, merge, sample or skip lines, " +
  "and do not stop early: a page often has 25–40 lines, many of them alike (several UPI lines on one day are separate lines). " +
  "Return ONLY JSON:\n" +
  "{ \"pages\": [ { \"page\": number, \"rowCount\": number } ], " +
  "\"rows\": [ { \"date\": string, \"description\": string, \"debit\": number, \"credit\": number, \"balance\": number|null } ] }\n" +
  "pages: one entry per page you read (page 1 = the first page of the file); rowCount = how many transaction lines are printed on that page, counted from the page itself. " +
  "rows must hold exactly that many lines for each page. " +
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
/* Decides the lighter-model retry only. The MESSAGE comes from classifyStatementFailure,
   which keeps "slow" (a statement too big) and "busy" (Google's 503) apart — R-1690. */
const isBusyOrSlow = (reason: string) =>
  /\b503\b|high demand|unavailable|overload|jawab nahi diya|timed out|paused/i.test(reason);

async function extractWithFallback(
  apiKey: string, model: string, mimeType: string, base64: string, prompt: string,
): Promise<{ answer: AiAnswer | null; reason: string }> {
  let reason = "";
  const first = await extractWithGemini(apiKey, model, mimeType, base64, prompt, (r) => { reason = r; });
  if (first) return { answer: first, reason: "" };
  if (model !== FALLBACK_MODEL && isBusyOrSlow(reason)) {
    console.warn(`[ai/extract-statement] ${model} failed (${reason}) — trying ${FALLBACK_MODEL}`);
    const second = await extractWithGemini(apiKey, FALLBACK_MODEL, mimeType, base64, prompt, (r) => { reason = r; });
    if (second) return { answer: second, reason: "" };
  }
  return { answer: null, reason };
}

type AiAnswer = { rows: AiRow[]; pages: unknown };

/**
 * R-1693: the model's own count of transaction lines on the pages it was asked for — null
 * when it gave none for any of them (then no count check is claimed). A page outside the
 * range, or a count that is not a whole number ≥ 0, is ignored.
 */
function countedRows(pagesJson: unknown, range: { from: number; to: number } | null): number | null {
  if (!Array.isArray(pagesJson)) return null;
  let total = 0, seen = 0;
  for (const p of pagesJson as Array<{ page?: unknown; rowCount?: unknown }>) {
    const page = Number(p?.page), n = Number(p?.rowCount);
    if (!Number.isInteger(n) || n < 0) continue;
    if (range && (!Number.isInteger(page) || page < range.from || page > range.to)) continue;
    total += n;
    seen++;
  }
  return seen > 0 ? total : null;
}

async function extractWithGemini(
  apiKey: string, model: string, mimeType: string, base64: string, prompt: string, onFailure?: (reason: string) => void,
): Promise<AiAnswer | null> {
  /* Pehle yahan apna `fetch` tha — aur iske paas timeout bhi nahi tha. Ye bank statement
     padhta hai, yaani seedha paise ka data, aur ek atki hui call operator ko spinner par
     baithaye rakhti.

     Prompt `user` part me hi rehta hai (systemInstruction nahi) — statement padhne ka
     prompt column-order aur date-format ke bahut se niyam rakhta hai, aur use doosri jagah
     sarkane se nateeja badal sakta tha. Isliye geminiJson ka `system` optional hai.

     Timeout 60s: pehle KOI nahi tha, phir 30s — par 25 Sep 2026 ko ek poore mahine ki
     statement 30s me do baar time out hui. PDF ka jawab text se dheema aata hai, aur
     operator ke saamne progress spinner chalta rehta hai.

     19 Oct 2026 (R-1690): 60s bhi ek poore mahine ke liye kam pada (staging, dono model).
     Timeout aur badhane ki jagah ab lamba PDF pages ke hisson me padha jata hai — har hissa
     60s me aaram se aata hai. */
  const json = await geminiJson<{ rows?: AiRow[]; pages?: unknown }>({
    apiKey, model,
    user: prompt,
    attachment: { mimeType, base64 },
    temperature: 0,
    timeoutMs: 60_000,
    label: "ai/extract-statement",
    onFailure,
  });
  if (!json) return null;
  return { rows: Array.isArray(json.rows) ? json.rows : [], pages: json.pages };
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

  /* Pages only mean something for a PDF; a photo is always read whole. */
  const pages = /pdf/i.test(parsed.mimeType) ? parsed.pages : undefined;
  const prompt = pages ? PROMPT + pagesPrompt(pages) : PROMPT;

  const { answer, reason } = await extractWithFallback(gemini.apiKey, gemini.model, parsed.mimeType, parsed.fileBase64, prompt);
  if (!answer) {
    /* Say WHICH failure it was — each has a different next step. Until 19 Oct 2026 a
       timeout read "Google's AI is busy or slow", so people waited a minute and retried a
       statement that could never fit in one call. A timeout now says the statement is big. */
    const kind = classifyStatementFailure(reason);
    const csv = `The CSV / "Delimited" download from net banking always works and needs no AI.`;
    const error =
      kind === "timeout"
        ? "The statement is too big — the AI took too long. Try a PDF with a shorter date range, or upload the CSV/Excel from net banking (that needs no AI)."
        : kind === "busy"
          ? `Google's AI is busy right now (overloaded). Try again in a minute. ${csv}`
          : kind === "paused"
            ? `Several AI calls failed in a row just now, so calls are paused for a minute — try again in a minute. ${csv}`
            : kind === "unreadable"
              ? `The AI couldn't open this file (a password-protected or damaged PDF does this). ${csv}`
              : `${reason ? `The AI reader failed — ${reason.replace(/\.$/, "")}` : "The AI reader failed"}. ${csv}`;
    const status = kind === "timeout" ? 504 : kind === "busy" ? 503 : 502;
    return NextResponse.json({ error, kind }, { status });
  }

  const clean = sanitizeRows(answer.rows);
  /* R-1693: the model's own line count for the pages asked, and how many rows it wrote out —
     the browser treats "wrote fewer than it counted" like a break in the balance chain. */
  const rowCount = countedRows(answer.pages, pages ?? null);
  const rowsReturned = answer.rows.length;
  if (pages) {
    /* One chunk: dates as read. The dialog merges every chunk and fixes dates once. */
    return NextResponse.json({ rows: clean.rows, skipped: clean.skipped, mode: "gemini", chunk: pages, rowCount, rowsReturned });
  }
  /* Real calendar dates only (the reader has returned "2026-21-08" for 21 Aug). Swaps are
     decided for the whole statement; a date impossible either way is dropped and counted. */
  const fix = fixStatementDates(clean.rows.map((r) => r.txn_date), localDateISO(new Date(Date.now() + 86_400_000)));   // +1 day: server clock may be UTC
  const rows = clean.rows.flatMap((r, i) => (fix.dates[i] ? [{ ...r, txn_date: fix.dates[i]! }] : []));
  const skipped = clean.skipped + (clean.rows.length - rows.length);
  return NextResponse.json({ rows, skipped, mode: "gemini", datesSwapped: fix.swapped, datesSwappedAll: fix.swappedAll, rowCount, rowsReturned });
}
