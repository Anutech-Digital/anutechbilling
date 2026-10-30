/**
 * R-1879 (epic R-1874, campaign co-pilot phase A) — the wizard's rules for step 1 (product +
 * objective) and step 2 (platforms + audience), and what one prompt fills in.
 *
 *   • INDIA_REGIONS   — the region picker = the GST state list (lib/utils.ts), one list.
 *   • OBJECTIVE_GROUPS — the two-level objective choice (goal → objective).
 *   • platformInfo / lookalikeInfo — what a platform can do for an objective, and WHY not
 *                       when it cannot (channel-specs.ts is the one place that knows).
 *   • guessFromPrompt — no AI (or the AI failed): plain word matching fills the form.
 *   • buildPrefillPrompt / mergeAiPrefill — the AI fills it; every field it returns is checked
 *                       against the real lists, and a bad field falls back to the guess.
 *   • normalizePlan / planDraftSchema — what may be saved into ad_plans.
 *   • targetGroupRows / audienceFromGroups — the audience ↔ ad_target_groups rows.
 *
 * Pure — no DB, no AI. The routes (app/api/marketing/copilot/draft, /plans) do the I/O.
 */
import { z } from "zod";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import {
  CHANNEL_SPECS, COPILOT_OBJECTIVES, PLATFORMS, objectiveFor,
  type AdPlatform, type CopilotObjective,
} from "./channel-specs";
import { COPY_LANGUAGES, type CopyLanguage } from "./copy-prompt";

/* ── Lists ─────────────────────────────────────────────────────────────────── */

/** GST codes that are not a place a person lives in. */
const NOT_A_REGION = new Set(["97", "99"]);
export const INDIA_REGIONS: readonly string[] = Object.entries(GST_STATE_BY_CODE)
  .filter(([code]) => !NOT_A_REGION.has(code))
  .map(([, name]) => name)
  .sort((a, b) => a.localeCompare(b));

export const OBJECTIVE_INFO: Record<CopilotObjective, { label: string; hint: string }> = {
  awareness:  { label: "Brand awareness", hint: "Show the ad to as many people as possible" },
  traffic:    { label: "Website visits", hint: "Clicks to your website or landing page" },
  engagement: { label: "Engagement", hint: "Likes, comments, shares and follows" },
  lead_gen:   { label: "Enquiries (leads)", hint: "Calls, forms and messages from interested buyers" },
  sales:      { label: "Sales", hint: "People buy online" },
};

export interface ObjectiveGroup { key: string; label: string; hint: string; objectives: readonly CopilotObjective[] }
export const OBJECTIVE_GROUPS: readonly ObjectiveGroup[] = [
  { key: "awareness", label: "Get known", hint: "New people hear about you", objectives: ["awareness"] },
  { key: "consideration", label: "Get interest", hint: "People look closer", objectives: ["traffic", "engagement"] },
  { key: "conversion", label: "Get business", hint: "Enquiries and sales", objectives: ["lead_gen", "sales"] },
];

export function groupOf(objective: CopilotObjective): ObjectiveGroup {
  return OBJECTIVE_GROUPS.find((g) => g.objectives.includes(objective)) ?? OBJECTIVE_GROUPS[2];
}

export const AGE_FLOOR = 13;
export const AGE_CEIL = 65;
const DEFAULT_AGE = { min: 18, max: 65 } as const;
export type Gender = "male" | "female";
export const GENDERS: readonly Gender[] = ["male", "female"];

/* ── What each platform can do ─────────────────────────────────────────────── */

export function platformInfo(platform: AdPlatform, objective: CopilotObjective): { available: boolean; reason: string | null } {
  if (objectiveFor(platform, objective)) return { available: true, reason: null };
  return {
    available: false,
    reason: `${CHANNEL_SPECS[platform].label} is not available for ${OBJECTIVE_INFO[objective].label.toLowerCase()} yet — pick another objective to use it.`,
  };
}

export function availablePlatforms(objective: CopilotObjective): AdPlatform[] {
  return PLATFORMS.filter((p) => platformInfo(p, objective).available);
}

export function lookalikeInfo(platform: AdPlatform): { available: boolean; reason: string | null } {
  if (CHANNEL_SPECS[platform].lookalike) return { available: true, reason: null };
  return {
    available: false,
    reason: `${CHANNEL_SPECS[platform].label} closed "Similar audiences" in 2023, so there is no lookalike audience there.`,
  };
}

