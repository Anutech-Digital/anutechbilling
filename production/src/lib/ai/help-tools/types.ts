/**
 * Help AI tool contract (R-2774 / H-01, G-HELPAI, 14 Nov 2026).
 *
 * One shape for every Help AI tool, so the tenant / role / secret rules cannot be skipped by a
 * new tool:
 *   - `input`  — a STRICT zod object (unknown keys refused) the model's arguments must pass;
 *                it may never have a key for the tenant, the user or the role (R-2879) — those
 *                come from the session only;
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
import { foldKey, foldForMatch } from "./fold";

export const HELP_TOOL_TIERS = ["read", "safe", "confirm", "never"] as const;
export type HelpToolTier = (typeof HELP_TOOL_TIERS)[number];

/** Rows a tool may hand back: default 50, never more than 200. */
export const HELP_ROWS_DEFAULT = 50;
export const HELP_ROWS_MAX = 200;
/** R-2879: most columns one row may carry, and the most characters one whole result may take. */
export const HELP_ROW_KEYS_MAX = 20;
export const HELP_RESULT_BYTES_MAX = 64_000;

/**
 * One path inside this app (R-2879 finding 5; the same rule as APP_PATH in lib/ai/app-help.ts):
 * a single leading slash, never `//host` or `/\host` (the browser reads both as another site), no
 * backslash, no scheme, no spaces or control characters.
 */
const APP_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%#]*$/;
export function isAppPath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 300 && APP_PATH.test(v);
}

/** Where a fact came from — table + row ids and the page that shows them (H-04 citations). */
export const HELP_SOURCE_REF = z.object({
  table: z.string().regex(/^[a-z_][a-z0-9_]*$/).nullable(),
  ids: z.array(z.string().max(80)).max(HELP_ROWS_MAX),
  href: z.string().max(300).refine(isAppPath, "href must be an app path"),
  label: z.string().min(1).max(120),
}).strict();
export type HelpSourceRef = z.infer<typeof HELP_SOURCE_REF>;

const ROW_VALUE = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
/** A row: at most HELP_ROW_KEYS_MAX plain column names (R-2879 finding 6). */
const ROW = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), ROW_VALUE)
  .refine((r) => Object.keys(r).length <= HELP_ROW_KEYS_MAX, `a row may have at most ${HELP_ROW_KEYS_MAX} columns`);

