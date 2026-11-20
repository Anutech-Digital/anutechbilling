/**
 * Every write is two calls (docs/MCP.md → "How writes work"):
 *
 *   1. call without `confirm` → nothing changes. The tool checks permission, reads the record's
 *      current values, and saves a preview (mcp_write_previews) holding the exact input, its
 *      hash, the before-values and the caller's idempotency key. Claude shows the preview.
 *   2. call again with the SAME input + `confirm: true` + `preview_id` → the change is made once.
 *
 * Guarantees:
 *   - same input only: the input hash must match the preview's, so a confirm cannot smuggle in a
 *     different change than the one the person saw;
 *   - once: pending → applying is a compare-and-set; a repeated confirm (Claude retrying a timeout)
 *     returns the stored result instead of writing again — that is the idempotency key's job;
 *   - fresh: `prepare` runs again at confirm and must produce the same before-values; if someone
 *     changed the record in between, the confirm is refused and asks for a new preview;
 *   - previews expire after PREVIEW_TTL_SECONDS.
 */
import { z } from "zod";
import { PREVIEW_TTL_SECONDS } from "@/lib/mcp/config";
import type { McpContext } from "@/lib/mcp/context";
import type { McpJson } from "@/lib/mcp/db";
import { defineTool, fail, ok, type McpToolDef, type ToolResult, type ToolResultErr } from "@/lib/mcp/tools/types";
import type { GuardedAction } from "@/lib/auth/action-roles";
import type { UserRole } from "@/lib/auth/roles";
import { sha256Hex } from "@/lib/mcp/crypto";

export const CONFIRM_FIELDS = {
  idempotency_key: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/).describe("A unique key you choose for THIS change (e.g. a UUID). Reuse the same key for the preview and the confirm."),
  confirm: z.boolean().optional().describe("Leave out to preview. Send true (with preview_id) only after the person has approved the preview."),
  preview_id: z.string().uuid().optional().describe("The preview_id returned by the preview call."),
};

export interface Prepared { before: McpJson; summary: string }
export interface Applied { after: McpJson; summary: string }

