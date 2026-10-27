/**
 * R-1897 — Co-pilot Step 3 reads and writes (ad_copies, ad_copy_sets, ad_copy_set_versions).
 * Everything runs inside withTenant, so RLS (R-1878 / R-1897: same company AND owner / manager /
 * marketing) is the second lock behind the role check, and every write names the session's
 * tenant itself.
 *
 * Autosave = one transaction: optimistic version check (a save from an older version is refused,
 * so two tabs never overwrite each other silently) → replace the set's lines → keep a version
 * row (latest 20) → a Ready plan goes back to Draft (its copy changed after approval).
 */
import { z } from "zod";
import type { Tx } from "@/server/db";
import { CHANNEL_SPECS, PLATFORMS, fieldSpec, objectiveFor, type AdPlatform, type CopilotObjective } from "@/lib/marketing/copilot/channel-specs";
import { AUDIENCE_KEYS, audienceBlocks, fromRows, pinOptions, type AudienceKey, type CopyRow, type CopySet } from "@/lib/marketing/copilot/copy-set";

/** How many versions of one set are kept. */
export const KEEP_VERSIONS = 20;

const lineSchema = z.object({
  field: z.string().regex(/^[a-z_]{1,40}$/),
  text: z.string().trim().min(1).max(2000),
  position: z.number().int().min(0).max(49),
  locked: z.boolean(),
  pinned: z.number().int().min(1).max(3).nullable(),
  ai_generated: z.boolean(),
});

export const saveSetSchema = z.object({
  platform: z.enum(PLATFORMS as unknown as [AdPlatform, ...AdPlatform[]]),
  audience: z.enum(AUDIENCE_KEYS as unknown as [AudienceKey, ...AudienceKey[]]),
  format: z.string().regex(/^[a-z_]{1,40}$/),
  expectedVersion: z.number().int().min(0),
  lines: z.array(lineSchema).max(60),
});
export type SaveSetBody = z.infer<typeof saveSetSchema>;

export interface PlanForCopy { id: string; status: string; objective: CopilotObjective; platforms: AdPlatform[]; lookalike: boolean }

export async function planForCopy(tx: Tx, tenantId: string, id: string): Promise<PlanForCopy | null> {
  const p = await tx.ad_plans.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true, status: true, objective: true, platforms: true, ad_target_groups: { select: { kind: true } } },
  });
  if (!p) return null;
  const groups = (p as { ad_target_groups?: { kind: string }[] }).ad_target_groups ?? [];
  return {
    id: p.id, status: p.status, objective: p.objective as CopilotObjective,
    platforms: (p.platforms as string[]).filter((x): x is AdPlatform => (PLATFORMS as readonly string[]).includes(x)),
    lookalike: groups.some((g) => g.kind === "lookalike"),
  };
}

/** Is this body a set the plan has, with lines the platform takes? Returns the reason when not. */
export function checkSetBody(plan: PlanForCopy, b: SaveSetBody): string | null {
  const label = CHANNEL_SPECS[b.platform].label;
  if (!plan.platforms.includes(b.platform)) return `${label} is not chosen for this plan — tick it in step 2 first.`;
  const po = objectiveFor(b.platform, plan.objective);
  if (!po || po.format !== b.format) return `${label} uses a different ad format for this objective — reload the page.`;
  /* The audience must be one of the plan's blocks; the lookalike only where the platform has one. */
  const blocks = audienceBlocks(plan.platforms, plan.objective, plan.lookalike);
  if (!blocks.some((x) => x.platform === b.platform && x.audience === b.audience)) {
    return `${label} has no "${b.audience}" audience.`;
  }
  const counts = new Map<string, number>();
  for (const l of b.lines) {
    const spec = fieldSpec(b.platform, b.format, l.field);
    if (!spec) return `${label} has no "${l.field}" field.`;
    if (spec.choices && !spec.choices.some((c) => c.value === l.text)) return `Pick the ${spec.label.toLowerCase()} from the list.`;
    if (l.pinned != null && !pinOptions(b.platform, l.field).includes(l.pinned)) return `${spec.label} cannot be pinned to position ${l.pinned}.`;
    const n = (counts.get(l.field) ?? 0) + 1;
    if (n > spec.maxCount) return `${label} takes at most ${spec.maxCount} ${spec.label.toLowerCase()}${spec.maxCount === 1 ? "" : "s"}.`;
    counts.set(l.field, n);
  }
  return null;
}

