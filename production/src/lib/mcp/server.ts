/**
 * Builds one MCP server per request (stateless — Cloud Run friendly) for one resolved caller,
 * and runs every tool call through the same gate: rate limit → role check → write switch →
 * strict input → tool → audit row.
 */
import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rateLimit } from "@/lib/security/rate-limit";
import { MCP_TOOL_RATE, mcpWriteEnabled } from "@/lib/mcp/config";
import type { McpContext } from "@/lib/mcp/context";
import { McpDbRefused } from "@/lib/mcp/db";
import { writeAudit, type AuditStatus } from "@/lib/mcp/audit";
import { toolsFor } from "@/lib/mcp/tools";
import { deniedReason, type McpToolDef, type ToolResult } from "@/lib/mcp/tools/types";

export interface ToolCallOutput {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function out(r: ToolResult): ToolCallOutput {
  if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
  const body = JSON.stringify(r.data);
  return { content: [{ type: "text", text: r.summary ? `${r.summary}\n${body}` : body }] };
}

/** One tool call, end to end. Exported for tests. */
export async function runTool(ctx: McpContext, tool: McpToolDef, args: unknown): Promise<ToolCallOutput> {
  const started = Date.now();
  let status: AuditStatus = "error";
  let result: ToolResult;
  try {
    const rl = rateLimit(`mcp:${ctx.userId}`, MCP_TOOL_RATE);
    if (!rl.ok) {
      status = "rate_limited";
      result = { ok: false, status: "denied", error: `Too many requests — wait ${rl.retryAfterSec} seconds and try again.` };
    } else {
      const denied = deniedReason(ctx.role, tool);
      if (denied) {
        status = "denied";
        result = { ok: false, status: "denied", error: denied };
      } else if (tool.kind === "write" && !(mcpWriteEnabled() && ctx.canWrite)) {
        status = "denied";
        result = { ok: false, status: "denied", error: "Changes from Claude are switched off for this connection. Ask the owner (MCP_WRITE_ENABLED), then reconnect allowing changes." };
      } else {
        const parsed = tool.input.safeParse(args ?? {});
        if (!parsed.success) {
          status = "invalid";
          result = { ok: false, status: "invalid", error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` };
        } else {
          result = await tool.run(ctx, parsed.data);
          status = result.ok ? result.audit?.status ?? "ok" : result.status;
        }
      }
    }
  } catch (e) {
    status = "error";
    const msg = e instanceof McpDbRefused ? e.message : e instanceof Error ? e.message : String(e);
    console.error(`[mcp] ${tool.name} threw: ${msg}`);
    result = { ok: false, status: "error", error: "Something went wrong running this tool. Try again; if it repeats, use the app." };
  }
  await writeAudit(ctx, {
    tool: tool.name,
    input: args,
    status,
    error: result.ok ? null : result.error,
    before: result.ok ? result.audit?.before : undefined,
    after: result.ok ? result.audit?.after : undefined,
    ms: Date.now() - started,
  });
  return out(result);
}

export function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "resellersos", version: "1.0.0" },
    { instructions: "ResellerOS — Anutech's business system (leads, customers, quotes, invoices, renewals, books, team, support). Money is in Indian rupees; GST (18%) is shown separately; dates are IST. Every change needs a preview first and the person's explicit OK before confirm=true." },
  );
  for (const tool of toolsFor(ctx)) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input.shape,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.kind === "read",
        destructiveHint: false,
        idempotentHint: tool.kind === "read",
        openWorldHint: false,
      },
    }, async (args: unknown) => runTool(ctx, tool, args));
  }
  return server;
}
