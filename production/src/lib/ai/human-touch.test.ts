import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   "Has a person picked this thread up?" must not be answered by the app's own footprints.

   Found 24 Aug 2026 by reading run-auto-reply before asking Pardeep to re-run a self-test.
   The inbound webhook writes its own `note` a fraction of a second after filing the
   customer's email ("No new quote from this reply — …", route.ts:737), or an `email_out` row
   when the auto-quote does go out. Both are newer than the inbound message, both matched the
   `kind` filter, and both are this app. So the second enquiry in a thread would hold the reply
   saying "a person has picked this thread up" when nobody had.

   A wrong REASON is worse than a wrong outcome here: the reason is what somebody reads when
   deciding whether to trust the automation. Same failure as L97, where a marked self-test was
   held for the own-address rule instead of the dial.

   `created_by` is the discriminator and it needed no migration. Checked against live data
   before relying on it: call ×5, email ×3, note ×6 all carry a created_by; note ×9,
   email_in ×14, email_out ×1 and quote ×1 are all NULL.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* R-1606 (19 Oct 2026): these pins read run-auto-reply.ts, which the webhook stopped calling
   when run-sales-agent.ts replaced it — so they guarded a dead file. They now read the sales
   agent, which runs the same human-touch query (checkReplyGates) on every inbound reply. */
const RUN = strip(readFileSync(join(SRC, "lib", "ai", "run-sales-agent.ts"), "utf8"));

describe("the human-touch check counts only humans", () => {
  it("requires created_by to be set", () => {
    expect(RUN).toMatch(/\.not\("created_by", "is", null\)/);
  });

  it("applies it to the SAME query as the kind filter, not a separate one", () => {
    /* Two queries would let one of them drift. The filter has to sit on the chain that
       produces `humanIsHandlingIt`, between the kind list and the timestamp bound. */
    const start = RUN.indexOf('.in("kind", ["call"');
    const end = RUN.indexOf("humanIsHandlingIt:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const q = RUN.slice(start, end);
    expect(q).toContain('.not("created_by", "is", null)');
    expect(q).toContain('.gt("created_at"');
  });

  it("still bounds the window to messages newer than the customer's last one", () => {
    /* Dropping this would make any old human note hold every future reply forever. */
    expect(RUN).toMatch(/\.gt\("created_at", lastIn\?\.created_at \?\? "1970-01-01"\)/);
  });

  it("still asks about the kinds a person actually does", () => {
    /* email_in is deliberately absent — the customer writing IS the thing being answered, so
       counting it would mean never replying to anybody. */
    expect(RUN).toMatch(/\.in\("kind", \["call", "whatsapp", "note", "email_out"\]\)/);
    expect(RUN).not.toMatch(/\.in\("kind", \[[^\]]*"email_in"/);
  });
});

describe("the app's own writes really are anonymous", () => {
  /* The fix is only sound while automated writes leave created_by NULL. If somebody later
     gives the service-role client a user id, the discriminator silently inverts and this bug
     comes back — so the assumption is pinned here rather than left in a comment. */

  it("the webhook's own activity inserts never set created_by", () => {
    const hook = strip(
      readFileSync(join(SRC, "lib", "inbound", "ingest.ts"), "utf8"),
    );
    const inserts = hook.split('from("lead_activities")').slice(1);
    expect(inserts.length).toBeGreaterThan(0);
    for (const chunk of inserts) {
      expect(chunk.slice(0, 300)).not.toContain("created_by");
    }
  });

  it("the sales agent's own timeline notes do not set it either", () => {
    const inserts = RUN.split('from("lead_activities").insert(').slice(1);
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.some((c) => c.slice(0, 300).includes('kind: "note"'))).toBe(true);
    for (const chunk of inserts) {
      expect(chunk.slice(0, chunk.indexOf("})"))).not.toContain("created_by");
    }
  });
});

describe("the audit log records what the automation DID, not only what it refused", () => {
  /* Measured 24 Aug 2026, right after a self-test emailed a real quote. The lead's timeline
     said "Q-ADPL-2026-27-0054 emailed automatically to pardeep@anutech.in — ₹95,580", and
     `select count(*) from ai_action_log where outcome='did'` returned 0 across the WHOLE
     table. logAiAction was called only inside the refusal branch of the send chokepoint.

     Backwards for an audit log, and not cosmetic: this table is what /automation shows and
     what somebody reads before widening a dial. Nothing but "skipped" and "held" makes working
     automation look like automation that has never fired — which is precisely why Pardeep
     asked whether his sales agent existed at all. */

  const SEND = strip(readFileSync(join(SRC, "lib", "email", "send.ts"), "utf8"));

  it("logs an outcome after the send, not just before it", () => {
    /* The refusal log sits before sendEmailInner; this one must sit after, or it is recording
       an intention rather than a result. */
    const innerAt = SEND.indexOf("await sendEmailInner(msg);");
    expect(innerAt).toBeGreaterThan(0);
    expect(SEND.slice(innerAt)).toContain("logAiAction(");
  });

  it("distinguishes a send that failed from one that went", () => {
    /* "did" on a failed send would be the worst possible row in this table: it would report a
       customer was emailed when the provider rejected it. */
    const after = SEND.slice(SEND.indexOf("await sendEmailInner(msg);"));
    expect(after).toMatch(/outcome:\s*result\.status === "failed" \? "failed" : "did"/);
  });

  it("a caller that writes its own row can skip the success row (refusals stay unconditional)", () => {
    expect(SEND).toMatch(/if \(msg\.automated && !msg\.automated\.logsItsOwnOutcome\)/);
  });

  it("no automated caller sets the opt-out", () => {
    /* R-1606: the one documented exception was run-auto-reply.ts, deleted as dead code. Every
       automated send now gets its did/failed row from the chokepoint. A caller that sets the
       flag must also log its own outcome, or the flag turns one row into NO row — so a new
       one has to be added here on purpose, with that proof. Comments stripped: prose that
       names the flag is not a caller. */
    const callers: string[] = [];
    for (const rel of readdirSync(SRC, { recursive: true }) as string[]) {
      const f = rel.replace(/\\/g, "/");
      if (!/\.(ts|tsx)$/.test(f) || /\.test\.tsx?$/.test(f) || f === "lib/email/send.ts") continue;
      if (strip(readFileSync(join(SRC, f), "utf8")).includes("logsItsOwnOutcome")) callers.push(f);
    }
    expect(callers).toEqual([]);
  });
});