export interface SavedSet { platform: AdPlatform; audience: AudienceKey; format: string; version: number; rows: CopyRow[] }

export async function readSets(tx: Tx, tenantId: string, planId: string): Promise<SavedSet[]> {
  const sets = await tx.ad_copy_sets.findMany({
    where: { tenant_id: tenantId, plan_id: planId },
    select: { platform: true, audience: true, format: true, version: true },
  });
  const rows = await tx.ad_copies.findMany({
    where: { tenant_id: tenantId, plan_id: planId },
    orderBy: { position: "asc" },
    select: { platform: true, audience: true, format: true, field: true, text: true, position: true, locked: true, pinned: true, ai_generated: true },
  });
  return sets.map((s) => ({
    platform: s.platform as AdPlatform,
    audience: s.audience as AudienceKey,
    format: s.format,
    version: s.version,
    rows: rows
      .filter((r) => r.platform === s.platform && r.audience === s.audience && r.format === s.format)
      .map((r) => ({
        platform: r.platform as AdPlatform, audience: r.audience as AudienceKey, format: r.format, field: r.field,
        text: r.text, position: r.position, locked: r.locked, pinned: r.pinned ?? null, ai_generated: r.ai_generated,
      })),
  }));
}

export function toCopySets(saved: readonly SavedSet[]): CopySet[] {
  return saved.map((s) => fromRows(s.platform, s.audience, s.format, s.rows, s.version));
}

export type SaveResult =
  | { kind: "ok"; version: number; status: string }
  | { kind: "conflict"; version: number };

const isUnique = (e: unknown) => !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";

export async function saveSet(tx: Tx, tenantId: string, plan: PlanForCopy, b: SaveSetBody): Promise<SaveResult> {
  const key = { tenant_id: tenantId, plan_id: plan.id, platform: b.platform, audience: b.audience };
  const current = await tx.ad_copy_sets.findFirst({ where: key, select: { id: true, version: true } });
  if ((current?.version ?? 0) !== b.expectedVersion) return { kind: "conflict", version: current?.version ?? 0 };

  let setId: string;
  let version: number;
  if (current) {
    version = current.version + 1;
    /* The version in the WHERE makes this the lock: a save that raced us finds 0 rows. */
    const moved = await tx.ad_copy_sets.updateMany({
      where: { id: current.id, tenant_id: tenantId, version: b.expectedVersion },
      data: { version, format: b.format, updated_at: new Date() },
    });
    if (moved.count !== 1) return { kind: "conflict", version: b.expectedVersion + 1 };
    setId = current.id;
  } else {
    try {
      const created = await tx.ad_copy_sets.create({ data: { ...key, format: b.format, version: 1 }, select: { id: true } });
      setId = created.id;
      version = 1;
    } catch (e) {
      if (isUnique(e)) return { kind: "conflict", version: 1 };
      throw e;
    }
  }

  await tx.ad_copies.deleteMany({ where: key });
  const rows = b.lines.map((l) => ({
    tenant_id: tenantId, plan_id: plan.id, platform: b.platform, audience: b.audience, format: b.format,
    field: l.field, text: l.text, position: l.position, locked: l.locked, pinned: l.pinned, ai_generated: l.ai_generated,
  }));
  if (rows.length) await tx.ad_copies.createMany({ data: rows });

  await tx.ad_copy_set_versions.create({
    data: { tenant_id: tenantId, set_id: setId, version, lines: b.lines },
  });
  if (version > KEEP_VERSIONS) {
    await tx.ad_copy_set_versions.deleteMany({ where: { tenant_id: tenantId, set_id: setId, version: { lte: version - KEEP_VERSIONS } } });
  }

  let status = plan.status;
  if (plan.status === "ready") {
    await tx.ad_plans.update({ where: { id: plan.id }, data: { status: "draft", updated_at: new Date() } });
    status = "draft";
  }
  return { kind: "ok", version, status };
}
