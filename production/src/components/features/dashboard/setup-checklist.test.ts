import { describe, it, expect } from "vitest";
import {
  buildSetupSteps, companyDone, emailDone, gstDone, payoutDone, seriesDone, setupLoading, teamDone,
  type SetupFacts,
} from "./setup-checklist";

/* ANUTECH's own GSTIN — passes the checksum (CLAUDE.md §1). */
const VALID_GSTIN = "07ABDCA0298H1ZP";

/** A brand-new workspace: everything loaded, nothing filled in. */
const fresh: SetupFacts = {
  address: null, stateCode: null, gstin: null,
  upiVpa: null, remitAccountNumber: null, remitIfsc: null,
  invoiceCode: { saved: null, locked: false },
  email: { provider: "resend", fromAddress: null, hasResendKey: false, canSendNow: true },
  memberCount: 1, pendingInvites: 0,
};

const done = (f: SetupFacts, id: string) => buildSetupSteps(f).find((s) => s.id === id)?.done;

describe("company address", () => {
  it("needs both address and state", () => {
    expect(companyDone({ address: "Plot 1, Delhi", stateCode: null })).toBe(false);
    expect(companyDone({ address: "   ", stateCode: "07" })).toBe(false);
    expect(companyDone({ address: "Plot 1, Delhi", stateCode: "07" })).toBe(true);
  });
});

describe("GSTIN", () => {
  it("ticks only a GSTIN that passes the checksum", () => {
    expect(gstDone(VALID_GSTIN)).toBe(true);
    expect(gstDone(` ${VALID_GSTIN} `)).toBe(true);
    expect(gstDone("07ABDCA0298H1ZQ")).toBe(false);
    expect(gstDone(null)).toBe(false);
  });
});

describe("invoice numbering", () => {
  it("is open for a new workspace with no code — the DB would print tenant-id letters", () => {
    expect(seriesDone({ saved: null, locked: false })).toBe(false);
    expect(seriesDone({ saved: "  ", locked: false })).toBe(false);
  });
  it("is done once a code is saved", () => {
    expect(seriesDone({ saved: "AD", locked: false })).toBe(true);
  });
  it("is done once numbers are already being issued, code or not", () => {
    expect(seriesDone({ saved: null, locked: true })).toBe(true);
  });
  it("a failed read is never a tick", () => {
    expect(seriesDone(null)).toBe(false);
    expect(seriesDone(undefined)).toBe(false);
  });
});

describe("bank / UPI", () => {
  it("is done with a valid UPI ID", () => {
    expect(payoutDone({ upiVpa: "anutech@okhdfcbank", remitAccountNumber: null, remitIfsc: null })).toBe(true);
  });
  it("does not tick a malformed UPI ID", () => {
    expect(payoutDone({ upiVpa: "not-a-upi", remitAccountNumber: null, remitIfsc: null })).toBe(false);
  });
  it("needs account number AND IFSC for a bank transfer", () => {
    expect(payoutDone({ upiVpa: null, remitAccountNumber: "123456789", remitIfsc: null })).toBe(false);
    expect(payoutDone({ upiVpa: null, remitAccountNumber: "123456789", remitIfsc: "HDFC0001234" })).toBe(true);
  });
});

describe("sending email", () => {
  it("does NOT tick on the platform fallback key alone", () => {
    /* canSendNow is true for every tenant when the deployment has a Resend key — mail would
       still leave under a platform address, not this business. */
    expect(emailDone({ provider: "resend", fromAddress: null, hasResendKey: false, canSendNow: true })).toBe(false);
  });
  it("ticks with a from-address that can send", () => {
    expect(emailDone({ provider: "resend", fromAddress: "billing@acme.in", hasResendKey: false, canSendNow: true })).toBe(true);
  });
  it("ticks with the tenant's own Resend key", () => {
    expect(emailDone({ provider: "resend", fromAddress: null, hasResendKey: true, canSendNow: true })).toBe(true);
  });
  it("ticks Gmail only when it can actually send", () => {
    expect(emailDone({ provider: "gmail", canSendNow: true })).toBe(true);
    expect(emailDone({ provider: "gmail", canSendNow: false })).toBe(false);
  });
  it("a failed read is never a tick", () => {
    expect(emailDone(null)).toBe(false);
  });
});

describe("team", () => {
  it("the owner alone is not a team", () => {
    expect(teamDone(1, 0)).toBe(false);
  });
  it("one more login, or one open invite, is enough", () => {
    expect(teamDone(2, 0)).toBe(true);
    expect(teamDone(1, 1)).toBe(true);
    expect(teamDone(1, null)).toBe(false);
  });
});

describe("the six steps together", () => {
  it("a brand-new workspace has every step open, each with a link", () => {
    const steps = buildSetupSteps(fresh);
    expect(steps.map((s) => s.id)).toEqual(["org", "gst", "series", "payout", "email", "team"]);
    for (const s of steps) {
      expect(s.done, s.id).toBe(false);
      expect(s.href).toMatch(/^\//);
    }
  });

  it("every step ticks from saved data", () => {
    const all: SetupFacts = {
      address: "Plot 1, Delhi", stateCode: "07", gstin: VALID_GSTIN,
      upiVpa: "anutech@okhdfcbank", remitAccountNumber: null, remitIfsc: null,
      invoiceCode: { saved: "AD", locked: false },
      email: { provider: "gmail", canSendNow: true },
      memberCount: 3, pendingInvites: 0,
    };
    expect(buildSetupSteps(all).every((s) => s.done)).toBe(true);
  });

  it("links each step to the exact settings spot", () => {
    const href = Object.fromEntries(buildSetupSteps(fresh).map((s) => [s.id, s.href]));
    expect(href.series).toBe("/settings?tab=company#invoice-numbering");
    expect(href.payout).toBe("/settings?tab=company#payment-details");
    expect(href.email).toBe("/settings?tab=integrations#email-sending");
    expect(href.team).toBe("/team");
  });

  it("says 'Could not check' when a read failed, rather than guessing", () => {
    const f = { ...fresh, invoiceCode: null, email: null };
    const steps = buildSetupSteps(f);
    expect(steps.find((s) => s.id === "series")?.hint).toMatch(/could not check/i);
    expect(steps.find((s) => s.id === "email")?.hint).toMatch(/could not check/i);
    expect(done(f, "series")).toBe(false);
  });

  it("waits while any probe is still loading", () => {
    expect(setupLoading(fresh)).toBe(false);
    expect(setupLoading({ ...fresh, invoiceCode: undefined })).toBe(true);
    expect(setupLoading({ ...fresh, email: undefined })).toBe(true);
    expect(setupLoading({ ...fresh, memberCount: undefined })).toBe(true);
    expect(setupLoading({ ...fresh, pendingInvites: undefined })).toBe(true);
    /* null = failed or not readable by this role: done loading. */
    expect(setupLoading({ ...fresh, invoiceCode: null, email: null, pendingInvites: null })).toBe(false);
  });
});
