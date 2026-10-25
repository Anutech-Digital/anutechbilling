/**
 * R-1897 (epic R-1874) — Co-pilot Step 3, the ad copy: the rules behind the screen.
 *
 * One "copy set" = the lines for ONE platform and ONE audience of a plan (Google · Main audience,
 * Meta · Main audience, Meta · People like my customers). The AI fills a set (R-1876 route);
 * the person edits each line, rewrites one line, keeps (locks) or deletes it, pins Google lines;
 * every change autosaves into ad_copies with a version (ad_copy_sets / ad_copy_set_versions).
 *
 *   • audienceBlocks — which sets a plan has (platforms × audiences, format from the objective).
 *   • mergeAi       — put an AI run into a set: kept lines stay, the rest is replaced.
 *   • replaceLine   — "Rewrite this line": only that line changes.
 *   • counterTone   — the live counter "28/30", red past the limit; a Google line past its hard
 *                     limit blocks Mark ready, a Meta line past the recommendation only warns.
 *   • setProgress / readyCheck — the "Mark ready" rule: every chosen platform needs at least one
 *                     set that meets the platform's minimum, with no line over a hard limit.
 *   • toRows / fromRows — a set ↔ ad_copies rows (what autosave stores).
 *
 * Pure — no DB, no AI, no React. Limits come from channel-specs.ts (one place).
 */
import {
  CHANNEL_SPECS, fieldSpec, fitCheck, objectiveFor,
  type AdPlatform, type CopilotObjective, type CopyField,
} from "./channel-specs";

/** ad_target_groups.kind values that get their own copy set. */
export type AudienceKey = "generic" | "lookalike";
export const AUDIENCE_LABEL: Record<AudienceKey, string> = {
  generic: "Main audience",
  lookalike: "People like my customers",
};
export const AUDIENCE_KEYS: readonly AudienceKey[] = ["generic", "lookalike"];

export interface DraftLine {
  /** Stable key for React and for "rewrite this line" (not stored). */
  key: string;
  text: string;
  /** Kept: a new AI run does not replace it. */
  locked: boolean;
  /** Google pin position (headline 1–3, description 1–2); null = not pinned. */
  pinned: number | null;
  /** Written by the AI (and not edited since). */
  ai: boolean;
}

export interface CopySet {
  platform: AdPlatform;
  audience: AudienceKey;
  format: string;
  /** field key → lines in order. */
  lines: Record<string, DraftLine[]>;
  /** ad_copy_sets.version the lines came from (0 = never saved). */
  version: number;
}

export interface AudienceBlock {
  platform: AdPlatform;
  format: string;
  audience: AudienceKey;
  label: string;
}

let seq = 0;
export const newLineKey = () => `l${Date.now().toString(36)}${(++seq).toString(36)}`;

export function formatFields(platform: AdPlatform, format: string): readonly CopyField[] {
  return CHANNEL_SPECS[platform].formats.find((f) => f.key === format)?.fields ?? [];
}

/** The sets a plan has: each chosen platform × its audiences (lookalike only where the platform has one). */
export function audienceBlocks(platforms: readonly AdPlatform[], objective: CopilotObjective, lookalike: boolean): AudienceBlock[] {
  const out: AudienceBlock[] = [];
  for (const platform of platforms) {
    const po = objectiveFor(platform, objective);
    if (!po) continue;
    out.push({ platform, format: po.format, audience: "generic", label: AUDIENCE_LABEL.generic });
    if (lookalike && CHANNEL_SPECS[platform].lookalike) {
      out.push({ platform, format: po.format, audience: "lookalike", label: AUDIENCE_LABEL.lookalike });
    }
  }
  return out;
}

export function emptySet(platform: AdPlatform, audience: AudienceKey, format: string): CopySet {
  return { platform, audience, format, lines: Object.fromEntries(formatFields(platform, format).map((f) => [f.key, []])), version: 0 };
}

const same = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * An AI run → the set. Per field the AI returned: kept (locked) lines stay where they are in
 * the order; the unlocked lines are replaced by the AI's, skipping any that repeat a kept line,
 * up to the AI's count (at least the kept ones) and never past the platform's maximum.
 * Fields the AI did not return are left alone.
 */
export function mergeAi(set: CopySet, ai: readonly { field: string; lines: readonly string[] }[], key: () => string = newLineKey): CopySet {
  const lines = { ...set.lines };
  for (const { field, lines: fresh } of ai) {
    const spec = fieldSpec(set.platform, set.format, field);
    if (!spec) continue;
    const kept = (lines[field] ?? []).filter((l) => l.locked);
    if (spec.choices) {
      lines[field] = kept.length ? kept : fresh.slice(0, 1).map((text) => ({ key: key(), text, locked: false, pinned: null, ai: true }));
      continue;
    }
    const target = Math.min(spec.maxCount, Math.max(spec.aiCount ?? spec.maxCount, kept.length));
    const out = [...kept];
    for (const text of fresh) {
      if (out.length >= target) break;
      if (!text.trim() || out.some((l) => same(l.text, text))) continue;
      out.push({ key: key(), text, locked: false, pinned: null, ai: true });
    }
    lines[field] = out;
  }
  return { ...set, lines };
}

/** "Rewrite this line" (or an edit): only the line with this key changes. */
export function replaceLine(set: CopySet, field: string, lineKey: string, text: string, ai = true): CopySet {
  const list = set.lines[field];
  if (!list || !list.some((l) => l.key === lineKey)) return set;
  return { ...set, lines: { ...set.lines, [field]: list.map((l) => (l.key === lineKey ? { ...l, text, ai } : l)) } };
}

