/**
 * R-1876 (epic R-1874, campaign co-pilot phase A) — the AI ad-copy writer's rules.
 *
 * "AI thinks and drafts, code validates" (lib/ai/money-guard.ts). The AI is ASKED to write
 * inside each channel's limits (channel-specs.ts, R-1875); this file is what makes sure:
 *
 *   1. copySlots      — which fields each chosen platform needs for the objective, how many.
 *   2. buildCopyPrompt — the brief: brand, product, objective, brand voice, language, limits.
 *   3. collectCandidates — the AI's JSON → clean lines per field (trim, de-quote, de-duplicate,
 *                       at most the count the platform takes).
 *   4. needsShortening / applyShortened — lines over a limit go back to the AI ONCE to shorten.
 *   5. finalizeCopy   — the server-side check every line passes before a person sees it:
 *                       over a HARD maximum (Google) → dropped with the reason, never shown as
 *                       valid; over a RECOMMENDED length (Meta publishes no maximum) → kept but
 *                       ok = false, so the screen words it as Meta's recommendation; a ₹ figure
 *                       the person did not type in the brief → dropped (money guard).
 *   6. stubCopy       — plain template copy when the server has no AI key (like ai-generate).
 *
 * Pure — no DB, no AI. The route (app/api/marketing/copilot/copy) does the I/O.
 */
import { verifyDraftMoney } from "@/lib/ai/money-guard";
import {
  CHANNEL_SPECS, fitCheck, objectiveFor,
  type AdPlatform, type CopilotObjective, type CopyField,
} from "./channel-specs";

export type CopyLanguage = "en" | "hinglish" | "hi";
export const COPY_LANGUAGES: readonly CopyLanguage[] = ["en", "hinglish", "hi"];

/** Who may ask the AI for ad copy — the same roles the co-pilot tables allow (R-1878 RLS). */
export const COPILOT_COPY_ROLES = ["owner", "manager", "marketing"] as const;
export function mayWriteCopy(role: string | null | undefined): boolean {
  return !!role && (COPILOT_COPY_ROLES as readonly string[]).includes(role);
}

/** The brand voice used when neither the plan nor the request gives one. */
export const DEFAULT_TONE = "clear, friendly and professional";

export interface CopyBrief {
  brand: string;
  product: string | null;
  objective: CopilotObjective;
  platforms: AdPlatform[];
  /** Brand voice: the request's, else the plan's (ad_plans.tone), else DEFAULT_TONE. */
  tone: string | null;
  language: CopyLanguage;
  /** What the person typed about the offer / audience. */
  brief: string;
}

export interface CopySlot {
  platform: AdPlatform;
  format: string;
  formatLabel: string;
  field: CopyField;
  /** How many lines to ask for — the most the platform takes. */
  want: number;
  /** Filled from the brand name, not written by the AI (Performance Max business name). */
  fromBrand?: boolean;
}

export const slotKey = (platform: string, format: string, field: string) => `${platform}.${format}.${field}`;
const keyOf = (s: CopySlot) => slotKey(s.platform, s.format, s.field.key);

const OBJECTIVE_WORDS: Record<CopilotObjective, string> = {
  awareness: "awareness (get the brand known)",
  traffic: "traffic (clicks to the website)",
  engagement: "engagement (likes, comments, shares)",
  lead_gen: "lead generation (enquiries, calls, forms)",
  sales: "sales (purchases)",
};

export function copySlots(platforms: readonly AdPlatform[], objective: CopilotObjective): {
  slots: CopySlot[];
  skipped: { platform: AdPlatform; reason: string }[];
} {
  const slots: CopySlot[] = [];
  const skipped: { platform: AdPlatform; reason: string }[] = [];
  for (const platform of platforms) {
    const spec = CHANNEL_SPECS[platform];
    const po = objectiveFor(platform, objective);
    const format = po ? spec.formats.find((f) => f.key === po.format) : undefined;
    if (!format) {
      skipped.push({ platform, reason: `${spec.label} has no ad format for ${objective.replace("_", " ")} here yet — pick another objective for it.` });
      continue;
    }
    for (const field of format.fields) {
      slots.push({
        platform, format: format.key, formatLabel: format.label, field, want: field.maxCount,
        ...(field.key === "business_name" ? { fromBrand: true } : {}),
      });
    }
  }
  return { slots, skipped };
}

const LANGUAGE_WORDS: Record<CopyLanguage, string> = {
  en: "English",
  hinglish: "Hinglish (Hindi words in Roman script mixed with English, as Indians type on WhatsApp)",
  hi: "Hindi (Devanagari script)",
};

const SYSTEM = `You write paid-ad copy (Google Ads, Meta) for Indian businesses.
Output ONLY a JSON object, no markdown fences. Shape: {"<platform>": {"<format>": {"<field>": ["line", ...]}}} using exactly the platform, format and field keys you are given.
Rules:
- Every line must fit its character limit. Count every character, including spaces. Shorter is better than cut off.
- Lines of one field must all be different from each other (Google rejects duplicate headlines).
- Never invent a price, discount, percentage, date or guarantee. Use a number only if it is in the brief.
- No ALL CAPS words, no "!!", no emoji in Google lines (Google disapproves them).
- Write in the requested language and brand voice.`;

