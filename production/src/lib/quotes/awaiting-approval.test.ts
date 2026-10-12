import { describe, it, expect } from "vitest";
import {
  awaitsMyApproval, eligibleApprovers, approversForTier, approverSentence, tiersApprovableBy,
} from "./awaiting-approval";

/* The real row that prompted this: Q-ADPL-2026-27-0025, ROHINI TECH, draft, owner tier,
   requested by Pardeep. ANUTECH has three owners, and Pardeep cannot clear his own. */
const PARDEEP = "3caa0f07-44d1-42ee-91b3-2123e04853b1";
const DEEPAK  = "deepak-id";
const OMEGACO = "omegaco-id";
const HITESH  = "hitesh-id";

const theRealQuote = {
  approval_status: "pending",
  approval_tier: "owner",
  approval_requested_by: PARDEEP,
};

const OWNERS_AND_MANAGERS = [
  { id: PARDEEP,  full_name: "Pardeep Sharma",        email: "pardeep@anutech.in",            role: "owner" },
  { id: DEEPAK,   full_name: "Deepak Sharma",         email: "deepak@anutech.in",             role: "owner" },
  { id: OMEGACO, full_name: "Omega Co", email: "info@omegaco.test", role: "owner" },
  { id: HITESH,   full_name: "Hitesh Baghel",         email: "hitesh@anutech.in",             role: "manager" },
];

describe("whose queue a pending quote belongs in", () => {
  it("is not the requester's own queue, however senior they are", () => {
    /* The exclusion that makes the count honest. Without it the person who asked for
       sign-off sees their own quote in their own queue and the number never goes down. */
    expect(awaitsMyApproval(theRealQuote, { id: PARDEEP, role: "owner" })).toBe(false);
  });

  it("is the other owners' queue", () => {
    expect(awaitsMyApproval(theRealQuote, { id: DEEPAK, role: "owner" })).toBe(true);
    expect(awaitsMyApproval(theRealQuote, { id: OMEGACO, role: "owner" })).toBe(true);
  });

  it("is not a manager's queue when the tier says owner", () => {
    expect(awaitsMyApproval(theRealQuote, { id: HITESH, role: "manager" })).toBe(false);
  });

  it("puts a manager-tier quote in both a manager's and an owner's queue", () => {
    const q = { ...theRealQuote, approval_tier: "manager" };
    expect(awaitsMyApproval(q, { id: HITESH, role: "manager" })).toBe(true);
    expect(awaitsMyApproval(q, { id: DEEPAK, role: "owner" })).toBe(true);
  });

  it("ignores anything that is not pending", () => {
    for (const status of ["approved", "rejected", "not_required", null]) {
      expect(awaitsMyApproval({ ...theRealQuote, approval_status: status }, { id: DEEPAK, role: "owner" }), String(status)).toBe(false);
    }
  });

  it("ignores a pending row with no requester, rather than showing it to everyone", () => {
    /* An older or half-written row. Treating "nobody asked" as "everybody must look" is
       how a queue fills with things nobody can act on. */
    expect(awaitsMyApproval({ ...theRealQuote, approval_requested_by: null }, { id: DEEPAK, role: "owner" })).toBe(false);
  });

  it("ignores an unknown tier instead of guessing a permission", () => {
    expect(approversForTier("none")).toEqual([]);
    expect(approversForTier(null)).toEqual([]);
    expect(approversForTier("director")).toEqual([]);
    expect(awaitsMyApproval({ ...theRealQuote, approval_tier: "director" }, { id: DEEPAK, role: "owner" })).toBe(false);
  });
});

describe("the badge's tier list agrees with the page's predicate", () => {
  /* The badge counts with .in("approval_tier", tiersApprovableBy(role)) because a COUNT
     cannot run a predicate over rows it never fetched. So there are two expressions of one
     rule, and this is the test that stops them drifting — it asks BOTH for every
     combination rather than reading them side by side and being satisfied. */
  it("matches for every role × tier pair", () => {
    const roles = ["owner", "manager", "sales", "accountant", "", null];
    const tiers = ["owner", "manager", "none", null, "director"];
    let checked = 0;

    for (const role of roles) {
      const allowed = tiersApprovableBy(role);
      for (const tier of tiers) {
        const viaPredicate = awaitsMyApproval(
          { approval_status: "pending", approval_tier: tier, approval_requested_by: PARDEEP },
          { id: DEEPAK, role },
        );
        const viaTierList = tier !== null && (allowed as readonly string[]).includes(tier);
        expect(viaTierList, `role=${role} tier=${tier}`).toBe(viaPredicate);
        checked += 1;
      }
    }
    /* Guards against the loop silently running zero times — an empty loop passes, and a
       green test that measured nothing is worse than a red one. */
    expect(checked).toBe(roles.length * tiers.length);
  });

  it("lets an owner clear a manager-tier quote but not the other way round", () => {
    expect(tiersApprovableBy("owner")).toEqual(["manager", "owner"]);
    expect(tiersApprovableBy("manager")).toEqual(["manager"]);
    expect(tiersApprovableBy("sales")).toEqual([]);
  });
});

describe("naming the people who can clear it", () => {
  it("names the other two owners, not the requester", () => {
    const people = eligibleApprovers(OWNERS_AND_MANAGERS, theRealQuote);
    expect(people.map((p) => p.full_name)).toEqual(["Deepak Sharma", "Omega Co"]);
  });

  it("reads as a sentence a person would say", () => {
    const people = eligibleApprovers(OWNERS_AND_MANAGERS, theRealQuote);
    expect(approverSentence(people)).toBe("Deepak Sharma or Omega Co");
    expect(approverSentence([OWNERS_AND_MANAGERS[1]])).toBe("Deepak Sharma");
    expect(approverSentence([])).toBeNull();
  });

  it("falls back to an email rather than printing nothing for a nameless user", () => {
    const nameless = [{ id: "x", full_name: null, email: "x@anutech.in", role: "owner" }];
    expect(approverSentence(eligibleApprovers(nameless, theRealQuote))).toBe("x@anutech.in");
  });

  it("returns nobody when the only owner is the one who asked", () => {
    /* A real state, not an edge case: a single-owner tenant where the owner raised the
       quote has no one left to approve it. Returning null lets the caller say the rule
       cannot be satisfied, instead of showing an empty list that reads as a loading bug. */
    const soloOwner = [OWNERS_AND_MANAGERS[0], OWNERS_AND_MANAGERS[3]];
    expect(eligibleApprovers(soloOwner, theRealQuote)).toEqual([]);
    expect(approverSentence(eligibleApprovers(soloOwner, theRealQuote))).toBeNull();
  });

  it("includes owners as well as managers for a manager-tier quote", () => {
    const people = eligibleApprovers(OWNERS_AND_MANAGERS, { ...theRealQuote, approval_tier: "manager" });
    expect(people.map((p) => p.full_name).sort()).toEqual(["Deepak Sharma", "Hitesh Baghel", "Omega Co"]);
  });
});
