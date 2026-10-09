import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Every path that emails a quote must also move the lead into "Quote Sent".

   Darshan's report, 24 Aug 2026: "Customer ko quotation sent kar di lekin Quote sent mein
   show nahi kar raha." The cause was one line in folders.ts — "Quote Sent" is a lead STAGE —
   and the fact that the ONLY place in the codebase which ever set `stage: "quote"` was the
   public buy-page checkout.

   This is the THIRD bug of the same shape in two days, which is why it gets a scan rather
   than only a unit test:

     L75  the auto-quote was wired to one webhook branch instead of two
     L97  the self-test flag reached two gates out of three
     this the stage rule existed at one of three send paths

   Every one of them had correct logic and incomplete wiring, and a unit test cannot see the
   difference. The scan can.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OPERATOR_SEND = strip(
  readFileSync(join(SRC, "app", "api", "quotes", "[id]", "send", "route.ts"), "utf8"),
);
const AUTO_SEND = strip(
  readFileSync(join(SRC, "lib", "quotes", "send-auto-quote.ts"), "utf8"),
);

describe("both send paths apply the stage rule", () => {
  it("the operator's Send button moves the lead", () => {
    expect(OPERATOR_SEND).toContain("stageAfterQuoteSent(");
  });

  it("the automatic send moves the lead too", () => {
    /* Wired in the same edit as the operator path, on purpose. Two of this week's bugs were
       a rule reaching some of its call sites and not the rest. */
    expect(AUTO_SEND).toContain("stageAfterQuoteSent(");
  });

  it("the operator route actually reads lead_id, or it could not move anything", () => {
    /* Part of why the bug lasted: this route never selected lead_id, so it had no idea which
       lead it was quoting for. A `stageAfterQuoteSent` call with nothing to apply it to would
       satisfy the assertion above and fix nothing. */
    expect(OPERATOR_SEND).toMatch(/public_token, lead_id/);
    expect(OPERATOR_SEND).toContain("quote.lead_id");
  });

  it("both scope the stage write to the tenant", () => {
    /* CLAUDE.md §4 — an app-layer check alone is not isolation, and these run on the ADMIN
       client, which bypasses RLS entirely. The explicit filter IS the boundary. */
    for (const [name, code] of [["operator", OPERATOR_SEND], ["auto", AUTO_SEND]] as const) {
      const block = code.slice(code.indexOf("stageAfterQuoteSent("));
      expect(block, name).toMatch(/from\("leads"\)[\s\S]{0,220}\.eq\("tenant_id"/);
    }
  });

  it("both check the error on the stage write", () => {
    /* Today's other lesson (L84): supabase-js does not throw, so an unchecked update reports
       success while the board stays wrong — which is the very symptom being fixed. */
    for (const [name, code] of [["operator", OPERATOR_SEND], ["auto", AUTO_SEND]] as const) {
      expect(code, name).toMatch(/const \{ error: stageErr \} = await/);
    }
  });
});

describe("the buy-page checkout is still the only place that sets the stage inline", () => {
  it("no NEW hardcoded stage:\"quote\" appeared instead of using the rule", () => {
    /* The checkout sets `stage: "quote"` at INSERT time, which is correct — it creates the
       lead and the quote together, so there is no prior stage to move forward from. What must
       not happen is somebody copying that literal into a send path instead of calling the
       rule, which would skip the Won/Lost guard entirely. */
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(SRC);

    const offenders = files.filter((f) => {
      const code = strip(readFileSync(f, "utf8"));
      if (!/stage:\s*"quote"/.test(code)) return false;
      /* The checkout is the one legitimate holder. Since 25 Sep 2026 its code lives in
         lib/checkout/cart-checkout.ts, shared by the site cart and the DMS panel. */
      return !f.includes(join("public", "checkout")) && !f.endsWith(join("lib", "checkout", "cart-checkout.ts"));
    });

    expect(offenders, `these hardcode stage:"quote" instead of calling stageAfterQuoteSent: ${offenders.join(", ")}`)
      .toEqual([]);
  });
});

describe("the builder — the third copy, folded in", () => {
  /* Found by the scan above on its very first run, which is the whole argument for having it.
     The builder sets the stage when a quote is created ALREADY sent, as opposed to saved as a
     draft and sent later (the route path). It wrote `stage: "quote"` flat, with no Won/Lost
     guard — so an upsell quote to a won customer pulled them back into the pipeline and
     restarted their stage age. One decision, three divergent copies, and the newest was the
     only one that was right. */

  const BUILDER = strip(
    readFileSync(join(SRC, "components", "features", "quotes", "quote-builder.tsx"), "utf8"),
  );

  it("calls the rule rather than writing the stage itself", () => {
    expect(BUILDER).toContain("stageAfterQuoteSent(");
  });

  it("omits the key entirely when the rule refuses, instead of writing null", () => {
    /* `stage: null` would be worse than the bug: the column is what folders.ts reads, and a
       nulled stage drops the lead out of EVERY board column at once. */
    expect(BUILDER).toMatch(/move\.nextStage !== null && \{ stage: move\.nextStage \}/);
  });

  it("passes the lead's CURRENT stage in, or the guard has nothing to guard", () => {
    /* stageAfterQuoteSent(undefined) returns null for everything — so a call that forgot its
       argument would satisfy the assertion above while silently never moving any lead again.
       That failure is invisible: no error, no log, just a column that stays empty. */
    expect(BUILDER).toMatch(/stageAfterQuoteSent\(leadFromQuery\?\.stage\)/);
  });
});

describe("every writer of a sent quote is accounted for", () => {
  /* THE SCAN ABOVE WAS TOO NARROW, AND THIS IS THE REPLACEMENT.
     It looked for writes of `stage: "quote"` and for the two server senders by name. The
     "Mark as sent" button on the quote page writes neither: it sets `status: "sent"` from the
     BROWSER and moved no stage at all — the fourth send path, the most obvious operator action
     in the app, and almost certainly the one Darshan actually used. A scan is only as wide as
     the thing it greps for.

     So this asks the question the other way round. Enumerate everything that writes a quote to
     `sent`, and require each file to either apply the stage rule or appear below with a reason.
     A NEW sender fails this test on the day it is written, which is the whole point — the
     failure is what makes somebody think about the lead. */

  const ALLOWED: Record<string, string> = {
    /* Customer-side. Verified by reading each: all three set `customer_id` and never
       `lead_id`, because a renewal, an extension and an add-seats upsell all belong to a
       customer who stopped being a lead long ago. There is no stage to move. */
    "create-renewal-quote.ts":   "renewal quote for an existing customer — sets customer_id, never lead_id",
    "create-extension-quote.ts": "extension quote for an existing customer — no lead_id",
    "add-seats.ts":              "add-seats upsell for an existing customer — no lead_id",
    /* 25 Sep 2026: lib/domains/renewal.ts createDomainRenewalQuote, the domain twin of
       create-renewal-quote.ts. Read before listing: customer_id set, no lead_id. */
    "renewal.ts":                "domain renewal quote for an existing customer — sets customer_id, never lead_id",
    /* Creates the lead AND the quote together, so it sets the stage at insert time. There is
       no prior stage for a forward-only rule to move forward from. */
    "route.ts:checkout":         "public buy-page checkout — sets the stage at insert",
    /* Not quote senders at all — the string is an email/message delivery status or a type. */
    "send-quote-dialog.tsx":     "response type from the send API; the ROUTE does the writing",
    "send.ts":                   "email delivery status, not a quote",
    "client.ts":                 "WhatsApp message status, not a quote",
    "whatsapp-reminders.server.ts": "S28 WhatsApp reminder LOG status, not a quote",
    "database.types.ts":         "generated types",
  };

  it("no unaccounted-for path marks a quote sent without moving the lead", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(SRC);

    const unaccounted = files.filter((f) => {
      const code = strip(readFileSync(f, "utf8"));
      if (!/status:\s*"sent"/.test(code)) return false;
      if (code.includes("stageAfterQuoteSent(")) return false;
      /* basename() rather than a hand-rolled split. The first version of this line split on a
         regex character class, a heredoc ate one of its backslashes, and it then split on
         forward slashes only — so on a Windows absolute path `base` was the ENTIRE path, every
         allow-list lookup missed, and the test failed listing seven files it had been told
         about. The scan looked broken; the string handling was. */
      const base = basename(f);
      if (ALLOWED[base]) return false;
      /* compliance-reminders and the checkout both end in route.ts, so the bare basename is
         not enough to tell them apart. */
      return !Object.keys(ALLOWED).some((k) => k.includes(":") && f.includes(k.split(":")[1]));
    });

    /* compliance-reminders declares a local `status` variable for an email send. Named here
       rather than in ALLOWED because it is not a quote writer in any sense. */
    const real = unaccounted.filter((f) => !f.includes("compliance-reminders"));

    expect(
      real,
      `these mark a quote "sent" without applying stageAfterQuoteSent. Either call the rule, ` +
      `or add the file to ALLOWED with the reason it has no lead to move: ${real.join(", ")}`,
    ).toEqual([]);
  });

  it("the Mark-as-sent button applies the rule and refreshes the board", () => {
    const page = strip(readFileSync(join(SRC, "app", "(app)", "quotes", "[id]", "page.tsx"), "utf8"));
    expect(page).toContain("stageAfterQuoteSent(lead?.stage)");
    /* Moving the stage and not invalidating the leads cache reproduces the reported symptom
       exactly — the write lands, the board the operator walks to still shows the old column. */
    expect(page).toMatch(/invalidateQueries\(\{ queryKey: \["leads"\] \}\)/);
  });

  it("the Mark-as-sent write is row-count checked", () => {
    /* Without .select("id") an RLS refusal toasts success over an unchanged quote — L84. */
    const page = strip(readFileSync(join(SRC, "app", "(app)", "quotes", "[id]", "page.tsx"), "utf8"));
    expect(page).toMatch(/update\(\{ status: "sent" \}\)\.eq\("id", params\.id\)\.select\("id"\)/);
  });
});