export function buildCopyPrompt(b: CopyBrief, slots: readonly CopySlot[]): { system: string; user: string } {
  const asks = slots.filter((s) => !s.fromBrand).map((s) => {
    const n = `${s.want} line${s.want === 1 ? "" : "s"}`;
    const limit = s.field.max != null
      ? `each at most ${s.field.max} characters`
      : s.field.recommended != null ? `ideally at most ${s.field.recommended} characters` : "any length";
    return `- ${keyOf(s)}: ${n}, ${limit} (${s.field.label}, ${s.formatLabel})`;
  });
  const user = [
    `Brand: ${b.brand}`,
    `Product / service: ${b.product?.trim() || "(the brand's main offer)"}`,
    `Objective: ${OBJECTIVE_WORDS[b.objective]}`,
    `Brand voice: ${b.tone?.trim() || DEFAULT_TONE}`,
    `Language: ${LANGUAGE_WORDS[b.language]}`,
    `Brief from the business: ${b.brief.trim() || "(none)"}`,
    "",
    "Write these fields:",
    ...asks,
  ].join("\n");
  return { system: SYSTEM, user };
}

export const SHORTEN_SYSTEM = `You shorten ad lines. Output ONLY JSON: {"items":[{"id":"<same id>","text":"<shorter line>"}]}.
Each new text must be at most "limit" characters, keep the meaning and language, and never add a number that was not in the line.`;

export function buildShortenPrompt(items: readonly ShortenItem[]): string {
  return JSON.stringify({ items });
}

export interface ShortenItem { id: string; text: string; limit: number }

/** One line as the AI wrote it → plain text: trimmed, inner spaces collapsed, wrapping quotes removed. */
function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.replace(/\s+/g, " ").trim();
  const q = /^["'“”‘’](.*)["'“”‘’]$/.exec(s);
  if (q) s = q[1].trim();
  return s || null;
}

const sameKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type Candidates = Map<string, string[]>;

/** The AI's JSON → clean, de-duplicated lines per field (at most `want`). Anything malformed is ignored. */
export function collectCandidates(raw: unknown, slots: readonly CopySlot[], b: Pick<CopyBrief, "brand">): Candidates {
  const out: Candidates = new Map();
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const s of slots) {
    let values: unknown[] = [];
    if (s.fromBrand) values = [b.brand];
    else {
      const p = root[s.platform];
      const f = p && typeof p === "object" ? (p as Record<string, unknown>)[s.format] : undefined;
      const v = f && typeof f === "object" ? (f as Record<string, unknown>)[s.field.key] : undefined;
      values = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    }
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const v of values) {
      const c = clean(v);
      if (!c || seen.has(sameKey(c))) continue;
      seen.add(sameKey(c));
      lines.push(c);
      if (lines.length >= s.want) break;
    }
    out.set(keyOf(s), lines);
  }
  return out;
}

/** Lines over their limit (hard max, or Meta's recommendation) — sent back to the AI once to shorten. */
export function needsShortening(c: Candidates, slots: readonly CopySlot[]): ShortenItem[] {
  const items: ShortenItem[] = [];
  for (const s of slots) {
    if (s.fromBrand) continue; // a business name must match the real name — never reworded
    (c.get(keyOf(s)) ?? []).forEach((text, i) => {
      const fit = fitCheck(text, s.field);
      if (!fit.ok && fit.limit != null) items.push({ id: `${keyOf(s)}#${i}`, text, limit: fit.limit });
    });
  }
  return items;
}

/** Put the AI's shortened lines back in place. Unknown ids and non-text answers are ignored. */
export function applyShortened(c: Candidates, answers: unknown): Candidates {
  const out: Candidates = new Map([...c].map(([k, v]) => [k, [...v]]));
  const list = Array.isArray(answers) ? answers : [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const { id, text } = a as { id?: unknown; text?: unknown };
    if (typeof id !== "string") continue;
    const m = /^(.+)#(\d+)$/.exec(id);
    const t = clean(text);
    if (!m || !t) continue;
    const lines = out.get(m[1]);
    const i = Number(m[2]);
    if (lines && i < lines.length) lines[i] = t;
  }
  return out;
}

export interface CopyLine {
  text: string;
  length: number;
  limit: number | null;
  /** "max" = the platform's hard limit; "recommended" = Meta's advice (no maximum published). */
  kind: "max" | "recommended" | "none";
  /** Inside the limit. A hard-max line that is not ok is never returned — it is in `dropped`. */
  ok: boolean;
}

export interface FieldResult {
  platform: AdPlatform;
  format: string;
  formatLabel: string;
  field: string;
  label: string;
  max: number | null;
  recommended: number | null;
  minCount: number;
  maxCount: number;
  lines: CopyLine[];
  dropped: { text: string; reason: string }[];
  /** Fewer usable lines than the platform needs (e.g. under 3 Google headlines). */
  short: boolean;
}

