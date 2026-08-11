/**
 * POST /api/ai/generate-assessment
 *
 * Generates reasoning MCQs with Gemini for an employee test. Auth required
 * (owner/manager). If no Gemini key is configured, returns a small built-in
 * sample set so the feature still works (stub mode).
 *
 * Body: { topic?: string, difficulty?: "easy"|"medium"|"hard", count?: number }
 * Returns: { questions: [{ q, options[], correct }], mode }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import type { AssessmentQuestion } from "@/lib/assessments/grade";

const bodySchema = z.object({
  topic: z.string().max(120).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  count: z.number().int().min(3).max(25).optional(),
  language: z.enum(["en", "hi", "both"]).optional(),
  // "reasoning" = general IQ/aptitude. "software" = tests understanding of THIS
  // app (ResellerOS), grounded in the brief below so answers stay accurate.
  subject: z.enum(["reasoning", "software"]).optional(),
});

// Factual brief about ResellerOS — the ONLY source Gemini may use for the
// "software" test, so questions/answers stay true to the real app. Keep in sync
// with the actual navigation + money-flow as the product evolves.
const APP_BRIEF = `
ResellerOS is a business-management web app used by an Indian company to run sales, billing, accounting, purchases, compliance and HR/payroll in one place.

MONEY FLOW (the core order): Lead → Quote → Payment → Subscription → Invoice → Renewal. A prospect starts as a Lead; you send a Quote; when they pay you record a Payment (this turns the lead into a Customer); recurring plans become Subscriptions that are Invoiced and later come up for Renewal.

LEFT MENU / where things live:
- Sales: Leads (add & track prospects), Deals/Kanban pipeline, Tasks/follow-ups.
- Quick money + Revenue: Quotes, Payments, Invoices, Customers, Subscriptions, Renewals (subscriptions coming up for renewal).
- Customers vs Contacts: a Customer is the company/account that pays you; a Contact is a person (a customer can have many contacts). Employees are also shown as contacts.
- Purchases: Purchase Orders, vendor Bills (COGS), Purchase Inbox (Amazon emails auto-captured into expenses).
- Accounting: Expenses (record a spend, attach the bill, choose which bank/cash account paid), Banking (bank accounts + transactions + reconcile), Prepaid/Advances (money paid in advance e.g. a Facebook ad advance — later "consumed" into an expense), GST Reports, P&L (Profit & Loss), Balance Sheet.
- Compliance: statutory due-date tracker for a Private Limited company (GST returns like GSTR-1/GSTR-3B, TDS returns, ROC, income tax) with "how to file" guides.
- Payroll: Employees, Team Performance, Reasoning Tests (this test feature), Payroll, Salary/ESI/Leave/Attendance registers, Attendance Kiosk, Loans & Advances.
- Engage: WhatsApp, campaigns, coupons/promos.
- Catalog: the products/plans you sell (e.g. Google Workspace, Microsoft 365, Zoho) with per-seat pricing.

KEY FACTS:
- GST on SaaS/software services is 18% (CGST 9% + SGST 9% within the same state; IGST 18% across states).
- Money is shown in Indian format (₹, lakh/crore).
- To bill a customer you create an Invoice; to collect you record a Payment.
- Receivables = money customers still owe you; it shows on the customer and in reports.
- An expense can be paid from a specific bank account or petty cash, and a bill can be attached (AI can read the bill and auto-fill the form).
- Renewals section shows subscriptions that are due to renew so you don't lose the customer.
`.trim();

const SAMPLE: AssessmentQuestion[] = [
  { q: "If all Bloops are Razzies and all Razzies are Lazzies, then all Bloops are definitely Lazzies.", options: ["True", "False", "Cannot say", "None"], correct: 0,
    q_hi: "Agar saare Bloops, Razzies hain aur saare Razzies, Lazzies hain — to saare Bloops zaroor Lazzies honge.", options_hi: ["Sahi", "Galat", "Keh nahi sakte", "Koi nahi"] },
  { q: "Find the next number: 2, 6, 12, 20, 30, ?", options: ["36", "40", "42", "44"], correct: 2,
    q_hi: "Agla number batao: 2, 6, 12, 20, 30, ?", options_hi: ["36", "40", "42", "44"] },
  { q: "Pointing to a photo, Ravi said, 'She is the daughter of my grandfather's only son.' Who is she to Ravi?", options: ["Sister", "Mother", "Aunt", "Cousin"], correct: 0,
    q_hi: "Ek photo dikhate hue Ravi ne kaha, 'Wo mere dada ke iklaute bete ki beti hai.' Wo Ravi ki kya lagti hai?", options_hi: ["Behen", "Maa", "Bua", "Cousin"] },
  { q: "Which one does NOT belong: Rose, Lotus, Lily, Mango?", options: ["Rose", "Lotus", "Lily", "Mango"], correct: 3,
    q_hi: "Inme se kaun alag hai: Gulab, Kamal, Lily, Aam?", options_hi: ["Gulab", "Kamal", "Lily", "Aam"] },
  { q: "A is taller than B, B is taller than C. Who is the shortest?", options: ["A", "B", "C", "Cannot say"], correct: 2,
    q_hi: "A, B se lamba hai; B, C se lamba hai. Sabse chhota kaun hai?", options_hi: ["A", "B", "C", "Keh nahi sakte"] },
];

/** Shared JSON-format + language rules appended to every prompt. */
function langInstruction(language: string): string {
  if (language === "both") {
    return `Every question must be BILINGUAL: give both an English version AND a natural Hinglish version ` +
      `(Hindi written in Roman/English script, the way Indians casually type — NOT pure Hindi Devanagari, NOT formal). ` +
      `The Hinglish options must line up 1:1 with the English options in the same order (same correct index).\n` +
      `[{ "q": "english question", "options": ["a","b","c","d"], "correct": 0, "q_hi": "hinglish question", "options_hi": ["a","b","c","d"] }]`;
  }
  if (language === "hi") {
    return `Write every question and option in natural Hinglish (Hindi in Roman/English script, the way Indians casually type — NOT Devanagari, NOT formal).\n` +
      `[{ "q": "hinglish question", "options": ["a","b","c","d"], "correct": 0 }]`;
  }
  return `[{ "q": "question text", "options": ["a","b","c","d"], "correct": 0 }]`;
}

