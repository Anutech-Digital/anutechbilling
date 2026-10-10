// @vitest-environment jsdom
//
// WHAT THIS PROTECTS, AND WHY IT EXISTS
//   This chip is fed `leadsForTab` — `workspaceLeads.filter(isOpenLead)` — so it has never
//   held a won or lost lead. It was nonetheless labelled "All", with the hint "Everything
//   except junk".
//
//   On 21 Aug 2026 that cost real confusion. ANUTECH has 19 leads; the strip read 17; the
//   owner asked where the other two had gone. Nothing was broken: both were `won`, sitting
//   in the Won folder, which the chip strip had scrolled out of view. The database was
//   right, the filter was right, and one word was wrong — which is the harder kind of bug,
//   because every number on the screen was accurate.
//
//   So the wording is pinned here. A future edit shortening it back to "All" turns red.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LeadsSmartViews } from "./leads-smart-views";
import type { LeadCounts } from "@/lib/leads/list-page";

afterEach(cleanup);

/* S40: the menu is handed lead_counts().views — server counts over the workspace's OPEN
   leads — instead of a lead list it counted itself. WHICH leads each count takes (junk out,
   won/lost out, only the agent's flag for Waiting, …) is now pinned where it is computed:
   supabase/tests/lead_counts.test.sql, including "every count = the rows its view lists".
   What stays here is what the menu does with a number: its words, and when a row shows. */
const views = (over: Partial<LeadCounts["views"]> = {}): LeadCounts["views"] => ({
  all: 1, mine: 0, waiting: 0, today: 0, overdue: 0, hot: 0, new: 0, stalled: 0, closing: 0, duplicates: 0,
  ...over,
});

