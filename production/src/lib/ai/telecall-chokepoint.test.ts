import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AI_ACTIONS, resolveAutonomy, type AiActionSpec } from "./autonomy";

/* ─────────────────────────────────────────────────────────────────────────────
   Is the brake connected to the phone?

   `autonomy-chokepoint.test.ts` scans every action whose name ends in `.send`, because until
   now every gateable action WAS a send. `telecall.place` is not one — it places a call — so
   that file's loop does not cover it, and an action the registry declares but nothing enforces
   is worse than no action at all: it reads as a control the operator does not have. This file
   is that coverage.

   A source scan, for the same reason the original states: the thing being checked is WIRING.
   "Does this call site resolve the dial before contacting the vendor" reads directly in the
   source and not at all in a mock.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DISPATCHER = "lib/ai/actions/telecall-dispatcher.ts";

describe("the registry entry", () => {
  it("declares telecall.place, and declares it hold", () => {
    const spec: AiActionSpec = AI_ACTIONS["telecall.place"];
    expect(spec.today).toBe("hold");
    expect(spec.supports).toContain("off");
    expect(spec.supports).toContain("auto");
  });

  it("is not on auto for a workspace that has configured nothing", () => {
    /* Measured on production 25 Aug 2026: `ai_autonomy` holds ZERO rows, so every action falls
       to its declared default. That is exactly why `quote.send` is live on `auto` — nobody
       switched it on, the code default is. This asserts the new action does not join it. */
    expect(resolveAutonomy("telecall.place", { killSwitch: false }).mode).toBe("hold");
  });

  it("is silenced entirely by the kill switch", () => {
    expect(resolveAutonomy("telecall.place", { killSwitch: true }).mode).toBe("off");
  });
});

describe("the dispatcher is the only door, and the dial is on it", () => {
  it("resolves the dial BEFORE the vendor is contacted", () => {
    /* Order is the whole guarantee. Resolving after the call would log a refusal for a phone
       that has already rung — and unlike an email, there is no version of that which can be
       followed by a correction. */
    const code = strip(read(DISPATCHER));
    const gate = code.indexOf('resolveAutonomy("telecall.place"');
    const dial = code.indexOf("placeCall(provider");
    expect(gate).toBeGreaterThan(0);
    expect(dial).toBeGreaterThan(0);
    expect(gate, "the dial must be resolved before the vendor is asked").toBeLessThan(dial);
  });

  it("only reaches the vendor when the mode is auto", () => {
    /* The `hold` branch must RETURN. A branch that files a held row and then falls through to
       placeCall would be a brake that logs its own failure to stop anything. */
    const code = strip(read(DISPATCHER));
    const holdBranch = code.indexOf('if (verdict.mode !== "auto")');
    const providerLookup = code.indexOf("resolveTelecallProvider()");
    expect(holdBranch).toBeGreaterThan(0);
    expect(holdBranch).toBeLessThan(providerLookup);
    const between = code.slice(holdBranch, providerLookup);
    expect(between, "the hold branch must return before the provider is resolved").toContain("return");
  });

  it("records a refusal rather than returning silently", () => {
    /* A held call that left no trace would be indistinguishable from a cron that never ran —
       the same argument send.ts makes for writing refusals into email_log. */
    const code = strip(read(DISPATCHER));
    const holdBranch = code.slice(code.indexOf('if (verdict.mode !== "auto")'));
    expect(holdBranch).toContain("recordTelecall(");
    expect(holdBranch).toContain("logAiAction(");
    expect(holdBranch).toContain('status: "held"');
  });

  it("distinguishes a hold from a skip when it logs", () => {
    /* Both refuse the call; only one means "a person still has to do this". Collapsing them
       would bury the operator's queue. */
    expect(strip(read(DISPATCHER))).toContain('verdict.mode === "hold" ? "held" : "skipped"');
  });

  it("puts the whole script on the held row, so hold is useful rather than empty", () => {
    /* The bargain that stops anybody moving the dial merely to get value out of the feature:
       at hold the operator can read exactly what would have been said and ring by hand. */
    const code = strip(read(DISPATCHER));
    const planAt = code.indexOf("const callPlan");
    const holdAt = code.indexOf('if (verdict.mode !== "auto")');
    expect(planAt).toBeGreaterThan(0);
    expect(planAt, "the script must be built before the hold branch files it").toBeLessThan(holdAt);
    expect(code).toContain("system_prompt: built.systemPrompt");
    expect(code).toContain("authorised_figures: built.authorisedFigures");
  });
});

