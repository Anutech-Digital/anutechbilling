/**
 * The pipeline's wiring, asserted on the SOURCE of sales-agent.server.ts.
 *
 * Two of the four things this file protects are ORDERINGS, and an ordering cannot be tested
 * through the public API without a live Gemini key: run the stages in the wrong order and every
 * function still returns a valid-looking value, just built from the wrong inputs. So this reads
 * the file, the way `telecall-chokepoint.test.ts` does for the same reason.
 *
 * A source test is a blunt instrument and it earns its place here because the failure it catches
 * is silent. If stage 1 runs AFTER the responder's prompt is assembled, the briefing is simply
 * absent from it — no error, no type failure, a slightly worse reply, and the second Gemini call
 * still billed for every message. Nothing else in the suite would notice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "sales-agent.server.ts"), "utf8");

/** Where a call appears in the file. -1 when it is absent. */
const at = (needle: string): number => SRC.indexOf(needle);

describe("stage 1 runs before the responder's prompt is built", () => {
  it("calls runQualifier before buildSalesAgentPrompt", () => {
    /* The briefing is an INPUT to that prompt. Reversed, the qualifier still runs, still costs
       a call, and its verdict reaches nothing — the prompt was already assembled. */
    const qualifier = at("await runQualifier({");
    const prompt = at("buildSalesAgentPrompt({");
    expect(qualifier).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(-1);
    expect(qualifier, "runQualifier must run before the responder's prompt is assembled").toBeLessThan(prompt);
  });

  it("passes the briefing into that prompt", () => {
    expect(SRC).toContain("qualifierBrief: merged ? qualifierBriefing(merged) : undefined");
  });
});

describe("stage 1's verdict is applied before the money and promise guards", () => {
  it("calls narrowByQualification before applyHandoverRules", () => {
    /* Both only tighten, so the order cannot loosen the action. It decides which REASON
       reaches the operator, and the qualifier's names a fact they can act on. */
    const narrow = at("narrowByQualification(parsed.decision.action_required");
    const ruled = at("applyHandoverRules({");
    expect(narrow).toBeGreaterThan(-1);
    expect(narrow).toBeLessThan(ruled);
  });

  it("feeds the NARROWED action into applyHandoverRules, not the model's original", () => {
    /* Otherwise the guards evaluate a quotation that is no longer going out — and the seat
       count they check is the one stage 1 just refused. */
    expect(SRC).toContain("action_required: narrowed.action");
    expect(SRC).toContain("seats: merged?.seats ?? args.lead.seats");
  });

  it("reports both overrules rather than letting one hide the other", () => {
    expect(SRC).toContain("ruled.overruled || narrowed.narrowed");
    expect(SRC).toContain("[narrowed.reason, ruled.reason].filter(Boolean)");
  });
});

describe("the qualifier is penniless BY CONSTRUCTION, not by instruction", () => {
  /** The `runQualifier({ ... })` call site, arguments only. */
  const callSite = (): string => {
    const start = SRC.indexOf("await runQualifier({");
    expect(start, "runQualifier call site not found").toBeGreaterThan(-1);
    const end = SRC.indexOf("});", start);
    return SRC.slice(start, end);
  };

  it("is never handed the catalogue", () => {
    /* THE STRUCTURAL CLAIM OF THIS WHOLE FEATURE. The prompt tells stage 1 it has no prices;
       this asserts it is true. A stage that never receives the catalogue cannot leak a price,
       cannot compute with one, and cannot be argued into naming one — which is a different
       and much stronger guarantee than a model following an instruction. */
    const args = callSite();
    expect(args).not.toMatch(/\bcatalog\b/);
    expect(args).not.toMatch(/authorisedTotals|allowedMoney|msrp|wholesale|slab/i);
  });

  it("is handed only the conversation and what the lead already records", () => {
    const args = callSite();
    /* An allow-list, not a deny-list. A deny-list passes the day somebody adds `netCost:`.
       `[:,]` because a shorthand property (`history,`) has no colon — the first version of
       this matched only `name:` and silently counted six of the seven arguments, which is the
       failure mode an allow-list is supposed to prevent. */
    const passed = [...args.matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]).sort();
    expect(passed).toEqual([
      "apiKey",
      "company",
      "history",
      "incoming",
      "model",
      "recordedProduct",
      "recordedSeats",
      "tenantId",   // R-1877: only the key of the monthly AI-cap counter — no money in it
    ]);
  });

  it("uses its own system prompt, not the responder's", () => {
    /* The responder's prompt contains ten money figures. Reusing it here would undo the
       feature while leaving every other test green. */
    const body = SRC.slice(SRC.indexOf("async function runQualifier"), SRC.indexOf("export async function runSalesAgent"));
    expect(body).toContain("system: QUALIFIER_SYSTEM_PROMPT");
    expect(body).not.toContain("SALES_AGENT_SYSTEM_PROMPT");
  });

  it("extracts at temperature zero", () => {
    const body = SRC.slice(SRC.indexOf("async function runQualifier"), SRC.indexOf("export async function runSalesAgent"));
    expect(body).toContain("temperature: 0,");
  });
});

describe("losing stage 1 costs a safeguard, never a reply", () => {
  it("returns null on failure instead of failing the turn", () => {
    const body = SRC.slice(SRC.indexOf("async function runQualifier"), SRC.indexOf("export async function runSalesAgent"));
    /* No `ok: false` anywhere in it. Stage 1 only ever makes the agent more cautious, so a
       second call that timed out must not become a new way for a customer to get no answer. */
    expect(body).not.toContain("ok: false");
    expect(body).toContain("if (raw === null) return null;");
    expect(body).toContain("return parsed.ok ? parsed.value : null;");
  });

  it("guards every downstream use behind a null check", () => {
    /* `merged` is null whenever stage 1 failed, and each of the three places it is read has to
       fall back to the pre-pipeline behaviour rather than throw or skip the reply. */
    expect(SRC).toContain("const merged = qualification");
    expect(SRC).toContain("merged ? qualifierBriefing(merged) : undefined");
    expect(SRC).toContain("const narrowed = merged");
    expect(SRC).toContain("merged?.seats ?? args.lead.seats");
  });

  it("threads the voice-note doubt into stage 1", () => {
    /* Two guards need it now: decideAutoSend refuses a quote built on a transcribed seat
       count, and the qualifier refuses to trust one at all. The second prevents the draft; the
       first only stops it going out. */
    expect(SRC).toContain("{ heardNotWritten: args.heardNotWritten }");
  });
});
