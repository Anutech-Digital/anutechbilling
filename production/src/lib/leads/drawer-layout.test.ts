import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   The lead drawer's shape, from three requests on 22–23 Aug 2026:

     "follow ups and conversation tab ke page ke top le jayo"
     "is section ko bhi kahin adjust karo logically"
     "email conversation ka tab alag hi bana dete hai"

   A source scan rather than a render test. The drawer is ~1,100 lines of JSX inside a
   3,800-line page; mounting it would need the whole query layer stubbed, and most of
   what is protected here is an ORDER or an ABSENCE — both of which read plainly in the
   source and not at all in a jsdom snapshot. Same approach route-map.test.ts and the
   grid-flow scan take.

   What makes these worth pinning is that two of the three changes had a version that
   looked applied and was not:

     - the default tab, keyed on `lead?.id` alone, ran while `activities` was still
       empty and never re-ran, so every lead WITH history still opened on Details;
     - the "first contact" CTA read `lead.stage` and nothing else, so a lead with 15
       emails in its thread still offered to introduce itself.
   ───────────────────────────────────────────────────────────────────────────── */

/* S35 (28 Sep 2026): (app)/leads/page.tsx was split into feature files. These are every
   file that came out of it, read in the order the code sat in the OLD file (page, drawer
   header → sheet → tabs → footer, the next-step rules, then the row menu and the list), so
   every "X comes before Y" and "exactly N of" assertion below still means what it meant
   when this was one file. */
const FEATURE = ["src", "components", "features", "leads"];
const DRAWER_FILES = [
  ["src", "app", "(app)", "leads", "page.tsx"],
  [...FEATURE, "leads-page-dialogs.tsx"],
  [...FEATURE, "lead-detail-header.tsx"],
  [...FEATURE, "lead-detail-sheet.tsx"],
  [...FEATURE, "lead-detail-details-tab.tsx"],
  [...FEATURE, "lead-detail-activity-tab.tsx"],
  [...FEATURE, "lead-detail-email-tab.tsx"],
  [...FEATURE, "lead-detail-followups-tab.tsx"],
  [...FEATURE, "lead-detail-footer.tsx"],
  ["src", "lib", "leads", "next-action.ts"],
  [...FEATURE, "lead-row-actions.tsx"],
  [...FEATURE, "lead-list-view.tsx"],
  [...FEATURE, "lead-list-row.tsx"],
];
const page = DRAWER_FILES
  .map((parts) => readFileSync(join(process.cwd(), ...parts), "utf8"))
  .join("\n");

/* Comments STRIPPED. Several assertions below are about a token being absent, or about
   where it sits — and every one of those tokens is also NAMED in a comment explaining why
   it moved or went. A blunt scan of the raw source failed on the explanation, which would
   have pushed the reasoning out of the file to satisfy the test. Same guard
   sentry-client.test.ts uses, for the same reason. Assert prose against `page`, code
   against `code`. */
const code = page
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const TABS = '(["email", "activity", "followups", "details"] as const)';

describe("lead drawer — tab order and position", () => {
  it("leads with Email and ends with Details", () => {
    /* Order IS the request. Email is the exchange with the customer; Details is
       reference, and reference does not go first. */
    expect(code).toContain(TABS);
  });

  it("renders the tabs OUTSIDE the scrolling body", () => {
    /* More than a reorder: pinned tabs are reachable from any depth of a long thread.
       Inside the scroll container they sat below four blocks, so switching tabs meant
       scrolling back up to find them. */
    const tabs = code.indexOf(TABS);
    const scroll = code.indexOf('className="flex-1 overflow-y-auto p-5 space-y-4"');
    expect(tabs).toBeGreaterThan(0);
    expect(scroll).toBeGreaterThan(0);
    expect(tabs).toBeLessThan(scroll);
  });

  it("keeps the tabs below the header, so identity stays on screen", () => {
    /* The header was already outside the scroll. A reply composed without knowing who it
       is going to is how the wrong name reaches a customer. */
    expect(code.indexOf("</SheetHeader>")).toBeLessThan(code.indexOf(TABS));
  });

  it("gives each tab a 44px touch target", () => {
    /* CLAUDE.md §20. The old py-2 gave ~32px, which on a 375px phone is a miss waiting
       to happen. */
    expect(code).toMatch(/min-h-11 shrink-0 whitespace-nowrap px-2\.5/);
  });

  it("lets the strip scroll instead of trusting that four labels fit", () => {
    /* Four labels with counts measure ~400px against a 375px phone by estimate, and an
       estimate is not a layout guarantee. A wrapped or clipped tab bar is the exact
       failure this redesign set out to fix, so it scrolls and every label stays whole. */
    expect(code).toMatch(/flex gap-1 overflow-x-auto border-b border-hairline/);
    expect(code).toContain("[&::-webkit-scrollbar]:hidden");
  });

  it("marks the active tab for assistive tech, not just visually", () => {
    /* Colour and a border alone say nothing to a screen reader. */
    expect(code).toMatch(/aria-current=\{drawerTab === t \? "page" : undefined\}/);
  });
});