function buildPrompt(topic: string, difficulty: string, count: number, language: string): string {
  const focus = topic
    ? `Focus area: ${topic}. `
    : "Mix logical reasoning, number series, verbal reasoning and basic aptitude. ";
  const base =
    `Generate ${count} multiple-choice REASONING/aptitude questions for an employee test. ` +
    `Difficulty: ${difficulty}. ${focus}` +
    `Each question has exactly 4 options and one correct answer. "correct" is the 0-based index of the right option. ` +
    `Keep questions self-contained and unambiguous. Return ONLY a JSON array, no prose.\n`;
  return base + langInstruction(language);
}

function buildSoftwarePrompt(topic: string, difficulty: string, count: number, language: string): string {
  const focus = topic ? `Give extra weight to this area: ${topic}. ` : "";
  const base =
    `You are writing an internal training quiz to check how well an EMPLOYEE understands the ResellerOS software described below. ` +
    `Use ONLY the facts in the brief — do NOT invent features, menus, or rules that are not stated. If unsure, ask about the money flow, where features live in the menu, or the GST rule. ` +
    `Generate ${count} practical multiple-choice questions about USING this app (where to do X, what happens when Y, correct order of steps). ` +
    `Difficulty: ${difficulty}. ${focus}` +
    `Each question has exactly 4 options and one correct answer. "correct" is the 0-based index of the right option. ` +
    `Keep questions self-contained and unambiguous. Return ONLY a JSON array, no prose.\n\n` +
    `--- SOFTWARE BRIEF ---\n${APP_BRIEF}\n--- END BRIEF ---\n\n`;
  return base + langInstruction(language);
}

