/**
 * Claim & Merge — the client-side contract around
 * `merge_stranded_user_into_tenant()` (migration 0243).
 *
 * ─── READ THIS BEFORE TRUSTING THIS FILE ─────────────────────────────────────
 * Vitest CANNOT prove a Postgres SECURITY DEFINER function. There is no database
 * in this suite — it runs 1100+ tests in about four seconds precisely because
 * nothing here touches one. A test here that "verified accidental tenant deletion"
 * would be verifying a mock of my own writing, which is worse than no test: it
 * would go green while the real function deleted the wrong row.
 *
 * The deletion and migration behaviour is proved where it can be — against a real
 * database, on seeded fixtures, inside transactions that roll back:
 *
 *     supabase/tests/merge_stranded_user.test.sql
 *
 * ⚠️ Those SQL tests are NOT in CI and NOT in the Stop hook (CLAUDE.md §25.2), so
 * a DB change means running them by hand or it is not verified.
 *
 * What IS provable here, and is: the sentence an owner reads afterwards. That
 * sentence is the only account most people will ever get of what happened to a
 * colleague's account, and its four cases are easy to blur.
 */
import { describe, it, expect } from "vitest";
import {
  describeMergeOutcome,
  mergeChangedSomething,
  type MergeAction,
  type MergeResult,
} from "./merge-outcome";

const ALL_ACTIONS: MergeAction[] = ["attached", "moved", "already_member", "role_updated"];

function result(over: Partial<MergeResult> = {}): MergeResult {
  return {
    action:             "attached",
    email:              "deepak@anutech.in",
    role:               "owner",
    old_tenant_name:    null,
    old_tenant_deleted: false,
    ...over,
  };
}

describe("describeMergeOutcome — moved vs attached must never be blurred", () => {
  it("'moved' with deletion says WHICH workspace was removed", () => {
    const s = describeMergeOutcome(result({
      action: "moved",
      email: "ranjeetraj@exceltechnologies.in",
      role: "support",
      old_tenant_name: "Excel Technologies",
      old_tenant_deleted: true,
    }));
    expect(s).toContain("ranjeetraj@exceltechnologies.in");
    expect(s).toContain("Excel Technologies");
    expect(s).toContain("removed");
  });

  it("'moved' WITHOUT deletion never claims a workspace was removed", () => {
    const s = describeMergeOutcome(result({
      action: "moved",
      old_tenant_name: "Some Workspace",
      old_tenant_deleted: false,
    }));
    expect(s).toContain("Some Workspace");
    expect(s).not.toMatch(/removed|deleted/i);
  });

  it("'attached' never invents an old workspace", () => {
    // The thirteen stranded auth accounts have no tenant at all. Saying "moved
    // out of X" here would name a workspace that never existed.
    const s = describeMergeOutcome(result({ action: "attached" }));
    expect(s).not.toMatch(/moved|removed|deleted/i);
    expect(s).toMatch(/no workspace/i);
  });

  it("never prints a null workspace name as the word 'null'", () => {
    for (const action of ALL_ACTIONS) {
      const s = describeMergeOutcome(result({ action, old_tenant_name: null }));
      expect(s).not.toContain("null");
      expect(s).not.toContain("undefined");
    }
  });
});

describe("describeMergeOutcome — every action is covered and distinct", () => {
  it("returns a non-empty sentence for all four actions", () => {
    for (const action of ALL_ACTIONS) {
      const s = describeMergeOutcome(result({ action, old_tenant_name: "Old Co" }));
      expect(s.length).toBeGreaterThan(10);
      expect(s.endsWith(".")).toBe(true);
    }
  });

  it("no two actions produce the same sentence", () => {
    const sentences = ALL_ACTIONS.map((action) =>
      describeMergeOutcome(result({ action, old_tenant_name: "Old Co", old_tenant_deleted: true })),
    );
    expect(new Set(sentences).size).toBe(ALL_ACTIONS.length);
  });

  it("always names the person and the role they ended up with", () => {
    for (const action of ALL_ACTIONS) {
      const s = describeMergeOutcome(result({ action, role: "billing", old_tenant_name: "Old Co" }));
      expect(s).toContain("deepak@anutech.in");
      expect(s).toContain("billing");
    }
  });
});

describe("mergeChangedSomething — a no-op must not be reported as a change", () => {
  it("already_member changed nothing", () => {
    expect(mergeChangedSomething(result({ action: "already_member" }))).toBe(false);
  });

  it("the other three changed something", () => {
    for (const action of ALL_ACTIONS.filter((a) => a !== "already_member")) {
      expect(mergeChangedSomething(result({ action }))).toBe(true);
    }
  });
});

describe("refusal contract — the RPC's own message reaches the operator intact", () => {
  /**
   * These strings are copied from the `raise exception` calls in migration
   * 20261011124100_r721_stranded_users (R-721 made them generic: no other company's
   * name, no record counts, and "no account" reads the same as "no request"). The
   * test is that nothing in the client rewrites or truncates them: each carries a
   * reason AND a next step (CLAUDE.md §24), and "Could not claim user" would throw
   * away the only useful thing the failure knows.
   *
   * The client path is: RPC error → /api/team/claim returns `error` verbatim →
   * the card sets `blocked` to that string and renders it. No mapping table, by
   * design — so what this asserts is that the messages themselves are actionable.
   */
  const REFUSALS = [
    "Cannot claim x@y.in: their current workspace still holds records. Moving them out would leave that data with no one who can sign in and see it. They should move or export it first — this tool only clears empty workspaces.",
    "Cannot claim x@y.in: they are in another company that has other people in it. That is a separate company, not an accidental workspace — moving them is a platform-admin job.",
    "Cannot claim nobody@example.com. Only someone with a pending invite or join request to your workspace, who has signed in at least once, can be claimed. Invite them from Team → Invite teammate using this exact address, ask them to sign in once, then claim them.",
    "Only the owner of a workspace can claim someone into it. Ask your workspace owner to open Team → Claim a colleague.",
  ];

  it("every refusal states a next step, not just a refusal", () => {
    for (const msg of REFUSALS) {
      // Something the reader can DO: a place to go, or an action to take first.
      expect(msg).toMatch(/Send them|Move or export|open Team|platform-admin|invite/i);
    }
  });

  it("every refusal explains WHY, not just that it was blocked", () => {
    for (const msg of REFUSALS) {
      expect(msg).toMatch(/still holds|people in it|pending invite or join request|Only the owner/i);
    }
  });

  it("R-721: no refusal says whether an account exists or names another company", () => {
    for (const msg of REFUSALS) {
      expect(msg).not.toMatch(/No account exists|"[^"]+"|d+ (records|people)/i);
    }
  });

  it("no refusal is a bare 'not allowed'", () => {
    for (const msg of REFUSALS) {
      expect(msg.length).toBeGreaterThan(60);
      expect(msg).not.toMatch(/^(not allowed|permission denied|error)\.?$/i);
    }
  });
});