describe("lead drawer — which tab a lead opens on", () => {
  it("opens on Email when there is a thread", () => {
    /* A live exchange with the customer IS what the lead is about. The merged Activity
       stream is history, and history is not what you open a live thread for. */
    expect(code).toMatch(/if \(threadSummary\.total > 0\) \{[\s\S]{0,120}setAutoTab\("email"\);/); // R-342: auto-pick sets autoTab; a chosen tab is in ?ltab=
  });

  it("falls back to Activity, not to an empty Email tab", () => {
    /* A lead whose whole history is two calls and a quote has no thread to read. */
    expect(code).toContain('setAutoTab("activity");');
  });

  it("re-runs when either count changes, not only when the lead does", () => {
    /* THE BUG IN THE OBVIOUS VERSION. Both counts arrive asynchronously: keyed on
       lead?.id alone the effect fires against empty lists, picks Details, and never
       re-runs — so every lead with a conversation would still have opened on Details
       and the change would have looked applied. */
    expect(code).toMatch(/\}, \[lead\?\.id, activities\.length, threadSummary\.total\]\);/);
  });

  it("decides at most once per lead", () => {
    /* A second automatic switch would move the tab out from under somebody who had just
       chosen one — worse than never switching at all. */
    expect(code).toContain("autoPickedFor");
    expect(code).toMatch(/if \(autoPickedFor\.current === id\) return;/);
  });

  it("does not switch while both lists are still empty", () => {
    /* Loading and genuinely-empty look identical here, and both want Details: a brand-new
       lead's fields are what need filling in. */
    expect(code).toMatch(/if \(activities\.length === 0\) return;/);
  });
});

