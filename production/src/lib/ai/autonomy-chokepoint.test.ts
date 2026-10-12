import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AI_ACTIONS, type AiAction, type AiActionSpec } from "./autonomy";

/* ─────────────────────────────────────────────────────────────────────────────
   Is the brake actually connected?

   The dial and the log are pure and well tested, and that proves nothing about whether any
   send goes through them. This file is the part that would catch the real failure: a
   registry full of actions, a kill switch that resolves correctly, and five crons that
   never ask.

   A source scan, because the thing being checked is WIRING. Rendering these routes would
   need Supabase, Resend and Cloud Scheduler stubbed, and would still not answer the
   question — "does this call site pass `automated`" reads directly in the source and not at
   all in a mock.

   `send.ts` states the cost of the opt-in design out loud: "a new automated caller that
   forgets this is ungated. The test in autonomy-chokepoint.test.ts scans for that." This is
   that test, and the comment is a promise it has to keep.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the chokepoint itself", () => {
  it("checks autonomy BEFORE handing anything to the transport", () => {
    /* Order is the whole guarantee. Resolving after the send would log a refusal for a mail
       already gone. */
    const code = strip(read("lib/email/send.ts"));
    const gate = code.indexOf("resolveAutonomy(");
    const send = code.indexOf("sendEmailInner(msg)");
    expect(gate).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(0);
    expect(gate).toBeLessThan(send);
  });

  it("records a refusal in email_log instead of returning silently", () => {
    /* A refused send that left no trace would make the switch indistinguishable from an
       outage: mail stops and nothing anywhere says the app chose to stop. */
    const code = strip(read("lib/email/send.ts"));
    const gateBlock = code.slice(code.indexOf("resolveAutonomy("), code.indexOf("sendEmailInner(msg)"));
    expect(gateBlock).toContain("recordEmail(");
    expect(gateBlock).toContain("logAiAction(");
  });

  it("distinguishes a hold from a skip when it logs", () => {
    /* Both refuse the send; only one means "a person still has to do this". Collapsing them
       would bury the queue of things waiting on the operator. */
    expect(strip(read("lib/email/send.ts"))).toMatch(/"hold" \? "held" : "skipped"/);
  });
});

describe("every gateable action in the registry is actually wired somewhere", () => {
  /* The failure this catches: declaring an action, shipping the dial, and never asking. A
     registry entry nobody enforces is worse than no entry — it reads as a control the
     operator does not have. `compliance.send` was removed for exactly this reason once it
     turned out to be an internal reminder rather than a customer send. */
  const ALL_SOURCE = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          out.push(readFileSync(p, "utf8"));
        }
      }
    };
    walk(SRC);
    return strip(out.join("\n"));
  })();

  const SENDING_ACTIONS = (Object.keys(AI_ACTIONS) as AiAction[]).filter((a) => a.endsWith(".send"));

  it.each(SENDING_ACTIONS)("%s is passed to sendEmail somewhere", (action) => {
    /* Widened deliberately. `AI_ACTIONS` is `as const`, so once no action is declared `off`
       TypeScript narrows `spec.today` to "auto" | "hold" and the comparison below becomes a
       compile error rather than a false branch. That happened on 24 Aug 2026 when
       `followup.send` moved from `off` to `hold`.

       The branch is kept, not deleted, because it is the affordance for the NEXT action
       somebody declares before building it — deleting it would force the author of that action
       to either wire a fake call site or edit this test, and both are how a green suite starts
       lying. */
    const spec: AiActionSpec = AI_ACTIONS[action];
    if (spec.today === "off") {
      /* Not built yet, and `off` says so. Wiring arrives with the feature — asserting a call
         site now would force a fake one, which is how a green test starts lying. */
      expect(spec.today).toBe("off");
      return;
    }
    /* Two accepted shapes, and the second one needed adding on 24 Aug 2026.
         action: "x.send"      — passed straight to sendEmail, as the five crons do
         sendAction: "x.send"  — handed to lib/ai/actions/quote-dispatcher.ts, which forwards it
       The dispatcher is one send path serving two permissions (a reply and a follow-up nudge),
       so it necessarily passes `automated: { action: args.sendAction }` — a VARIABLE, which a
       source scan cannot follow. Accepting only the literal would have forced either a
       duplicated send path or an ungated one.

       Broadening a scan weakens it, so the forwarding is pinned separately in the test below.
       Without that pair, this could match a `sendAction` that goes nowhere. */
    const wired =
      ALL_SOURCE.includes(`action: "${action}"`) ||
      ALL_SOURCE.includes(`sendAction: "${action}"`);
    expect(wired, `${action} is declared "${spec.today}" but nothing passes it`).toBe(true);
  });

  it("the dispatcher really forwards sendAction into the gate", () => {
    /* The other half of the broadened scan above. `sendAction: "followup.send"` at a call site
       only proves the gate is reached if the dispatcher actually hands that value to sendEmail
       and to resolveAutonomy. Pinned on the source for the same reason as everything else in
       this file: the failure is a missing hand-off, which reads in the source and not in a
       mock. */
    const code = strip(read("lib/ai/actions/quote-dispatcher.ts"));
    expect(code).toContain("automated: { tenantId: args.tenantId, action: args.sendAction, entityId: args.leadId }");
    expect(code).toContain("resolveAutonomy(args.sendAction, policy)");
  });

  it("the WhatsApp path is gated too, since sendEmail cannot gate it", () => {
    /* sendEmail is the chokepoint for mail only. sendWhatsApp posts straight to Meta, so an
       agent that respected the dial on email and ignored it on WhatsApp would be a brake in
       name only — and the kill switch is what somebody reaches for when a wrong price has
       already gone out. */
    const code = strip(read("lib/ai/actions/quote-dispatcher.ts"));
    const waAt = code.indexOf("sendCustomerWhatsApp({");   // R-897: the WhatsApp send now goes through lib/messaging
    const gateAt = code.indexOf("resolveAutonomy(args.sendAction, policy)");
    expect(waAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt, "the dial must be resolved BEFORE the message reaches Meta").toBeLessThan(waAt);
  });
});

