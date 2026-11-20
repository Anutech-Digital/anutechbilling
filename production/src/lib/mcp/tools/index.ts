/**
 * Every MCP tool, in one list. Write tools are offered only when MCP_WRITE_ENABLED is on AND the
 * connection was granted the mcp:write scope; each tool is offered only to roles it allows.
 */
import { mcpWriteEnabled } from "@/lib/mcp/config";
import type { McpContext } from "@/lib/mcp/context";
import { BILLING_READ_TOOLS } from "./read/billing";
import { OPS_READ_TOOLS } from "./read/ops";
import { SALES_READ_TOOLS } from "./read/sales";
import { deniedReason, type McpToolDef } from "./types";
import { PHASE_A_WRITE_TOOLS } from "./write/phase-a";

export const READ_TOOLS: readonly McpToolDef[] = Object.freeze([...OPS_READ_TOOLS, ...SALES_READ_TOOLS, ...BILLING_READ_TOOLS] as McpToolDef[]);
export const WRITE_TOOLS: readonly McpToolDef[] = Object.freeze([...PHASE_A_WRITE_TOOLS] as McpToolDef[]);

const names = new Set<string>();
for (const t of [...READ_TOOLS, ...WRITE_TOOLS]) {
  if (names.has(t.name)) throw new Error(`mcp tool ${t.name} registered twice`);
  names.add(t.name);
}

/** The tools this caller may see and run right now. */
export function toolsFor(ctx: Pick<McpContext, "role" | "canWrite">): McpToolDef[] {
  const writes = mcpWriteEnabled() && ctx.canWrite ? WRITE_TOOLS : [];
  return [...READ_TOOLS, ...writes].filter((t) => deniedReason(ctx.role, t) === null);
}