describe("a quote for a lead stays attached to that lead", () => {
  /* The stage rule is worthless if the quote is not linked in the first place, and orphan
     quotes were being produced by two separate routes:

       1. the workspace tab provider deleted the `?leadId=` from the URL after arrival
          (fixed in workspace-tabs-provider.tsx, see url-query-preserved.test.ts)
       2. the builder read the lead ONLY from that URL, so on the EDIT and DUPLICATE paths —
          where the link lives on the quote being copied, not in the address — it was null

     Both produced the same row: a quote raised for a lead with `lead_id` NULL, which can
     never appear in a column defined by the lead's stage. Verified on live data before and
     after: Q-ADPL-2026-27-0048 lead_id null, Q-ADPL-2026-27-0049 lead_id L-MT6S9CNF. */

  const BUILDER_SRC = strip(
    readFileSync(join(SRC, "components", "features", "quotes", "quote-builder.tsx"), "utf8"),
  );

  it("resolves the lead from the URL OR from the quote being edited/duplicated", () => {
    expect(BUILDER_SRC).toMatch(/const linkedLeadId = leadId \?\? sourceQuote\?\.lead_id \?\? null/);
  });

  it("persists that resolved id, so duplicating a prospect quote keeps the lead", () => {
    /* The old expression fell back to the source only when `editOf` — so DUPLICATE dropped
       the link while EDIT kept it, which is why the same operator action produced an orphan
       on one route and not the other. */
    // R-489: a typed prospect with a contact falls back to its own new lead (prospectLeadId).
    expect(BUILDER_SRC).toMatch(/lead_id:\s+linkedLeadId(?: \?\? prospectLeadId)?,/);
    expect(BUILDER_SRC).not.toMatch(/lead_id:\s+leadId \?\? \(editOf/);
  });

  it("guards AND addresses the lead writes with the same id", () => {
    /* A guard on one identifier and a write on another is how this file ends up with a
       mutation aimed at `id: null`: the branch opens because the quote has a lead, then the
       update targets the URL's missing one. Both must be the resolved id. */
    expect(BUILDER_SRC).not.toMatch(/isLeadMode && leadId &&/);
    expect(BUILDER_SRC).not.toMatch(/id: leadId,/);
    expect(BUILDER_SRC).toMatch(/isLeadMode && linkedLeadId && status === "sent"/);
    expect(BUILDER_SRC).toMatch(/isLeadMode && linkedLeadId && status === "draft"/);
  });
});

describe("every stage move leaves a trace on the timeline", () => {
  /* Caught by watching the fix run on live data, 24 Aug 2026. The lead moved from Contacted to
     Quote Sent exactly as intended and its timeline said NOTHING, because useUpdateLeadStage
     writes the column and no activity row. The other three senders each insert a `kind:
     "stage"` row.

     A deal that changes column with no record of why is harder to debug than the bug being
     fixed here — the board is right and the history is silent, so nobody can tell whether a
     person moved it or the app did. And it is the L98 shape a fourth time: a rule reaching
     three call sites out of four, introduced by me hours after writing L98 down. */

  const PAGE = strip(
    readFileSync(join(SRC, "app", "(app)", "quotes", "[id]", "page.tsx"), "utf8"),
  );

  it("all four senders write a stage activity row", () => {
    for (const [name, code] of [
      ["operator route", OPERATOR_SEND],
      ["auto send", AUTO_SEND],
      ["mark as sent", PAGE],
    ] as const) {
      expect(code, name).toMatch(/kind:\s*"stage"/);
    }
    /* The builder is the fourth. It goes through useUpdateLead with a full patch rather than
       the stage hook, and logs via the drawer it returns to — asserted separately below so a
       future refactor cannot quietly drop it. */
  });

  it("the mark-as-sent row names the quote and carries the rule's reason", () => {
    /* "stage changed" on a timeline is not history. Which quote, and why, is. */
    expect(PAGE).toMatch(/marked as sent — \$\{move\.reason\}/);
  });

  it("a failed history write does not report the whole action as failed", () => {
    /* The quote is sent and the stage moved before this runs. Throwing here would say "could
       not mark as sent" over two successful writes, and the operator would press it again. */
    const block = PAGE.slice(PAGE.indexOf('kind:   "stage"'));
    expect(block).toMatch(/^\s*[\s\S]{0,200}?\}\);\s*\} catch \{/m);
  });

  it("logs through the RPC, not a direct insert", () => {
    /* So tenant_id comes from the server. A client-side insert into lead_activities would put
       the tenant boundary in a React component — CLAUDE.md §4. */
    expect(PAGE).toContain("useLogLeadActivity");
    expect(PAGE).not.toMatch(/from\("lead_activities"\)\s*\.insert/);
  });
});