describe("the leads scope chip never claims to hold more than it does", () => {
  it('says "All open", not "All"', () => {
    render(<LeadsSmartViews counts={views()} active="all" onChange={() => {}} />);
    /* Exact text, because "All" is what it used to say and what a tidy-up would shorten it
       back to. The count lives in a separate element, so the label stands alone. */
    expect(screen.getByText("All open")).toBeTruthy();
    expect(screen.queryByText(/^All$/)).toBeNull();
  });

  it("tells the reader where the leads it excludes actually are", () => {
    /* The hint lives inside the dropdown, which Radix does not render until it opens — so
       the menu is opened here rather than the assertion being weakened to something the
       closed trigger happens to expose. Keyboard, because user-event is not a dependency
       of this project and Radix opens a menu on Enter. */
    render(<LeadsSmartViews counts={views()} active="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button");
    fireEvent.keyDown(trigger, { key: "Enter" });

    /* A count that excludes something must say WHAT — otherwise the reader's only options
       are to trust it or to go looking, and on 21 Aug the answer was "go looking". */
    const hint = screen.getByText(/Every open lead/);
    expect(hint.textContent).toMatch(/won/i);
    expect(hint.textContent).toMatch(/lost/i);
    expect(hint.textContent).toMatch(/folder/i);
  });

  it("shows the server's open count on the trigger", () => {
    /* Two open leads and one junk, as lead_counts() reports them: the menu shows the open
       count, never a total that folds junk in (junk has its own view). */
    render(<LeadsSmartViews counts={views({ all: 2 })} junkCount={1} active="all" onChange={() => {}} />);
    expect(screen.getByText("2")).toBeTruthy();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   "Waiting on you" — the queue the flag never had.

   The AI sales agent sets requires_human_attention, writes a reason a rep can act on, and
   stamps the time. Until 24 Aug 2026 NOTHING read any of it: the only route to a lead the
   agent had stopped on was opening that one lead and reading its timeline. The flag
   existed; the queue did not.

   Shown only when it holds something, like Duplicates and Junk. An empty accusing chip is
   one people learn to skip, and then it is not there on the day it has three in it.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the Waiting on you view", () => {
  it("does not appear at all when nothing is waiting", () => {
    render(
      <LeadsSmartViews counts={views({ all: 2 })} active="all" onChange={() => {}} />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    /* PROVE THE MENU OPENED FIRST. Without this the assertion below passes when the
       dropdown never rendered at all — which is exactly what happened on the first run of
       this test, because Radix opens on Enter and not on click. A negative assertion against
       a component that is not on screen is not a test. */
    expect(screen.getByText(/Every open lead/)).toBeTruthy();
    expect(screen.queryByText("Waiting on you")).toBeNull();
  });

  it("appears with the count once the agent has stopped on something", () => {
    render(
      <LeadsSmartViews
        counts={views({ all: 3, waiting: 2 })}
        active="all"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    const row = screen.getByText("Waiting on you").closest("[role^=menuitem]");
    /* The count is the point — a view whose number you have to click to learn is the bug
       this component's own header was written about. Read off the ROW, because a bare "2"
       matches several places on this screen. */
    expect(row?.textContent).toMatch(/2/);
  });

  it("shows the server's Waiting count — open leads only, a won or lost handover is history", () => {
    /* Leaving closed deals in the queue is how a queue stops being read. The OPEN-only rule
       is lead_counts()'s (lead_counts.test.sql: a lost lead with the flag is not counted);
       this pins that the menu shows that number and not another. */
    render(
      <LeadsSmartViews
        counts={views({ waiting: 1 })}
        active="all"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    const row = screen.getByText("Waiting on you").closest("[role^=menuitem]");
    expect(row?.textContent).toMatch(/1/);
  });

  it("tells a screen reader WHICH view is in force, not just which row has a tick", () => {
    /* ─── A GLYPH IS NOT A STATE ─────────────────────────────────────────────
       The chosen row was marked by a check icon and nothing else, so the whole menu
       announced as seven identical `menuitem`s and the rep's own current filter was
       unreadable without sight. One of these rows is ALWAYS in force, which is
       `menuitemradio` + `aria-checked` — there is no DropdownMenuRadioItem in this
       app's dropdown-menu.tsx, so the role is set at the call site.

       Asserted through getByRole so the ROLE is pinned too: the sibling tests reach
       the row with a `[role^=menuitem]` prefix match, which would keep passing if the
       role silently went back to plain `menuitem`. */
    render(
      <LeadsSmartViews
        counts={views({ waiting: 1 })}
        active="waiting"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });

    const chosen = screen.getByRole("menuitemradio", { name: /Waiting on you/ });
    expect(chosen.getAttribute("aria-checked")).toBe("true");

    /* And the ones NOT in force say so, rather than omitting the attribute — an absent
       aria-checked on a radio role is "not applicable", which reads as a broken group. */
    const others = screen
      .getAllByRole("menuitemradio")
      .filter((el) => el !== chosen);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((el) => el.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("says what the view holds, in words a rep can act on", () => {
    render(
      <LeadsSmartViews
        counts={views({ waiting: 1 })}
        active="all"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(screen.getByText(/stopped and asked for a person/i)).toBeTruthy();
  });
});

describe("the page opens on every lead — won and lost included", () => {
  /* 26 Sep 2026: the only lead moved to Won and the pipeline opened on "No leads match".
     Nothing was wrong with the data; the default view was "All open". The default is now
     "All leads", and its count is every non-junk lead, closed ones too. */
  it('the default view reads "All leads" with the full count', () => {
    render(<LeadsSmartViews counts={views({ all: 0 })} everythingCount={3} active="everything" onChange={() => {}} />);
    expect(screen.getByText("All leads")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("All open is still offered, and choosing it counts as narrowing the list", () => {
    render(<LeadsSmartViews counts={views()} everythingCount={2} active="everything" onChange={() => {}} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(screen.getByText("All open")).toBeTruthy();
    expect(screen.getByText(/New, Contacted and Lost/)).toBeTruthy();
  });
});