/* ── The plan ──────────────────────────────────────────────────────────────── */

export interface Audience {
  ageMin: number;
  ageMax: number;
  /** Empty = everyone. */
  genders: Gender[];
  /** Empty = all of India. */
  regions: string[];
  /** Also reach people like my customers (Meta only). */
  lookalike: boolean;
}

export interface PlanDraft {
  name: string;
  itemId: string | null;
  objective: CopilotObjective;
  platforms: AdPlatform[];
  prompt: string;
  language: CopyLanguage;
  audience: Audience;
}

const objectiveEnum = z.enum(COPILOT_OBJECTIVES as unknown as [CopilotObjective, ...CopilotObjective[]]);
const platformEnum = z.enum(PLATFORMS as unknown as [AdPlatform, ...AdPlatform[]]);
const age = z.number().int().min(AGE_FLOOR).max(AGE_CEIL);

export const planDraftSchema = z.object({
  name: z.string().trim().min(1, "Give the plan a name.").max(120),
  itemId: z.string().trim().min(1).max(100).nullable(),
  objective: objectiveEnum,
  platforms: z.array(platformEnum).max(PLATFORMS.length),
  prompt: z.string().max(4000),
  language: z.enum(COPY_LANGUAGES as unknown as [CopyLanguage, ...CopyLanguage[]]),
  audience: z.object({
    ageMin: age,
    ageMax: age,
    genders: z.array(z.enum(GENDERS as unknown as [Gender, ...Gender[]])).max(2),
    regions: z.array(z.string().refine((r) => INDIA_REGIONS.includes(r), "Pick a region from the list.")).max(INDIA_REGIONS.length),
    lookalike: z.boolean(),
  }),
});

const uniq = <T,>(xs: readonly T[]) => [...new Set(xs)];

/**
 * Make a plan safe to save: drop platforms the objective cannot run on (with a note), keep
 * lookalike only when Meta is in, put ages in order, de-duplicate. `error` = cannot be saved.
 */
export function normalizePlan(d: PlanDraft): { plan: PlanDraft; notes: string[]; error?: string } {
  const notes: string[] = [];
  const platforms = uniq(d.platforms).filter((p) => {
    const info = platformInfo(p, d.objective);
    if (!info.available && info.reason) notes.push(info.reason);
    return info.available;
  });
  const lookalike = d.audience.lookalike && platforms.some((p) => lookalikeInfo(p).available);
  const [ageMin, ageMax] = d.audience.ageMin <= d.audience.ageMax
    ? [d.audience.ageMin, d.audience.ageMax] : [d.audience.ageMax, d.audience.ageMin];
  const plan: PlanDraft = {
    ...d,
    name: d.name.trim(),
    platforms: PLATFORMS.filter((p) => platforms.includes(p)),
    audience: { ageMin, ageMax, genders: uniq(d.audience.genders), regions: uniq(d.audience.regions), lookalike },
  };
  if (!plan.platforms.length) return { plan, notes, error: "Pick at least one platform this objective can run on." };
  return { plan, notes };
}

/* ── Prompt → form, without AI ─────────────────────────────────────────────── */

const CITY_STATE: Record<string, string> = {
  "new delhi": "Delhi", ncr: "Delhi", noida: "Uttar Pradesh", lucknow: "Uttar Pradesh",
  gurgaon: "Haryana", gurugram: "Haryana", faridabad: "Haryana", mumbai: "Maharashtra",
  pune: "Maharashtra", nagpur: "Maharashtra", bangalore: "Karnataka", bengaluru: "Karnataka",
  chennai: "Tamil Nadu", coimbatore: "Tamil Nadu", hyderabad: "Telangana", kolkata: "West Bengal",
  ahmedabad: "Gujarat", surat: "Gujarat", jaipur: "Rajasthan", indore: "Madhya Pradesh",
  bhopal: "Madhya Pradesh", kochi: "Kerala", patna: "Bihar", ludhiana: "Punjab", bhubaneswar: "Odisha",
};

