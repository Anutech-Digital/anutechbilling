/**
 * Help AI tool contract (R-2774 / H-01, G-HELPAI, 14 Nov 2026).
 *
 * One shape for every Help AI tool, so the tenant / role / secret rules cannot be skipped by a
 * new tool:
 *   - `input`  — a STRICT zod object (unknown keys refused) the model's arguments must pass;
 *   - `output` — what `run` returns is checked against HELP_TOOL_OUTPUT before anyone sees it;
 *   - `roles`  — who may run it (owner = the most; others are added per tool later). Fail-closed;
 *   - `tier`   — read | safe | confirm. `never` exists only to be refused at registration;
 *   - `page`   — the page this data belongs to: the role must be able to open it
 *                (canOpenRoute) and it is the citation link of every result;
 *   - `run(input, ctx)` — gets a TENANT-SCOPED READER (ctx.db), never a Supabase client. The
 *                reader adds `tenant_id = <this company>` to every query, reads only allowlisted
 *                tables and refuses secret columns (reader.ts).
 */
import { z } from "zod";
import { USER_ROLES, type UserRole } from "@/lib/auth/roles";
import type { HelpDb } from "./reader";

export const HELP_TOOL_TIERS = ["read", "safe", "confirm", "never"] as const;
export type HelpToolTier = (typeof HELP_TOOL_TIERS)[number];

/** Rows a tool may hand back: default 50, never more than 200. */
export const HELP_ROWS_DEFAULT = 50;
export const HELP_ROWS_MAX = 200;

/** Where a fact came from — table + row ids and the page that shows them (H-04 citations). */
export const HELP_SOURCE_REF = z.object({
  table: z.string().regex(/^[a-z_][a-z0-9_]*$/).nullable(),
  ids: z.array(z.string().max(80)).max(HELP_ROWS_MAX),
  href: z.string().startsWith("/").max(300),
  label: z.string().min(1).max(120),
}).strict();
export type HelpSourceRef = z.infer<typeof HELP_SOURCE_REF>;

const ROW_VALUE = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const HELP_TOOL_OUTPUT = z.object({
  /** Short factual text for the model (English). */
  text: z.string().min(1).max(8000),
  /** Optional rows (plain values only). The runner cuts them to the tool's cap. */
  rows: z.array(z.record(ROW_VALUE)).optional(),
  /** Rows that matched before the cap, when the tool knows it. */
  total: z.number().int().nonnegative().optional(),
  sources: z.array(HELP_SOURCE_REF).max(20),
}).strict();
export type HelpToolOutput = z.infer<typeof HELP_TOOL_OUTPUT>;

export interface HelpToolCtx {
  /** Tenant-scoped, read-only, secret-free. The ONLY data access a tool gets. */
  db: HelpDb;
  tenantId: string;
  role: UserRole;
  now: Date;
}

export interface HelpToolDef<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** What the model reads in the tool list. */
  describe: string;
  input: I;
  roles: readonly UserRole[];
  tier: Exclude<HelpToolTier, "never">;
  page: string;
  /** Link text for the page. */
  label: string;
  /** Row cap for `rows` (default 50, max 200). */
  maxRows?: number;
  run: (input: z.infer<I>, ctx: HelpToolCtx) => Promise<HelpToolOutput>;
}

/** zod's strict object: unknown keys are refused. */
export function isStrictObject(s: z.ZodTypeAny): boolean {
  return s instanceof z.ZodObject && (s._def as { unknownKeys?: string }).unknownKeys === "strict";
}

/**
 * Register a tool. Throws (at import time, so the app does not start with a bad tool) when the
 * contract is broken: tier `never`, a loose input schema, no roles / an unknown role, a page
 * that is not an app path, a bad name, or a row cap above HELP_ROWS_MAX.
 */
export function defineHelpTool<I extends z.ZodTypeAny>(def: HelpToolDef<I> | (Omit<HelpToolDef<I>, "tier"> & { tier: HelpToolTier })): HelpToolDef<I> {
  const bad = (why: string) => new Error(`help tool ${def.name}: ${why}`);
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(def.name)) throw bad("name must be snake_case, 3-48 chars");
  if (def.tier === "never" || !(HELP_TOOL_TIERS as readonly string[]).includes(def.tier)) throw bad(`tier '${def.tier}' cannot be registered`);
  if (!isStrictObject(def.input)) throw bad("input must be a strict zod object (z.object({...}).strict())");
  if (!def.roles.length || def.roles.some((r) => !(USER_ROLES as readonly string[]).includes(r))) throw bad("roles must be known roles, at least one");
  if (!/^\/[a-z0-9/_-]*(\?[^#\s]*)?$/i.test(def.page)) throw bad("page must be an app path");
  if (def.maxRows != null && (!Number.isInteger(def.maxRows) || def.maxRows < 1 || def.maxRows > HELP_ROWS_MAX)) throw bad(`maxRows must be 1-${HELP_ROWS_MAX}`);
  return Object.freeze({ ...def, roles: Object.freeze([...def.roles]) }) as HelpToolDef<I>;
}