/**
 * The check every line passes before it is shown. `allowedMoney` = the rupee figures the person
 * typed in the brief (verifyDraftMoney(brief).found) — any other ₹ figure is dropped.
 */
export function finalizeCopy(c: Candidates, slots: readonly CopySlot[], allowedMoney: readonly number[]): FieldResult[] {
  return slots.map((s) => {
    const lines: CopyLine[] = [];
    const dropped: { text: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const text of c.get(keyOf(s)) ?? []) {
      if (seen.has(sameKey(text))) { dropped.push({ text, reason: "Same as another line" }); continue; }
      const fit = fitCheck(text, s.field);
      if (fit.kind === "max" && !fit.ok) { dropped.push({ text, reason: `Longer than ${fit.limit} characters` }); continue; }
      if (!s.fromBrand) {
        const money = verifyDraftMoney(text, allowedMoney);
        if (!money.ok) { dropped.push({ text, reason: `Mentions a price you did not give (${money.violations.join(", ")})` }); continue; }
      }
      seen.add(sameKey(text));
      lines.push({ text: text.trim(), length: fit.length, limit: fit.limit, kind: fit.kind, ok: fit.ok });
    }
    return {
      platform: s.platform, format: s.format, formatLabel: s.formatLabel, field: s.field.key, label: s.field.label,
      max: s.field.max, recommended: s.field.recommended, minCount: s.field.minCount, maxCount: s.field.maxCount,
      lines, dropped, short: lines.length < s.field.minCount,
    };
  });
}

/** Cut at a word boundary to fit `limit` characters (whole words only; never mid-word unless one word is longer). */
export function clipWords(text: string, limit: number): string {
  const chars = [...text.trim()];
  if (chars.length <= limit) return text.trim();
  const cut = chars.slice(0, limit + 1).join("");
  const sp = cut.lastIndexOf(" ");
  const out = (sp > 0 ? cut.slice(0, sp) : chars.slice(0, limit).join("")).replace(/[\s,.;:–-]+$/, "");
  return out;
}

const STUB_HEADLINES = [
  "{product}", "{brand}", "{product} by {brand}", "Get {product} today", "{product} for your team",
  "Trusted {product} partner", "Talk to {brand}", "Set up in days, not weeks", "Local support from {brand}",
  "Plans for every business", "Ask us for a quote", "Easy setup and migration", "{brand} — here to help",
  "Made for Indian businesses", "Start with {brand}",
  // spares: a long product name clips several lines above to the same text
  "Expert help at every step", "Switch without the downtime", "Simple, secure, supported",
  "Clear pricing, no surprises", "Get a free consultation", "Your team, set up right",
];
const STUB_DESCRIPTIONS = [
  "{product} from {brand}. Setup, migration and support by our own team.",
  "Tell us your team size — {brand} suggests the right plan for {product}.",
  "Local help in your time zone. Talk to {brand} about {product} today.",
  "Simple onboarding, clear billing and a team that answers when you call.",
  "Move to {product} without the downtime. {brand} plans every step with you.",
];
const STUB_PATHS = ["{productWord}", "offer"];
const STUB_LONG = [
  "{product} for your business — set up and supported by {brand}",
  "Talk to {brand} about {product} for your team",
  "Get {product} with setup, migration and local support",
  "Plans for every business size — ask {brand} for a quote",
  "{brand}: the easy way to get {product}",
];

/** Template copy for when the server has no AI key. Every line is clipped to its limit. */
export function stubCopy(b: CopyBrief, slots: readonly CopySlot[]): Record<string, Record<string, Record<string, string[]>>> {
  const product = b.product?.trim() || b.brand;
  const fill = (t: string) => t
    .replaceAll("{product}", product)
    .replaceAll("{brand}", b.brand)
    .replaceAll("{productWord}", (product.split(/\s+/)[0] || "plans").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15) || "plans");
  const out: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const s of slots) {
    if (s.fromBrand) continue;
    const limit = s.field.max ?? s.field.recommended ?? 90;
    const pool = s.field.key === "headline" && s.platform === "google-ads" ? STUB_HEADLINES
      : s.field.key === "headline" ? [`{product}`, `{brand}`]
      : s.field.key === "long_headline" ? STUB_LONG
      : s.field.key === "path" ? STUB_PATHS
      : s.field.key === "primary_text" ? [
          `${b.brief.trim() ? b.brief.trim().replace(/[.!]*$/, ".") + " " : ""}{product} from {brand} — setup and support by our own team. Message us to get started.`,
        ]
      : STUB_DESCRIPTIONS;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const t of pool) {
      const line = clipWords(fill(t), limit);
      if (!line || seen.has(sameKey(line))) continue;
      seen.add(sameKey(line));
      lines.push(line);
      if (lines.length >= s.want) break;
    }
    ((out[s.platform] ??= {})[s.format] ??= {})[s.field.key] = lines;
  }
  return out;
}