describe("nothing else may reach the vendor", () => {
  it("placeCall is imported by the dispatcher and by nothing else", () => {
    /* The failure this catches: a second call path added later that dials directly and never
       asks the dial. `sendWhatsApp` has exactly this shape of risk, which is why
       quote-dispatcher.ts had to gate it by hand. */
    const callers = ["app/api/v1/telecalling/make-call/route.ts",
                     "app/api/v1/telecalling/webhook/route.ts",
                     "app/api/cron/ai-telecall-renewals/route.ts"];
    for (const file of callers) {
      expect(existsSync(join(SRC, file)), `${file} is missing`).toBe(true);
      expect(strip(read(file)), `${file} must go through dispatchTelecall, not placeCall`)
        .not.toContain("placeCall(");
    }
    expect(strip(read(DISPATCHER))).toContain("placeCall(provider");
  });

  it("Cold Calling asks the kill switch before it dials (R-1662)", () => {
    /* Cold-call contacts are not leads, so the campaign tick dials itself — but never past the
       workspace brake. */
    const code = strip(read("server/coldcall/coldcall.server.ts"));
    const brake = code.indexOf('resolveAutonomy("telecall.place"');
    const dial = code.indexOf("placeCall(");
    expect(brake).toBeGreaterThan(0);
    expect(brake).toBeLessThan(dial);
    expect(code).toContain('verdict.mode === "off"');
  });

  it.each([
    ["app/api/v1/telecalling/make-call/route.ts"],
    ["app/api/cron/ai-telecall-renewals/route.ts"],
  ])("%s dispatches through the gated path", (file) => {
    expect(strip(read(file))).toContain("dispatchTelecall(");
  });
});

describe("the cron", () => {
  const CRON = "app/api/cron/ai-telecall-renewals/route.ts";

  it("fails closed when no cron secret is configured", () => {
    const code = strip(read(CRON));
    expect(code).toContain('process.env.CRON_SECRET');
    expect(code).toContain("503");
    expect(code).toContain("timingSafeEqualStr(");
  });

  it("targets an exact date rather than a five-day window", () => {
    /* A `<= 5 days` window makes every subscription eligible on five consecutive days, and the
       24-hour gap would let four of those through — four automated calls in four days about one
       renewal. An exact date makes each subscription a candidate exactly once. */
    const code = strip(read(CRON));
    expect(code).toContain('.eq("renewal_date", target)');
    expect(code).not.toContain('.lte("renewal_date"');
  });

  it("reports what it could not reach instead of truncating silently", () => {
    const code = strip(read(CRON));
    expect(code).toContain("skipped_over_cap");
    expect(code).toContain("MAX_PER_RUN + 1");
  });

  it("computes today in IST, not in the server's timezone", () => {
    /* Cloud Run runs in UTC, so `toISOString().slice(0,10)` returns YESTERDAY for every run
       before 05:30 IST — and this cron runs in the morning. `renewal_date` is a DATE column
       filled in by people working in IST. */
    const code = strip(read(CRON));
    expect(code).toContain("istParts(now).ymd");
  });

  it("places calls one at a time", () => {
    /* Forty simultaneous rings out of one caller ID is what a vendor's abuse detection exists
       to stop. Slower is the correct shape. */
    const code = strip(read(CRON));
    expect(code).toContain("for (const sub of batch)");
    expect(code).not.toContain("Promise.all(batch");
  });
});

describe("the webhook", () => {
  const HOOK = "app/api/v1/telecalling/webhook/route.ts";

  it("verifies the signature before it reads anything", () => {
    const code = strip(read(HOOK));
    const verifyAt = code.indexOf("const verdict = verify(req, rawBody)");
    const parseAt = code.indexOf("JSON.parse(rawBody)");
    expect(verifyAt).toBeGreaterThan(0);
    expect(verifyAt).toBeLessThan(parseAt);
  });

  it("takes the tenant from the row it wrote, never from the payload", () => {
    /* A signature proves a payload is AUTHENTIC, not CORRECT. A mis-scripted vendor agent
       echoing the wrong metadata would, on a body-trusting endpoint, write a customer's
       transcript — and possibly a quotation — into another reseller's workspace. */
    const code = strip(read(HOOK));
    expect(code).toContain("findTelecallByProviderCallId(call.providerCallId)");
    expect(code).toContain("tenantId: row.tenantId");
    expect(code).not.toContain("tenantId: call.tenantId");
  });

  it("does not act twice on a retried webhook", () => {
    /* Both vendors retry on a slow or non-2xx response. Without this, one conversation becomes
       two quotations. */
    const code = strip(read(HOOK));
    const guard = code.indexOf("recorded.row.alreadyFinished");
    const quote = code.indexOf("dispatchSalesDecision(");
    expect(guard).toBeGreaterThan(0);
    expect(guard, "the repeat guard must come before anything is dispatched").toBeLessThan(quote);
  });

  it("routes its quotation through the gated dispatcher, not through a second quote path", () => {
    /* So a quotation arising from a phone call is gated exactly as one arising from an email,
       and turning telecalling on cannot become a way around the brake on writing to customers. */
    const code = strip(read(HOOK));
    expect(code).toContain("dispatchSalesDecision(");
    expect(code).toContain('sendAction: "reply.send"');
    expect(code, "quotes are allocated by autoQuoteForLead, never here")
      .not.toContain("next_document_number");
  });

  it("lets a money violation override whatever the call appeared to conclude", () => {
    /* A quote built on top of a call where the wrong price was spoken would put the wrong
       figure in writing too. */
    const code = strip(read(HOOK));
    expect(code).toContain('money.ok ? classification.action : "handed_to_human"');
  });
});
