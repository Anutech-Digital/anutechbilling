/**
 * R-1931 (G-ONBOARD OB-10) — ONE "Get to your first quote" list. Every tick comes from saved
 * data or a real count; a read that failed is never a tick.
 */
import { describe, it, expect } from "vitest";
import {
  buildFirstQuoteSteps, companyDone, firstQuoteLoading, gstDone, payoutDone, teamDone,
  type FirstQuoteFacts,
} from "./setup-checklist";

/* ANUTECH's own GSTIN — passes the checksum (CLAUDE.md §1). */
const VALID_GSTIN = "07ABDCA0298H1ZP";

/** A brand-new workspace: everything loaded, nothing filled in. */
const fresh: FirstQuoteFacts = {
  address: null, stateCode: null, gstin: null, gstRegistration: null,
  productCount: 0, quoteCount: 0, sentQuoteCount: 0, draftQuoteId: null,
  customerMessages: "off",
  upiVpa: null, remitAccountNumber: null, remitIfsc: null,
  memberCount: 1, pendingInvites: 0,
};

/** A company that already trades (like the E2E company): products, quotes, quotes sent, messages on. */
const trading: FirstQuoteFacts = {
  address: "12 Nehru Place, New Delhi", stateCode: "07", gstin: VALID_GSTIN, gstRegistration: "registered",
  productCount: 15, quoteCount: 42, sentQuoteCount: 30, draftQuoteId: "q-draft",
  customerMessages: "on",
  upiVpa: "shop@okhdfcbank", remitAccountNumber: null, remitIfsc: null,
  memberCount: 4, pendingInvites: 0,
};

const steps = (f: FirstQuoteFacts) => buildFirstQuoteSteps(f);
const step = (f: FirstQuoteFacts, id: string) => steps(f).find((s) => s.id === id)!;

describe("the list itself", () => {
  it("is 5 first-quote items in order, then Bank/UPI and Team", () => {
    expect(steps(fresh).map((s) => s.id)).toEqual(["company", "catalog", "quote", "send", "messages", "payout", "team"]);
    expect(steps(fresh).map((s) => s.group)).toEqual(["first", "first", "first", "first", "first", "after", "after"]);
  });

  it("a brand-new workspace has every item open, each with its own button to the right place", () => {
    const s = steps(fresh);
    for (const x of s) {
      expect(x.done, x.id).toBe(false);
      expect(x.cta.length, x.id).toBeGreaterThan(0);
      expect(x.href.startsWith("/"), x.id).toBe(true);
    }
    const href = Object.fromEntries(s.map((x) => [x.id, x.href]));
    expect(href).toEqual({
      company:  "/settings?tab=company#settings-registered-state",
      catalog:  "/items",
      quote:    "/quotes/new",
      send:     "/quotes",
      messages: "/automation#customer-messages",
      payout:   "/settings?tab=company#payment-details",
      team:     "/team",
    });
    expect(s.find((x) => x.id === "messages")!.label).toBe("Turn on customer messages");
  });

  it("no customer step — a company with customers never sees 'Add your first customer'", () => {
    expect(steps(trading).some((s) => /customer/i.test(s.label) && s.id !== "messages")).toBe(false);
    expect(steps(fresh).some((s) => s.label === "Add your first customer")).toBe(false);
  });

  it("a trading company (products, quotes, sent quotes, messages on) has every item ticked", () => {
    for (const s of steps(trading)) expect(s.done, s.id).toBe(true);
  });

  it("only the owner-only items are flagged owner-only", () => {
    expect(steps(fresh).filter((s) => s.ownerOnly).map((s) => s.id)).toEqual(["company", "messages", "payout", "team"]);
  });

  it("a one-time business is sent to its One-time products tab (R-1862)", () => {
    const c = buildFirstQuoteSteps(fresh, "one_time").find((s) => s.id === "catalog")!;
    expect(c.href).toBe("/items/products");
  });
});