const OBJECTIVE_WORDS: [CopilotObjective, RegExp][] = [
  ["lead_gen", /\b(leads?|enquir\w*|inquir\w*|calls?|forms?|sign ?ups?|demos?|quotes?|bookings?)\b/i],
  ["sales", /\b(sell\w*|sales?|buy\w*|purchases?|orders?|shop\w*)\b/i],
  ["traffic", /\b(visits?|visitors?|traffic|website|clicks?)\b/i],
  ["engagement", /\b(engag\w*|likes?|comments?|shares?|followers?)\b/i],
  ["awareness", /\b(aware\w*|reach|launch\w*|brand)\b/i],
];
const GOOGLE_WORDS = /\b(google ads|google search|search ads?|adwords|youtube)\b/i;
const META_WORDS = /\b(meta|facebook|fb|instagram|insta|reels?)\b/i;
/** Words in a product name that say nothing about which product it is. */
const GENERIC_WORDS = new Set(["business", "basic", "starter", "standard", "plus", "plan", "pro", "edition", "the", "and", "for", "with", "license", "licence", "annual", "monthly", "yearly", "user"]);

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const has = (text: string, phrase: string) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

export interface ItemOption { id: string; name: string }

function guessItem(prompt: string, items: readonly ItemOption[]): string | null {
  const said = new Set(words(prompt));
  let best: { id: string; share: number; hits: number } | null = null;
  for (const it of items) {
    const core = uniq(words(it.name).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)));
    if (!core.length) continue;
    const hits = core.filter((w) => said.has(w)).length;
    const share = hits / core.length;
    if (hits === 0 || share < 0.5) continue;
    if (!best || share > best.share || (share === best.share && hits > best.hits)) best = { id: it.id, share, hits };
  }
  return best?.id ?? null;
}

function guessRegions(prompt: string): string[] {
  const found = new Set<string>();
  for (const r of INDIA_REGIONS) if (has(prompt, r)) found.add(r);
  for (const [city, state] of Object.entries(CITY_STATE)) if (has(prompt, city)) found.add(state);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function guessAges(prompt: string): { min: number; max: number } {
  const m = /\b(\d{2})\s*(?:-|–|to)\s*(\d{2})\b/.exec(prompt);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a >= AGE_FLOOR && b <= AGE_CEIL && a < b) return { min: a, max: b };
  }
  if (/\b(gen ?z|students?|college)\b/i.test(prompt)) return { min: 18, max: 27 };
  return { ...DEFAULT_AGE };
}

function guessGenders(prompt: string): Gender[] {
  const f = /\b(women|woman|female|ladies|girls|mothers|moms)\b/i.test(prompt);
  const m = /\b(men|man|male|gents|boys|fathers|dads)\b/i.test(prompt);
  return f === m ? [] : f ? ["female"] : ["male"];
}

function nameFrom(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  const first = flat.split(/[.!?\n]/)[0]?.trim() || flat;
  if (first.length <= 60) return first || "New campaign plan";
  const cut = first.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60).trim()}…`;
}

/**
 * R-2159: the objective the words name, or null when they name none. guessFromPrompt then
 * falls back to leads; the marketing agent (Xeno) asks the person instead.
 */
export function objectiveInPrompt(prompt: string): CopilotObjective | null {
  return OBJECTIVE_WORDS.find(([, re]) => re.test(prompt))?.[0] ?? null;
}

export function guessFromPrompt(prompt: string, items: readonly ItemOption[]): PlanDraft {
  const objective = objectiveInPrompt(prompt) ?? "lead_gen";
  const named = PLATFORMS.filter((p) => (p === "google-ads" ? GOOGLE_WORDS : META_WORDS).test(prompt));
  const allowed = availablePlatforms(objective);
  const picked = named.filter((p) => allowed.includes(p));
  const ages = guessAges(prompt);
  return {
    name: nameFrom(prompt),
    itemId: guessItem(prompt, items),
    objective,
    platforms: picked.length ? picked : allowed,
    prompt: prompt.trim().slice(0, 4000),
    language: "en",
    audience: { ageMin: ages.min, ageMax: ages.max, genders: guessGenders(prompt), regions: guessRegions(prompt), lookalike: false },
  };
}

/* ── Prompt → form, with AI ────────────────────────────────────────────────── */

const MAX_ITEMS_IN_PROMPT = 80;

export function buildPrefillPrompt(prompt: string, items: readonly ItemOption[]): { system: string; user: string } {
  const system = `You turn one sentence from an Indian business owner into an ad campaign plan form.