export interface Counter {
  tone: "ok" | "over";
  /** "28/30" — or just the length when the platform gives no number. */
  label: string;
  /** Past a HARD limit (Google): the line cannot be used — blocks Mark ready. */
  blocks: boolean;
  hint: string | null;
}

export function counterTone(text: string, field: CopyField): Counter {
  const fit = fitCheck(text, field);
  if (fit.limit == null) return { tone: "ok", label: String(fit.length), blocks: false, hint: null };
  const label = `${fit.length}/${fit.limit}`;
  if (fit.ok) return { tone: "ok", label, blocks: false, hint: null };
  return fit.kind === "max"
    ? { tone: "over", label, blocks: true, hint: `${fit.over} over the ${fit.limit}-character limit` }
    : { tone: "over", label, blocks: false, hint: `Meta suggests up to ${fit.limit} characters — longer text is cut with "See more"` };
}

export function pinOptions(platform: AdPlatform, field: string): number[] {
  if (platform !== "google-ads") return [];
  if (field === "headline") return [1, 2, 3];
  if (field === "description") return [1, 2];
  return [];
}

const plural = (n: number, word: string) => `${n} more ${word}${n === 1 ? "" : "s"}`;

export interface FieldProgress {
  key: string;
  label: string;
  count: number;
  min: number;
  max: number;
  /** Lines past a hard limit. */
  over: number;
}

export function setProgress(set: CopySet): { fields: FieldProgress[]; complete: boolean; missing: string[]; started: boolean } {
  const fields: FieldProgress[] = [];
  const missing: string[] = [];
  for (const spec of formatFields(set.platform, set.format)) {
    const lines = (set.lines[spec.key] ?? []).filter((l) => l.text.trim());
    const over = spec.choices ? 0 : lines.filter((l) => counterTone(l.text, spec).blocks).length;
    fields.push({ key: spec.key, label: spec.label, count: lines.length, min: spec.minCount, max: spec.maxCount, over });
    if (lines.length < spec.minCount) {
      missing.push(spec.choices ? `a ${spec.label.toLowerCase()}` : plural(spec.minCount - lines.length, spec.label.toLowerCase()));
    }
    if (over) missing.push(`${over} ${spec.label.toLowerCase()}${over === 1 ? " is" : "s are"} over ${spec.max} characters`);
  }
  const started = fields.some((f) => f.count > 0);
  return { fields, complete: missing.length === 0, missing, started };
}

/**
 * Mark ready: for EVERY chosen platform, at least one set (any audience) of the objective's
 * format that is complete. Otherwise one plain line per platform saying what is left.
 */
export function readyCheck(platforms: readonly AdPlatform[], objective: CopilotObjective, sets: readonly CopySet[]): { ok: boolean; missing: string[] } {
  if (!platforms.length) return { ok: false, missing: ["Pick at least one platform in step 2."] };
  const missing: string[] = [];
  for (const platform of platforms) {
    const label = CHANNEL_SPECS[platform].label;
    const po = objectiveFor(platform, objective);
    if (!po) { missing.push(`${label}: not available for this objective — untick it in step 2.`); continue; }
    const mine = sets.filter((s) => s.platform === platform && s.format === po.format);
    if (mine.some((s) => setProgress(s).complete)) continue;
    /* Say what the closest set still needs (the main audience first). */
    const best = [...mine].sort((a, b) => setProgress(a).missing.length - setProgress(b).missing.length
      || AUDIENCE_KEYS.indexOf(a.audience) - AUDIENCE_KEYS.indexOf(b.audience))[0];
    const left = best ? setProgress(best).missing : setProgress(emptySet(platform, "generic", po.format)).missing;
    const who = best ? AUDIENCE_LABEL[best.audience] : AUDIENCE_LABEL.generic;
    missing.push(`${label} · ${who}: ${left.join(", ")}.`);
  }
  return { ok: missing.length === 0, missing };
}

/** One ad_copies row (without ids / tenant / plan — the route adds those). */
export interface CopyRow {
  platform: AdPlatform;
  audience: AudienceKey;
  format: string;
  field: string;
  text: string;
  position: number;
  locked: boolean;
  pinned: number | null;
  ai_generated: boolean;
}

/** A set → the rows autosave stores. Blank lines are not stored; positions count per field. */
export function toRows(set: CopySet): CopyRow[] {
  const rows: CopyRow[] = [];
  for (const spec of formatFields(set.platform, set.format)) {
    const lines = (set.lines[spec.key] ?? []).filter((l) => l.text.trim()).slice(0, spec.maxCount);
    lines.forEach((l, position) => rows.push({
      platform: set.platform, audience: set.audience, format: set.format, field: spec.key,
      text: l.text.trim(), position, locked: l.locked,
      pinned: pinOptions(set.platform, spec.key).includes(l.pinned ?? 0) ? l.pinned : null,
      ai_generated: l.ai,
    }));
  }
  return rows;
}

export function fromRows(
  platform: AdPlatform, audience: AudienceKey, format: string,
  rows: readonly Pick<CopyRow, "field" | "text" | "position" | "locked" | "pinned" | "ai_generated">[],
  version: number, key: () => string = newLineKey,
): CopySet {
  const set = emptySet(platform, audience, format);
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  for (const r of sorted) {
    if (!set.lines[r.field]) continue; // a field this format no longer has
    set.lines[r.field].push({ key: key(), text: r.text, locked: r.locked, pinned: r.pinned ?? null, ai: r.ai_generated });
  }
  return { ...set, version };
}

/** Who a set is for, in words the AI writes to (copy + rewrite routes). */
export const AUDIENCE_WORDS: Record<AudienceKey, string> = {
  generic: "the main audience of the plan",
  lookalike: "people similar to the business's existing customers (they do not know the brand yet)",
};