/** Stable JSON: keys sorted, so the same input always hashes the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

type ConfirmShape = typeof CONFIRM_FIELDS;

interface PreviewRow {
  id: string; tool: string; input_hash: string; before_values: McpJson; idempotency_key: string;
  status: string; result: McpJson; expires_at: string;
}
const PREVIEW_COLS = ["id", "tool", "input_hash", "before_values", "idempotency_key", "status", "result", "expires_at"] as const;

export function defineWriteTool<S extends z.ZodRawShape>(spec: {
  name: string; title: string; description: string; page: string;
  roles?: readonly UserRole[]; action?: GuardedAction;
  fields: S;
  prepare(ctx: McpContext, input: z.infer<z.ZodObject<S>>): Promise<Prepared | ToolResultErr>;
  apply(ctx: McpContext, input: z.infer<z.ZodObject<S>>, prepared: Prepared): Promise<Applied | ToolResultErr>;
}): McpToolDef<z.ZodObject<S & ConfirmShape>> {
  const input = z.object({ ...spec.fields, ...CONFIRM_FIELDS }).strict() as z.ZodObject<S & ConfirmShape>;
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Two steps: call once to get a preview (nothing is saved), show it to the person, then call again with the same fields plus confirm=true and the preview_id.`,
    kind: "write",
    page: spec.page,
    roles: spec.roles,
    action: spec.action,
    input,
    async run(ctx, raw): Promise<ToolResult> {
      const all = raw as Record<string, unknown>;
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(spec.fields)) fields[k] = all[k];
      const typed = fields as z.infer<z.ZodObject<S>>;
      const key = String(all.idempotency_key);
      const hash = sha256Hex(`${spec.name}:${stableJson(fields)}`);

      if (all.confirm !== true) {
        if (all.preview_id) return fail("invalid", "preview_id was sent without confirm=true. Send confirm=true to apply, or leave both out to preview.");
        const prep = await spec.prepare(ctx, typed);
        if ("ok" in prep) return prep;
        const expires = new Date(ctx.now.getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString();
        const ins = await ctx.db.insert<{ id: string }>("mcp_write_previews", {
          user_id: ctx.userId, tool: spec.name, input: fields as McpJson, input_hash: hash, before_values: prep.before,
          idempotency_key: key, status: "pending", expires_at: expires,
        }, ["id"]);
        if (ins.error || !ins.data) {
          if (ins.error?.code === "23505") {
            const old = await ctx.db.select<PreviewRow>("mcp_write_previews", PREVIEW_COLS).eq("idempotency_key", key).eq("user_id", ctx.userId);
            const row = old.data?.[0];
            if (row && row.tool === spec.name && row.input_hash === hash) {
              return ok({ preview_id: row.id, status: row.status, will_do: prep.summary, before: row.before_values, expires: row.expires_at }, "Preview already exists for this idempotency_key.");
            }
            return fail("invalid", "That idempotency_key was already used for a different change. Use a new key.");
          }
          return fail("error", `Could not save the preview: ${ins.error?.message ?? "no row"}.`);
        }
        return {
          ok: true,
          data: {
            preview_id: ins.data.id,
            will_do: prep.summary,
            before: prep.before,
            expires_in_minutes: Math.round(PREVIEW_TTL_SECONDS / 60),
            next_step: "Show this to the person. If they approve, call the same tool again with the same fields, confirm=true and this preview_id.",
          },
          summary: `Preview only — nothing changed. ${prep.summary}`,
          audit: { status: "preview", before: prep.before },
        };
      }

      // ── confirm ────────────────────────────────────────────────────────────────
      const previewId = typeof all.preview_id === "string" ? all.preview_id : "";
      if (!previewId) return fail("invalid", "confirm=true needs the preview_id from the preview call.");
      const pr = await ctx.db.select<PreviewRow>("mcp_write_previews", PREVIEW_COLS).eq("id", previewId).eq("user_id", ctx.userId);
      if (pr.error) return fail("error", `Could not read the preview: ${pr.error.message}`);
      const p = pr.data?.[0];
      if (!p || p.tool !== spec.name) return fail("not_found", "No such preview for this tool. Call the tool without confirm to get a new preview.");
      if (p.idempotency_key !== key || p.input_hash !== hash) {
        return fail("invalid", "These fields differ from the preview the person approved. Preview again with the new fields.");
      }
      if (p.status === "done") return { ok: true, data: { already_done: true, result: p.result }, summary: "Already applied earlier — nothing changed again.", audit: { status: "replay", after: p.result } };
      if (p.status !== "pending") return fail("invalid", `This preview is ${p.status}. Preview again.`);
      if (Date.parse(p.expires_at) < ctx.now.getTime()) return fail("invalid", "The preview expired (15 minutes). Preview again.");

      const fresh = await spec.prepare(ctx, typed);
      if ("ok" in fresh) return fresh;
      if (stableJson(fresh.before) !== stableJson(p.before_values)) {
        return fail("invalid", "The record changed since the preview (someone else edited it). Preview again to see the current values.");
      }
      const claim = await ctx.db.updateWhere("mcp_write_previews", { id: p.id, status: "pending" }, { status: "applying" }, ["id"]);
      if (claim.error || !claim.data || claim.data.length !== 1) return fail("invalid", "This change is already being applied. Check again in a moment.");

      const done = await spec.apply(ctx, typed, fresh);
      if ("ok" in done) {
        await ctx.db.updateWhere("mcp_write_previews", { id: p.id, status: "applying" }, { status: "failed", result: { error: done.error } }, ["id"]);
        return done;
      }
      await ctx.db.updateWhere("mcp_write_previews", { id: p.id, status: "applying" }, {
        status: "done", result: done.after, confirmed_at: ctx.now.toISOString(),
      }, ["id"]);
      return { ok: true, data: { done: true, result: done.after }, summary: done.summary, audit: { status: "ok", before: fresh.before, after: done.after } };
    },
  });
}

export { ok };