export const HELP_TOOL_OUTPUT = z.object({
  /** Short factual text for the model (English). */
  text: z.string().min(1).max(8000),
  /** Optional rows (plain values only). The runner cuts them to the tool's cap BEFORE this check. */
  rows: z.array(ROW).max(HELP_ROWS_MAX).optional(),
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

/** zod's strict object: unknown keys refused, and no catchall that would take them instead (R-2882). */
export function isStrictObject(s: z.ZodTypeAny): boolean {
  if (!(s instanceof z.ZodObject)) return false;
  const def = s._def as { unknownKeys?: string; catchall?: unknown };
  return def.unknownKeys === "strict" && def.catchall instanceof z.ZodNever;
}

/**
 * Input keys that would let the model say WHO it is acting for (R-2879). Tenant, user and role
 * come from the session only — a tool that needs "which salesperson" names the key for what it
 * is (owner_id of a lead, assigned_to), never one of these. Compared in FOLDED form (R-2882:
 * NFKC, look-alike Cyrillic / Greek letters, case, every separator and invisible character gone —
 * "Tеnant-ID" with a Cyrillic е is "tenantid"): any key with "tenant" or "role" in it, user / uid /
 * actor (also as_user, for_user_id …), company_id / org_id / workspace_id, impersonate…,
 * on_behalf…. A wide net on purpose — a key it catches by mistake is renamed, a key it misses lets
 * the model pick whose data it reads.
 */
/** `principal`, `principal_id`, `principalId` — the whole word only, so `principal_amount` (a loan figure) is an ordinary key. */
function isPrincipalKey(key: string): boolean {
  const words = foldForMatch(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")).split(/[^a-z0-9]+/).filter(Boolean);
  return words[0] === "principal" && (words.length === 1 || (words.length === 2 && (words[1] === "id" || words[1] === "uid")));
}
function isSessionOnlyKey(key: string): boolean {
  const k = foldKey(key);
  return k.includes("tenant") || k.includes("role") || k.includes("impersonat") || k.includes("onbehalf")
    || k.includes("actingas") || k.includes("runas") || isPrincipalKey(key) || k.includes("behalfof") || k.startsWith("sudo") || k.endsWith("sudo")
    || /^(for|as|by|auth|session|current|acting|login|my)?(user|users|userid|uid|actor|actorid)$/.test(k)
    || /^(company|org|organisation|organization|workspace)id$/.test(k);
}

/**
 * Does a parsed value hold a tenant / user / role key at ANY depth? A second lock at run time: an
 * input that came out of the schema with such a key (an output a schema built, a swapped schema)
 * never reaches the tool. Too deep or too wide to check counts as yes.
 */
export function hasSessionOnlyKey(value: unknown, depth = 0, seen: { n: number } = { n: 0 }): boolean {
  if (typeof value !== "object" || value === null) return false;
  seen.n += 1;
  if (depth > 12 || seen.n > 2000) return true;
  if (Array.isArray(value)) return value.some((v) => hasSessionOnlyKey(v, depth + 1, seen));
  for (const [k, v] of Object.entries(value)) {
    if (isSessionOnlyKey(k) || hasSessionOnlyKey(v, depth + 1, seen)) return true;
  }
  return false;
}

/** Plain values an input may hold. */
const INPUT_LEAVES = [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodEnum, z.ZodLiteral, z.ZodDate, z.ZodNull] as const;
/** Plain ASCII key names only: a look-alike letter or an invisible character cannot be a key. */
const INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Walk an input schema at EVERY depth. Returns a signature of everything that decides what it
 * accepts (every object's key list and strictness, wrappers, string / number checks, enum values)
 * and pushes each key name onto `keys`. Throws for anything that breaks the contract: an object
 * that is not strict (passthrough, strip, a catchall) at any level, a key that is not plain ASCII,
 * a transform / preprocess (an output that can grow keys), or a type whose keys this walk cannot
 * list. defineHelpTool runs it once at registration and the private parser runs it again before
 * every parse and compares the signature — a schema changed after registration stops the tool.
 */
function describeInput(s: z.ZodTypeAny, keys: string[], depth = 0): string {
  if (depth > 10) throw new Error("input schema is nested too deep to check");
  if (s instanceof z.ZodObject) {
    if (!isStrictObject(s)) throw new Error("every object in input must be strict, at any depth — no passthrough, strip or catchall (z.object({...}).strict())");
    /* zod keeps a cached key list that a parse trusts over the shape: drop it, so the parse that follows
       rebuilds it from the very shape this walk is about to sign (a swapped `_cached` cannot add a key). */
    try { (s as unknown as { _cached: unknown })._cached = null; } catch { /* frozen: it cannot be swapped either */ }
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const parts = Object.entries(shape).map(([k, v]) => {
      if (!INPUT_KEY.test(k)) throw new Error(`input key '${k}' must be plain ASCII letters, digits and _`);
      keys.push(k);
      return `${k}:${describeInput(v, keys, depth + 1)}`;
    });
    return `{${parts.join(",")}}`;
  }
  if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) return `${s instanceof z.ZodOptional ? "opt" : "null"}(${describeInput(s.unwrap() as z.ZodTypeAny, keys, depth + 1)})`;
  if (s instanceof z.ZodDefault) return `default(${describeInput(s.removeDefault() as z.ZodTypeAny, keys, depth + 1)})`;
  if (s instanceof z.ZodArray) return `array(${describeInput(s.element as z.ZodTypeAny, keys, depth + 1)})`;
  if (s instanceof z.ZodEffects) {
    const effect = (s._def as { effect?: { type?: string; refinement?: unknown } }).effect;
    if (effect?.type !== "refinement") throw new Error("input may not use transform / preprocess (an effect that can change the keys) — only refine");
    return `refine[${String(effect.refinement)}](${describeInput(s.innerType() as z.ZodTypeAny, keys, depth + 1)})`;
  }
  if (s instanceof z.ZodUnion) return `union(${(s.options as z.ZodTypeAny[]).map((o) => describeInput(o, keys, depth + 1)).join("|")})`;
  if (INPUT_LEAVES.some((leaf) => s instanceof leaf)) {
    const d = s._def as { typeName?: string; checks?: unknown; values?: unknown; value?: unknown };
    /* A RegExp has no enumerable fields (JSON would write {}): sign its source and flags, so one changed in place (`.compile`) shows. */
    const plain = (_key: string, v: unknown): unknown => (typeof v === "object" && v !== null && typeof (v as { source?: unknown }).source === "string" ? `re:${(v as { source: string }).source}/${String((v as { flags?: unknown }).flags)}` : v);
    return `${String(d.typeName)}${JSON.stringify([d.checks ?? null, d.values ?? null, d.value ?? null], plain)}`;
  }
  /* Fail closed: a type whose keys this walk cannot list (record, map, any, unknown, intersection,
     discriminated union, lazy, tuple, pipeline …) may not be a tool input until it is added here. */
  throw new Error("input may use only objects, arrays, unions, optional / nullable / default and plain values (string, number, boolean, enum, literal, date)");
}

/** Tools made by defineHelpTool — the only objects the registry and the runner accept (R-2879 finding 3). */
const DEFINED = new WeakSet<object>();
export function isHelpToolDef(t: unknown): t is HelpToolDef {
  return typeof t === "object" && t !== null && DEFINED.has(t);
}

/**
 * The parser a registered tool exposes as `input` (R-2882, review of R-2879 finding 4). The zod
 * schema lives only in this closure — `tool.input` has no `_def` to mutate. The schema object the
 * tool's author wrote can still be reached through the author's own variable, so before EVERY
 * parse the walk runs again and its signature must equal the one taken at registration; the parsed
 * value is then checked for a tenant / user / role key at any depth. Anything else is a refused
 * parse (success: false), so the runner answers bad_input and the tool does not run.
 */
function privateParser(schema: z.ZodTypeAny, signature: string): { safeParse: (v: unknown) => z.SafeParseReturnType<unknown, unknown>; parse: (v: unknown) => unknown } {
  const refused = (why: string): z.SafeParseError<unknown> => ({ success: false, error: new z.ZodError([{ code: "custom", path: [], message: why }]) });
  const safeParse = (v: unknown): z.SafeParseReturnType<unknown, unknown> => {
    try {
      if (describeInput(schema, []) !== signature) return refused("input schema changed after registration");
    } catch {
      return refused("input schema no longer meets the contract");
    }
    const r = schema.safeParse(v);
    if (r.success && hasSessionOnlyKey(r.data)) return refused("input holds a tenant / user / role key");
    return r;
  };
  const parse = (v: unknown): unknown => {
    const r = safeParse(v);
    if (!r.success) throw r.error;
    return r.data;
  };
  return Object.freeze({ safeParse, parse });
}

/**
 * Register a tool. Throws (at import time, so the app does not start with a bad tool) when the
 * contract is broken: tier `never`, a loose input schema (at any depth), an input key for tenant /
 * user / role (look-alikes included), no roles / an unknown role, a page that is not an app path,
 * a bad name, or a row cap above HELP_ROWS_MAX. The returned tool is frozen and its `input` is a
 * private parser (privateParser), not the schema.
 */
export function defineHelpTool<I extends z.ZodTypeAny>(def: HelpToolDef<I> | (Omit<HelpToolDef<I>, "tier"> & { tier: HelpToolTier })): HelpToolDef<I> {
  const bad = (why: string) => new Error(`help tool ${def.name}: ${why}`);
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(def.name)) throw bad("name must be snake_case, 3-48 chars");
  if (def.tier === "never" || !(HELP_TOOL_TIERS as readonly string[]).includes(def.tier)) throw bad(`tier '${def.tier}' cannot be registered`);
  if (!(def.input instanceof z.ZodObject)) throw bad("input must be a strict zod object (z.object({...}).strict())");
  const keys: string[] = [];
  let signature: string;
  try {
    signature = describeInput(def.input, keys);
  } catch (err) {
    throw bad((err as Error).message);
  }
  for (const k of keys) {
    if (isSessionOnlyKey(k)) throw bad(`input key '${k}' — tenant, user and role come from the session, never from tool input`);
  }
  if (!def.roles.length || def.roles.some((r) => !(USER_ROLES as readonly string[]).includes(r))) throw bad("roles must be known roles, at least one");
  if (!/^\/[a-z0-9/_-]*(\?[^#\s]*)?$/i.test(def.page) || !isAppPath(def.page)) throw bad("page must be an app path");
  if (def.maxRows != null && (!Number.isInteger(def.maxRows) || def.maxRows < 1 || def.maxRows > HELP_ROWS_MAX)) throw bad(`maxRows must be 1-${HELP_ROWS_MAX}`);
  const input = privateParser(def.input, signature) as unknown as I;
  const tool = Object.freeze({ ...def, input, roles: Object.freeze([...def.roles]) }) as HelpToolDef<I>;
  DEFINED.add(tool);
  return tool;
}
