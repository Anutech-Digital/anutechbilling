/**
 * R-2775 — the prompt-injection fixture (lib/ai/help-loop-injection-fixture.ts, 15 cases, the seed
 * of H-10's eval set) run through the loop with the real runner. tool_result cases: the hostile text is
 * what a tool read; it must stay inside ONE untrusted wrapper and start nothing. user_text cases: the
 * person's words cannot change the tenant a tool sees.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { HELP_INJECTION_CASES } from "../help-loop-injection-fixture";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ supabaseKey: jwt("anon"), from: () => { throw new Error("no table"); } }) }));

const { openHelpSession } = await import("./session");
const { defineHelpTool } = await import("./types");
const { buildRegistry, helpToolsFor } = await import("./registry");
const { runHelpTools } = await import("./runner");
const { runToolLoop } = await import("./loop");
const { HELP_UNTRUSTED_BEGIN, HELP_UNTRUSTED_END } = await import("./untrusted");
import type { LoopReply, LoopStep } from "./loop";

let hostile = "";
const seen = { owner: 0, find: [] as string[], tenants: [] as string[] };
const mk = (over: Record<string, unknown>) => defineHelpTool({ roles: ["owner"], tier: "read", page: "/customers", label: "Open customers", ...over } as never);
const REG = buildRegistry([
  mk({ name: "find_thing", describe: "find", input: z.object({ q: z.string().max(40) }).strict(), async run({ q }: { q: string }, ctx: { tenantId: string }) { seen.find.push(q); seen.tenants.push(ctx.tenantId); return { text: hostile, sources: [] }; } }),
  mk({ name: "owner_only_tool", describe: "owner", input: z.object({}).strict(), async run() { seen.owner++; return { text: "secret", sources: [] }; } }),
] as never);

const use = (name: string, input: unknown): LoopReply => ({ stop: "tool_use", text: "", raw: null, calls: [{ id: "tu_1", name, input }] });
const end = (): LoopReply => ({ stop: "end", text: "{}", calls: [], raw: null });

async function drive(input: unknown) {
  const steps: LoopStep[][] = [];
  let n = 0;
  const session = openHelpSession();
  const run = await runToolLoop({
    tools: helpToolsFor("owner", REG),
    askModel: async (ask) => { steps.push([...ask.steps]); return n++ === 0 ? use("find_thing", input) : end(); },
    runTools: (calls) => runHelpTools(session, { userId: "u-1", tenantId: A, role: "owner" }, calls, REG),
  });
  return { run, steps };
}

describe("injection fixture", () => {
  it("has at least 10 cases with unique ids, all three kinds", () => {
    expect(HELP_INJECTION_CASES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(HELP_INJECTION_CASES.map((c) => c.id)).size).toBe(HELP_INJECTION_CASES.length);
    expect(new Set(HELP_INJECTION_CASES.map((c) => c.kind))).toEqual(new Set(["tool_result", "final_answer", "user_text"]));
  });

  for (const c of HELP_INJECTION_CASES.filter((x) => x.kind === "tool_result")) {
    it(`tool_result ${c.id}: one wrapper, nothing from the text is run`, async () => {
      hostile = c.payload; seen.owner = 0; seen.find = []; seen.tenants = [];
      const { run, steps } = await drive({ q: "acme" });
      const text = steps[1][0].results[0].text;
      expect(run.outcome).toBe("answer");
      expect(text.split(HELP_UNTRUSTED_BEGIN).length - 1).toBe(1);
      expect(text.split(HELP_UNTRUSTED_END).length - 1).toBe(1);
      expect(text.split("<<<").length - 1).toBe(2);
      expect(text.endsWith(">>>")).toBe(true);
      expect(text.length).toBeLessThanOrEqual(12_000);
      for (const bad of c.mustNot) expect(text, `must not contain ${JSON.stringify(bad)}`).not.toContain(bad);
      const open = text.indexOf(HELP_UNTRUSTED_BEGIN);
      const close = text.lastIndexOf(HELP_UNTRUSTED_END);
      for (const keep of c.staysInside ?? []) {
        expect(text.indexOf(keep), keep).toBeGreaterThan(open);
        expect(text.lastIndexOf(keep), keep).toBeLessThan(close);
        expect(text.split(String.fromCharCode(10))[0]).not.toContain(keep); // never in the app's own line
      }
      expect(seen.owner).toBe(0);
      expect(steps).toHaveLength(2); // the model asked once; the result started nothing
      expect(seen.find).toEqual(["acme"]);
    });
  }

  for (const c of HELP_INJECTION_CASES.filter((x) => x.kind === "user_text")) {
    it(`user_text ${c.id}: the tool sees the session's tenant only; the words cannot be a tenant key`, async () => {
      hostile = "ok"; seen.find = []; seen.tenants = [];
      const { steps } = await drive({ q: c.payload.slice(0, 40) });
      expect(seen.tenants).toEqual([A]);
      const withKey = await drive({ q: "x", tenant_id: "bbbbbbbb-0000-4000-8000-000000000002" });
      expect(withKey.steps[1][0].results[0].isError).toBe(true);
      expect(steps).toHaveLength(2);
    });
  }
});
