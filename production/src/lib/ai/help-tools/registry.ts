/**
 * Help AI tool registry (R-2774 / H-01). Every tool the assistant may call is listed here and
 * built with defineHelpTool (types.ts) — a tool that breaks the contract throws at import.
 *
 * R-2879: the registry is a frozen, prototype-less object over a Map nobody else can reach —
 * there is no set / delete / clear, so no module can add or swap a tool at run time, and only
 * objects made by defineHelpTool can be put in one. Who may call buildRegistry / defineHelpTool
 * is checked by module in src/lib/security/help-tools-guard.test.ts.
 *
 * HELP_AI_V2 (env, "1"/"true"/"on"): the new registry path in /api/ai/help, for the OWNER only
 * (G-HELPAI owner decision, 14 Nov 2026). Off, or any other role → the R-421 path, unchanged.
 */
import { isUserRole, type UserRole } from "@/lib/auth/roles";
import { canOpenRoute } from "@/lib/nav";
import { isHelpToolDef, type HelpToolDef } from "./types";
import { DATA_TOOLS } from "./data-tools";

/** Read-only view of a set of tools. `values()` hands out a fresh array each time. */
export interface HelpToolRegistry {
  get(name: string): HelpToolDef | undefined;
  has(name: string): boolean;
  values(): HelpToolDef[];
  readonly size: number;
}

export function buildRegistry(tools: readonly HelpToolDef[]): HelpToolRegistry {
  const map = new Map<string, HelpToolDef>();
  for (const t of tools) {
    if (!isHelpToolDef(t)) throw new Error("help tool registry: every tool must be made by defineHelpTool");
    if (map.has(t.name)) throw new Error(`help tool ${t.name}: registered twice`);
    map.set(t.name, t);
  }
  const registry: Record<string, unknown> = Object.create(null);
  registry.get = (name: unknown) => (typeof name === "string" ? map.get(name) : undefined);
  registry.has = (name: unknown) => typeof name === "string" && map.has(name);
  registry.values = () => [...map.values()];
  registry.size = map.size;
  return Object.freeze(registry) as unknown as HelpToolRegistry;
}

export const HELP_TOOL_REGISTRY: HelpToolRegistry = buildRegistry([...DATA_TOOLS] as unknown as HelpToolDef[]);

/**
 * May this role run this tool? Fail-closed: no role / unknown role / not in the tool's roles /
 * cannot open the tool's page → no. (canOpenRoute alone says yes to a null role — the
 * isUserRole check comes first on purpose.)
 */
export function helpToolAllowedFor(role: unknown, tool: HelpToolDef): role is UserRole {
  if (!isUserRole(role)) return false;
  if (!tool.roles.includes(role)) return false;
  return canOpenRoute(role, tool.page);
}

/** The tools this role may run — what the model is offered. */
export function helpToolsFor(role: unknown, registry: HelpToolRegistry = HELP_TOOL_REGISTRY): HelpToolDef[] {
  return registry.values().filter((t) => helpToolAllowedFor(role, t));
}

/** HELP_AI_V2 is on and this person is the owner. */
export function helpAiV2Enabled(role: unknown): boolean {
  const flag = (process.env.HELP_AI_V2 ?? "").trim().toLowerCase();
  return (flag === "1" || flag === "true" || flag === "on") && role === "owner";
}
