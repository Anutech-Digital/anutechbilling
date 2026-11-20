/**
 * The shape of an MCP tool, and who may run it.
 *
 * Gating reuses the app's own matrix instead of a new one:
 *   - `page`: the role must be able to open this screen in the app (lib/nav.ts canOpenRoute) —
 *     the tool shows nothing the person could not see on that page;
 *   - `roles`: an extra, explicit allowlist where the brief narrows it (P&L, salary);
 *   - `permission`: a lib/auth/roles.ts PERMISSIONS flag (e.g. can_view_financials);
 *   - `action`: an ACTION_ROLES guard (lib/auth/action-roles.ts) for write tools.
 * Unknown role → no tool (fail closed); 'personal' accounts get none.
 */
import type { z } from "zod";
import { can, isUserRole, type Permissions, type UserRole } from "@/lib/auth/roles";
import { mayDo, type GuardedAction } from "@/lib/auth/action-roles";
import { canOpenRoute } from "@/lib/nav";
import type { McpContext } from "@/lib/mcp/context";

export type ToolInput = z.ZodObject<z.ZodRawShape>;

export interface ToolResultOk {
  ok: true;
  data: unknown;
  summary?: string;
  /** Write tools: what the record looked like before and after, for mcp_audit_log. */
  audit?: { status: "preview" | "ok" | "replay"; before?: unknown; after?: unknown };
}
export interface ToolResultErr { ok: false; error: string; status: "denied" | "error" | "not_found" | "invalid" }
export type ToolResult = ToolResultOk | ToolResultErr;

export interface McpToolDef<I extends ToolInput = ToolInput> {
  name: string;
  title: string;
  description: string;
  kind: "read" | "write";
  page: string;
  roles?: readonly UserRole[];
  permission?: keyof Permissions;
  action?: GuardedAction;
  input: I;
  run(ctx: McpContext, input: z.infer<I>): Promise<ToolResult>;
}

export function defineTool<I extends ToolInput>(def: McpToolDef<I>): McpToolDef<I> {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(def.name)) throw new Error(`mcp tool name ${def.name} is invalid`);
  if (!def.page.startsWith("/")) throw new Error(`mcp tool ${def.name}: page must be an app path`);
  return Object.freeze(def);
}

/** Why this role may not run this tool, or null when it may. */
export function deniedReason(role: unknown, tool: Pick<McpToolDef, "page" | "roles" | "permission" | "action" | "title">): string | null {
  if (!isUserRole(role) || role === "personal") return "Your account type cannot use this tool.";
  if (tool.roles && !tool.roles.includes(role)) {
    return `Only ${tool.roles.join(" / ")} can use "${tool.title}". Ask one of them.`;
  }
  if (!canOpenRoute(role, tool.page)) return `Your role cannot open ${tool.page} in ResellerOS, so "${tool.title}" is not available to you.`;
  if (tool.permission && !can(role, tool.permission)) return `Your role does not have permission for "${tool.title}".`;
  if (tool.action && !mayDo(role, tool.action)) return `Your role cannot do "${tool.title}". Ask the owner or a manager.`;
  return null;
}

export const ok = (data: unknown, summary?: string): ToolResultOk => ({ ok: true, data, summary });
export const fail = (status: ToolResultErr["status"], error: string): ToolResultErr => ({ ok: false, status, error });
export const dbFail = (what: string, e: { message: string }): ToolResultErr =>
  fail("error", `Could not read ${what}: ${e.message}. Try again; if it repeats, open the page in ResellerOS.`);