Output ONLY a JSON object, no markdown fences:
{"name": string (max 60 chars), "itemId": string|null, "objective": one of ${COPILOT_OBJECTIVES.join(" | ")},
 "platforms": array of ${PLATFORMS.join(" | ")}, "ageMin": 13-65, "ageMax": 13-65,
 "genders": [] for everyone or ["male"] / ["female"], "regions": [] for all of India or Indian state names}
Rules:
- itemId must be one of the given product ids, or null when none fits. Never invent an id.
- regions must be written exactly as in the given list. A city means its state.
- If the sentence does not say something, leave it at the wide default (all India, ages 18-65, everyone).`;
  const list = items.slice(0, MAX_ITEMS_IN_PROMPT).map((i) => `${i.id}: ${i.name}`).join("\n") || "(none)";
  const user = `Sentence: ${prompt}\n\nProducts (id: name):\n${list}\n\nRegions: ${INDIA_REGIONS.join(", ")}`;
  return { system, user };
}

const isAge = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= AGE_FLOOR && n <= AGE_CEIL;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The AI's answer, field by field: kept only when real, else the plain guess's value. */
export function mergeAiPrefill(raw: unknown, prompt: string, items: readonly ItemOption[]): PlanDraft {
  const g = guessFromPrompt(prompt, items);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return g;
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 120) : g.name;
  const itemId = typeof r.itemId === "string" && items.some((i) => i.id === r.itemId) ? r.itemId : g.itemId;
  const objective = (COPILOT_OBJECTIVES as readonly string[]).includes(r.objective as string) ? (r.objective as CopilotObjective) : g.objective;
  const allowed = availablePlatforms(objective);
  const aiPlatforms = strArr(r.platforms).filter((p): p is AdPlatform => allowed.includes(p as AdPlatform));
  const platforms = aiPlatforms.length ? PLATFORMS.filter((p) => aiPlatforms.includes(p))
    : g.platforms.filter((p) => allowed.includes(p)).length ? g.platforms.filter((p) => allowed.includes(p)) : allowed;
  const agesOk = isAge(r.ageMin) && isAge(r.ageMax) && r.ageMin <= r.ageMax;
  const genders = Array.isArray(r.genders) && strArr(r.genders).every((x) => (GENDERS as readonly string[]).includes(x))
    ? uniq(strArr(r.genders)) as Gender[] : g.audience.genders;
  const aiRegions = strArr(r.regions).filter((x) => INDIA_REGIONS.includes(x));
  const regions = Array.isArray(r.regions) ? uniq(aiRegions) : g.audience.regions;

  return {
    name, itemId, objective, platforms, prompt: g.prompt, language: g.language,
    audience: {
      ageMin: agesOk ? (r.ageMin as number) : g.audience.ageMin,
      ageMax: agesOk ? (r.ageMax as number) : g.audience.ageMax,
      genders: genders.length === 2 ? [] : genders,
      regions,
      lookalike: false,
    },
  };
}

/* ── Audience ↔ ad_target_groups ───────────────────────────────────────────── */

export interface TargetGroupRow {
  platform: AdPlatform | null;
  name: string;
  kind: "generic" | "lookalike";
  age_min: number;
  age_max: number;
  genders: Gender[];
  regions: string[];
}

export function targetGroupRows(plan: PlanDraft): TargetGroupRow[] {
  const a = plan.audience;
  const main: TargetGroupRow = {
    platform: null, name: "Main audience", kind: "generic",
    age_min: a.ageMin, age_max: a.ageMax, genders: a.genders, regions: a.regions,
  };
  if (!a.lookalike) return [main];
  return [main, { ...main, platform: "meta-ads", name: "People like my customers", kind: "lookalike" }];
}

export function audienceFromGroups(groups: readonly { kind: string; age_min: number | null; age_max: number | null; genders: string[]; regions: unknown }[]): Audience {
  const main = groups.find((g) => g.kind === "generic") ?? groups[0];
  return {
    ageMin: main?.age_min ?? DEFAULT_AGE.min,
    ageMax: main?.age_max ?? DEFAULT_AGE.max,
    genders: (main?.genders ?? []).filter((x): x is Gender => (GENDERS as readonly string[]).includes(x)),
    regions: strArr(main?.regions).filter((x) => INDIA_REGIONS.includes(x)),
    lookalike: groups.some((g) => g.kind === "lookalike"),
  };
}