describe("State / GSTIN", () => {
  it("needs state, address and a GSTIN that passes the checksum", () => {
    expect(step({ ...fresh, stateCode: "07" }, "company").done).toBe(false);
    expect(step({ ...fresh, stateCode: "07", address: "x" }, "company").done).toBe(false);
    expect(step({ ...fresh, stateCode: "07", address: "x", gstin: "07ABDCA0298H1ZQ" }, "company").done).toBe(false);
    expect(step({ ...fresh, stateCode: "07", address: "x", gstin: VALID_GSTIN }, "company").done).toBe(true);
  });

  it("a business saved as Not registered needs no GSTIN (Bill of Supply)", () => {
    expect(step({ ...fresh, stateCode: "07", address: "x", gstRegistration: "unregistered" }, "company").done).toBe(true);
  });

  it("opens the State select while the state is missing, the company tab otherwise", () => {
    expect(step(fresh, "company").href).toBe("/settings?tab=company#settings-registered-state");
    expect(step({ ...fresh, stateCode: "07" }, "company").href).toBe("/settings?tab=company");
    expect(step({ ...fresh, stateCode: "07", gstin: VALID_GSTIN }, "company").hint).toMatch(/address/i);
  });

  it("helpers keep their old rules", () => {
    expect(companyDone({ address: "x", stateCode: null })).toBe(false);
    expect(gstDone(VALID_GSTIN)).toBe(true);
    expect(gstDone("07ABDCA0298H1ZQ")).toBe(false);
  });
});

describe("Price list, First quote, Send link — from real counts", () => {
  it("price list ticks on one product", () => {
    expect(step({ ...fresh, productCount: 1 }, "catalog").done).toBe(true);
  });

  it("first quote ticks once any quote exists", () => {
    expect(step({ ...fresh, quoteCount: 1 }, "quote").done).toBe(true);
  });

  it("send link ticks only on a quote that left draft; a draft quote is opened by the button", () => {
    const draftOnly = { ...fresh, quoteCount: 1, sentQuoteCount: 0, draftQuoteId: "q1" };
    expect(step(draftOnly, "send").done).toBe(false);
    expect(step(draftOnly, "send").href).toBe("/quotes/q1");
    expect(step({ ...draftOnly, sentQuoteCount: 1 }, "send").done).toBe(true);
  });

  it("a failed count is never a tick", () => {
    const f = { ...fresh, productCount: null, quoteCount: null, sentQuoteCount: null };
    expect(step(f, "catalog").done).toBe(false);
    expect(step(f, "quote").done).toBe(false);
    expect(step(f, "send").done).toBe(false);
    expect(step(f, "quote").hint).toMatch(/Could not check/);
  });
});

describe("Turn on customer messages", () => {
  it("ticks only when the switch is ON — practice run and off are open", () => {
    expect(step({ ...fresh, customerMessages: "on" }, "messages").done).toBe(true);
    expect(step({ ...fresh, customerMessages: "dry_run" }, "messages").done).toBe(false);
    expect(step({ ...fresh, customerMessages: "dry_run" }, "messages").hint).toMatch(/practice/i);
    expect(step({ ...fresh, customerMessages: null }, "messages").done).toBe(false);
    expect(step({ ...fresh, customerMessages: null }, "messages").hint).toMatch(/Could not check/);
  });
});

describe("Bank/UPI and Team", () => {
  it("bank/UPI: valid UPI, or account + IFSC", () => {
    expect(payoutDone({ upiVpa: "shop@okhdfcbank", remitAccountNumber: null, remitIfsc: null })).toBe(true);
    expect(payoutDone({ upiVpa: "not a vpa", remitAccountNumber: null, remitIfsc: null })).toBe(false);
    expect(payoutDone({ upiVpa: null, remitAccountNumber: "123", remitIfsc: null })).toBe(false);
    expect(payoutDone({ upiVpa: null, remitAccountNumber: "123", remitIfsc: "HDFC0000001" })).toBe(true);
  });

  it("team: one more login or one open invite", () => {
    expect(teamDone(1, 0)).toBe(false);
    expect(teamDone(2, 0)).toBe(true);
    expect(teamDone(1, 1)).toBe(true);
    expect(teamDone(null, null)).toBe(false);
  });
});

describe("loading", () => {
  it("waits while any fact is still loading", () => {
    expect(firstQuoteLoading(fresh)).toBe(false);
    for (const k of ["productCount", "quoteCount", "sentQuoteCount", "customerMessages", "memberCount", "pendingInvites", "gstRegistration"] as const) {
      expect(firstQuoteLoading({ ...fresh, [k]: undefined }), k).toBe(true);
    }
  });
});