describe("Email as its own tab, and the three labels that collapsed into one", () => {
  it("has no Everything/Email segmented control left", () => {
    /* It switched between two halves of one tab. Email is a tab now, so it had nothing
       left to switch — and the state went with it, because two ways to be on the email
       view would drift apart and only the tab is reachable from a URL or a keyboard. */
    expect(code).not.toContain("convoView");
    expect(code).not.toContain("setConvoView");
  });

  it("drops the panel's own heading, which was the third label for one list", () => {
    /* Above the first message the reader met "Conversation (16)", then
       "Everything | Email (15)", then "EMAIL CONVERSATION · 7 in · 8 out". */
    const panel = readFileSync(
      join(process.cwd(), "src", "components", "features", "leads", "email-thread-panel.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(panel).not.toContain("Email conversation");
    /* The direction counts stay: they are the one thing those labels did NOT say. */
    expect(panel).toContain("{summary.inbound} in · {summary.outbound} out");
  });

  it("drops the redundant heading over the Activity stream too", () => {
    /* The tab strip already says "Activity (16)". */
    expect(code).not.toContain("Everything that has happened");
  });

  it("names the merged stream Activity, not Conversation", () => {
    /* Email has taken the conversational meaning. Two tabs both called Conversation was
       the confusion the fourth tab removed. */
    expect(code).toMatch(/`Activity\$\{activities\.length/);
    expect(code).not.toMatch(/`Conversation\$\{/);
  });

  it("counts three different things in three tabs", () => {
    /* Counts side by side must not overlap in what they count, or they read as totals to
       be added: Email counts messages, Activity counts logged activities, Follow-ups
       counts OPEN tasks only. */
    expect(code).toMatch(/`Email\$\{threadSummary\.total/);
    expect(code).toMatch(/`Follow-ups\$\{openTasks\.length/);
  });

  it("keeps the reply composer with the thread it answers", () => {
    const emailTab = code.indexOf('{drawerTab === "email" && (');
    const composer = code.indexOf("<ReplyComposer");
    const panel = code.indexOf("<EmailThreadPanel");
    expect(emailTab).toBeGreaterThan(0);
    expect(panel).toBeGreaterThan(emailTab);
    expect(composer).toBeGreaterThan(panel);
  });
});

describe("the next-step CTA tells the truth about what has happened", () => {
  it("offers 'first contact' only when nothing has been sent, received or logged", () => {
    /* THE DEFECT IN THE 23 AUG SCREENSHOT. A lead with 15 emails in its thread — 7 in,
       8 out — showed "Call now · first contact" as the biggest, loudest element in the
       drawer, because the rule read `lead.stage` and nothing else and the stage was
       still "new". Stages get moved by hand; this one had not been. A stage is not
       evidence about whether anyone has spoken to the lead. */
    expect(code).toMatch(
      /lead\.stage === "new" && lead\.contact_phone && threadSummary\.total === 0 && activities\.length === 0/,
    );
  });

  it("puts an unanswered inbound message above every stage rule", () => {
    /* An unanswered customer is the most expensive thing on this screen and no stage
       column records it. If the newest message came from them, the ball is ours. */
    const inbound = code.indexOf('threadSummary.latest?.direction === "inbound"');
    const stageRules = code.indexOf('lead.stage === "new" && lead.contact_phone');
    expect(inbound).toBeGreaterThan(0);
    expect(inbound).toBeLessThan(stageRules);
  });

  it("asks for the missing money step once contact has happened", () => {
    /* The old rule sent you back to say hello again. The gap on a talked-to lead with no
       quote is the quote. */
    expect(code).toMatch(/label: "Send quote"/);
  });
});

describe("the contact card, dissolved by what each part is for", () => {
  it("puts contact identity in the header, where it cannot scroll away", () => {
    /* Identity is the guard against a reply reaching the wrong person, and in the scroll
       it disappeared the moment you opened the thread you were answering. */
    const header = code.slice(code.indexOf("<SheetHeader"), code.indexOf("</SheetHeader>"));
    expect(header).toContain("lead.contact_name");
    expect(header).toContain("lead.contact_phone");
    expect(header).toContain("lead.gstin");
  });

  it("shows the full GSTIN somewhere, not just its first two characters", () => {
    /* The badge renders `lead.gstin.slice(0, 2)` and the old tooltip said only "GST
       Identification Number", so the number itself was readable nowhere in the drawer. */
    expect(code).toMatch(/title=\{`GSTIN \$\{lead\.gstin\}`\}/);
  });

  it("moves the note box and the call buttons into the Activity tab", () => {
    /* They put things INTO the record, so they belong with the record. Above all three
       tabs they were visible on Details and Follow-ups too, where they were only height.

       26 Aug 2026: the single "Log call" became "Baat hui" + "No answer". The assertion
       now anchors on "Baat hui" — the placement rule is unchanged, only the label is. */
    const activityTab = code.indexOf('{drawerTab === "activity" && (');
    const note = code.indexOf('placeholder="Add a note');
    const callButton = code.indexOf("/> Log call");
    expect(activityTab).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(activityTab);
    expect(callButton).toBeGreaterThan(activityTab);
    expect(note).toBeGreaterThan(code.indexOf('{drawerTab === "details" && ('));
  });

  it("keeps call logging, which the footer's Call button does not replace", () => {
    /* One starts a call, the others record one that already happened elsewhere. A call
       made and never logged is invisible to the timeline, the stage-age badge and every
       forecast built on them. */
    expect(page).toContain("LOG CALL IS NOT THE FOOTER'S CALL BUTTON");
    expect(code).toMatch(/kind: "call"/);
  });

  it("the drawer asks whether anybody PICKED UP, instead of assuming", () => {
    /* The bug this locks down, reported by Pardeep on 26 Aug 2026: "jab is lead ne
       activity record ki to ye contacted me kyon nahi gaya".

       The row's chip moved the stage and the drawer's "Log call" did not — one act, two
       doors, two answers. Both buttons now route through `runOutcome`, so the rule lives
       in outcomes.ts and cannot drift per surface. A future edit that logs an activity
       here directly would silently bring the split back. */
    expect(code).toContain('callLog.run("talked"');
    expect(code).toContain('runOutcome("no_answer"');
    expect(code).not.toContain("Log call</");
  });

  it("HAR surface ka Call log popup kholta hai — koi seedha log nahi karta", () => {
    /* Pardeep ne 26 Aug 2026 ko pakda: "ye to ab yahi dikha raha hai mujhe jaise panel
       me voice ke though typing hoti vaise hi chahiye". Drawer ka "Call log" popup
       kholta tha; row ke ⋯ menu me wahi naam seedha log kar deta tha. Ek naam, do
       bartaav.

       Ye test us bartaav ko chaaron surface par baandhta hai — drawer, row ka menu, call
       queue, aur mobile card. Chaaron `callLog.run` se guzarte hain, aur wo `talked` ko
       popup par bhejta hai (call-log-dialog.tsx).

       Sabse zaroori assert AAKHRI wala hai: page me `runOutcome("talked"` kahin nahi
       hona chahiye. Wahi ek line thi jo popup ko chup-chaap bypass karti thi, aur wahi
       agli baar bhi karegi. */
    expect(code).toContain('callLog.run("talked"');      // drawer ka button
    expect(code).toContain("callLog.run(chip.id, lead)"); // row ka ⋯ menu
    expect(code).toMatch(/onOutcome=\{\(o, l\) => callLog\.run\(o, l\)\}/); // queue + card

    /* Chaaron ke liye popup mount hona chahiye. Ek surface par bhoolne ka matlab hota
       button dabta hai aur kuch nahi hota — jo seedha log karne se bhi bura hai. */
    expect(code.match(/\{callLog\.dialog\}/g)?.length).toBe(4);

    expect(code).not.toContain('runOutcome("talked"');
    expect(code).not.toMatch(/onOutcome=\{\(o, l\) => \{ void runOutcome/);
  });

  it("drops the duplicate Generate quote button", () => {
    /* It called handleSendQuote — the same handler as the footer's quote button, ~40px
       away in the same drawer. */
    expect(code).not.toContain("Generate quote");
  });

  it("lays the two thread buttons out with flex, not a fixed 2-col grid", () => {
    /* The AI button is conditional on a phone or an email existing; in a fixed grid its
       absence left Log call at half width against dead space. */
    const activityTab = code.slice(code.indexOf('{drawerTab === "activity" && ('));
    expect(activityTab.slice(0, 2500)).not.toContain("grid grid-cols-2 gap-2");
  });
});

describe("exactly one primary action in the drawer", () => {
  it('has no variant="primary" button left in the footer', () => {
    /* The footer built its own stage-aware primary while nextAction built another from
       different logic, so a new lead with a phone showed "Call now · first contact" at
       the top and "Send Quote" at the bottom, both full-strength. Two primaries is no
       primary. */
    const footer = code.slice(code.indexOf("<SheetFooter"), code.indexOf("</SheetFooter>"));
    expect(footer).not.toMatch(/variant="primary"/);
  });

  it("keeps the two footer actions nextAction does not cover", () => {
    /* Deleting that block wholesale would have been a quiet capability loss: nextAction
       offers "Upsell · new quote" on a won deal but no way to open the accepted quote,
       and on a sent quote the top block is the QuoteActionBar, which moves a quote's
       status and cannot revise it. */
    const footer = code.slice(code.indexOf("<SheetFooter"), code.indexOf("</SheetFooter>"));
    expect(footer).toContain("Open accepted quote");
    expect(footer).toContain("handleReviseQuote");
  });

  it("keeps the footer's three reach-out actions", () => {
    expect(code).toMatch(/<Button icon="mail" onClick=\{handleEmail\}>Email<\/Button>/);
  });

  it("stops gating the next-step CTA on the lead having contact details", () => {
    /* A BUG FOUND ON THE WAY. The whole card was wrapped in
       `contact_phone || contact_email || gstin` and the CTA sat inside it — so a lead
       with none of the three got no next-step suggestion at all. Exactly the lead that
       most needs one, since there is nobody to call. */
    expect(code).not.toMatch(
      /\{\(lead\.contact_phone \|\| lead\.contact_email \|\| lead\.gstin\) && \(/,
    );
  });

  it("renders the decision above the tab bodies, since it does not depend on the tab", () => {
    const decision = code.indexOf("{latestQuoteForAction ? (");
    const firstTabBody = code.indexOf('{drawerTab === "details" && (');
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(firstTabBody);
  });

  it("never renders QuoteActionBar and nextAction together", () => {
    /* Both have a button labelled "Record payment" and they do DIFFERENT things — the bar
       opens the dialog inline, nextAction navigates to the quote hub. Same label, two
       behaviours, side by side would be the worst version of this bug. */
    expect(code).toMatch(/\{latestQuoteForAction \? \([\s\S]{0,6000}?\) : nextAction \? \(/);
  });
});

describe("the stage-disagrees-with-history nudge", () => {
  it("appears only when the stage is New and something has actually happened", () => {
    /* Every later stage means a human moved it by hand, and second-guessing that is a
       different and much worse feature. */
    expect(code).toMatch(
      /lead\.stage === "new" && \(threadSummary\.total > 0 \|\| activities\.length > 0\)/,
    );
  });

  it("offers a tap and writes nothing on its own", () => {
    /* Pardeep's call, asked with the alternative on the table: auto-advancing on the first
       logged touch would write to the pipeline without anyone deciding to, move stage-age
       and forecast for every lead at once, and raise a backfill question about history
       already recorded. */
    expect(code).toMatch(/void changeStage\(lead, "contact"\);/);
    /* And it is not wired into an effect — no automatic write path exists. */
    expect(code).not.toMatch(/useEffect[\s\S]{0,400}changeStage\(lead, "contact"\)/);
  });

  it("stays visually quiet, because the drawer has exactly one primary", () => {
    /* A second amber button here would undo the two-primaries fix on the very screen
       where it was made. */
    const nudge = code.slice(code.indexOf('changeStage(lead, "contact")') - 900,
                             code.indexOf('changeStage(lead, "contact")') + 500);
    expect(nudge).not.toContain("bg-amber");
    expect(nudge).not.toMatch(/variant="primary"/);
  });

  it("says why the mismatch matters, not just that it exists", () => {
    /* §24: a block or a warning states the consequence and the next step. "Stage is
       wrong" is not actionable; "the board and the forecast read the stage" is. */
    expect(code).toContain("The pipeline board and the forecast both read the stage");
  });
});

describe("a pre-quote lead always has a route to a quote", () => {
  /* Pardeep, 24 Aug 2026: "new stage me quote bhejne ka option hi nahi aata hai."
     He was right. Three things had to line up, and on a new lead with a phone they did:
       1. nextAction returns "Call now · first contact" for that exact shape
       2. the footer's quote buttons all required `hasQuotes`, which a new lead has none of
       3. the pre-quote stage rail that carries a quote button sits inside the `details` tab
          — the FOURTH tab, and not the one that opens
     Individually each is defensible. Together they left the money step with no door, and the
     tab split from the day before is what closed the last one. */

  /* S35: nextAction is now data (lib/leads/next-action.ts) — its `target.kind` is
     "send_quote" exactly when the drawer would run handleSendQuote, so the gate below is
     the same test the `onClick !== handleSendQuote` comparison used to be. */
  it("the footer offers a quote when there is none yet", () => {
    expect(code).toMatch(/!hasQuotes &&[\s\S]{0,80}nextAction\?\.target\.kind !== "send_quote"/);
  });

  it("and suppresses it when the big CTA is already that action", () => {
    /* Otherwise this fix re-creates the two-competing-primaries bug that the removed footer
       primary was deleted for. Gated on the ACTION, not on the stage: the stage is not what
       collides, being told to call is. */
    expect(code).toContain('nextAction?.target.kind !== "send_quote"');
    /* …and "send_quote" must still mean handleSendQuote and nothing else. */
    expect(code).toMatch(/t\.kind === "send_quote"\) \{ handleSendQuote\(\); return; \}/);
  });

  it("the pre-quote quote button is still inside the details tab, so the footer is the fix", () => {
    /* If somebody later moves that rail out of the tab, this test should fail and make them
       reconsider whether the footer button is still needed — rather than leaving two. */
    const detailsAt = code.indexOf('drawerTab === "details"');
    const railAt = code.indexOf("isPreQuote && (");
    expect(detailsAt).toBeGreaterThan(0);
    expect(railAt).toBeGreaterThan(detailsAt);
  });
});