const SOFTWARE_SAMPLE: AssessmentQuestion[] = [
  { q: "In ResellerOS, what is the correct money flow order?", options: ["Invoice → Lead → Payment → Quote", "Lead → Quote → Payment → Subscription → Invoice → Renewal", "Payment → Renewal → Lead", "Quote → Renewal → Lead → Payment"], correct: 1,
    q_hi: "ResellerOS me paise ka sahi flow order kya hai?", options_hi: ["Invoice → Lead → Payment → Quote", "Lead → Quote → Payment → Subscription → Invoice → Renewal", "Payment → Renewal → Lead", "Quote → Renewal → Lead → Payment"] },
  { q: "Where do you add a new prospect (lead)?", options: ["Settings", "Sales → Leads", "Accounting → P&L", "Compliance"], correct: 1,
    q_hi: "Naya prospect (lead) kaha add karte hain?", options_hi: ["Settings", "Sales → Leads", "Accounting → P&L", "Compliance"] },
  { q: "What is the GST rate on software/SaaS services?", options: ["5%", "12%", "18%", "28%"], correct: 2,
    q_hi: "Software/SaaS services par GST kitna lagta hai?", options_hi: ["5%", "12%", "18%", "28%"] },
  { q: "You paid Facebook in advance for ads. Where is that handled?", options: ["Accounting → Prepaid/Advances", "Quotes", "Renewals", "Catalog"], correct: 0,
    q_hi: "Aapne Facebook ko ads ke liye advance pay kiya. Ye kaha handle hota hai?", options_hi: ["Accounting → Prepaid/Advances", "Quotes", "Renewals", "Catalog"] },
  { q: "What is the difference between a Customer and a Contact?", options: ["They are the same", "Customer = the company/account that pays; Contact = a person", "Contact pays, Customer is a person", "Customer is a vendor"], correct: 1,
    q_hi: "Customer aur Contact me kya fark hai?", options_hi: ["Dono same hain", "Customer = jo company/account paisa deta hai; Contact = ek vyakti", "Contact paisa deta hai, Customer vyakti hai", "Customer ek vendor hota hai"] },
];

async function genWithGemini(apiKey: string, model: string, prompt: string): Promise<AssessmentQuestion[] | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const arr = JSON.parse(cleaned) as AssessmentQuestion[];
    if (!Array.isArray(arr)) return null;
    // Sanitise: keep only well-formed MCQs with a valid correct index.
    return arr
      .filter((x) => x && typeof x.q === "string" && Array.isArray(x.options) && x.options.length >= 2)
      .map((x) => {
        const options = x.options.slice(0, 5).map((o) => String(o));
        const out: AssessmentQuestion = {
          q: String(x.q),
          options,
          correct: Math.max(0, Math.min(options.length - 1, Number(x.correct) || 0)),
        };
        // Carry the Hinglish version through only when it lines up with the options.
        if (typeof x.q_hi === "string" && Array.isArray(x.options_hi) && x.options_hi.length === options.length) {
          out.q_hi = String(x.q_hi);
          out.options_hi = x.options_hi.map((o) => String(o));
        }
        return out;
      });
  } catch (err) {
    console.error("[ai/generate-assessment] Gemini crashed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body;
  try { body = bodySchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }

  const count = body.count ?? 8;
  const difficulty = body.difficulty ?? "medium";
  const topic = body.topic?.trim() ?? "";
  const language = body.language ?? "en";
  const subject = body.subject ?? "reasoning";

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);

  const prompt = subject === "software"
    ? buildSoftwarePrompt(topic, difficulty, count, language)
    : buildPrompt(topic, difficulty, count, language);

  if (gemini.apiKey) {
    const q = await genWithGemini(gemini.apiKey, gemini.model, prompt);
    if (q && q.length > 0) return NextResponse.json({ questions: q.slice(0, count), mode: "gemini" });
  }
  // Stub fallback — sample set so the test still works without a key. For
  // English-only, drop the Hinglish fields so the preview stays clean.
  const pool = subject === "software" ? SOFTWARE_SAMPLE : SAMPLE;
  const sample = pool.slice(0, Math.min(count, pool.length)).map((s) =>
    language === "en" ? { q: s.q, options: s.options, correct: s.correct }
    : language === "hi" ? { q: s.q_hi ?? s.q, options: s.options_hi ?? s.options, correct: s.correct }
    : s,
  );
  return NextResponse.json({ questions: sample, mode: "stub" });
}