describe("the five unattended crons", () => {
  const CRON = join(SRC, "app", "api", "cron");

  /* Measured 23 Aug 2026: these are the routes that call sendEmail, and before this change
     none of them could be stopped from inside the app. */
  it.each([
    ["invoice-dunning",    "dunning.send"],
    ["renewals",           "renewal.send"],
    ["trial-expiry",       "trial.send"],
    ["birthday-greetings", "greeting.send"],
  ])("%s gates its customer send with %s", (dir, action) => {
    const file = join(CRON, dir, "route.ts");
    expect(existsSync(file), `${dir} route is missing`).toBe(true);
    const code = strip(readFileSync(file, "utf8"));
    expect(code).toContain(`action: "${action}"`);
  });

  it("leaves compliance-reminders ungated, because it writes to the tenant's own team", () => {
    /* The line this draws: the dial stops what the app sends OUT to other people, never what
       it says TO YOU. A kill switch that also muted "your GSTR-1 is due" would turn one bad
       afternoon into a late fee. */
    const code = strip(readFileSync(join(CRON, "compliance-reminders", "route.ts"), "utf8"));
    expect(code).not.toContain("automated:");
    expect(Object.keys(AI_ACTIONS)).not.toContain("compliance.send");
  });
});

describe("the fail-closed direction", () => {
  it("treats an unreadable kill switch as ON", () => {
    /* Asserted on the source because the alternative — a Supabase failure injected through
       a mock — would test the mock. A missing answer to "am I switched off?" must not read
       as "carry on": that is precisely the moment somebody is trying to stop something. */
    const code = read("lib/ai/autonomy.server.ts");
    expect(code).toMatch(/killSwitch: true, modes: \{\} \}/);
    expect(code).toMatch(/failing CLOSED/);
  });

  it("treats an unreadable per-action dial as NOT configured", () => {
    /* The opposite direction, on purpose. An empty dial is the normal state, so a read
       failure there must behave like "not configured" rather than silently stopping five
       working crons. */
    const code = strip(read("lib/ai/autonomy.server.ts"));
    expect(code).toMatch(/could not read the per-action dial[\s\S]{0,120}return \{ killSwitch, modes: \{\} \}/);
  });

  it("never lets a logging failure break the work it was recording", () => {
    const code = strip(read("lib/ai/autonomy.server.ts"));
    expect(code).toMatch(/catch \(err\)[\s\S]{0,160}console\.error/);
  });
});
