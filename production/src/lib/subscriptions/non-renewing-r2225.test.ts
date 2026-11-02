/**
 * R-2225 (Zoho Billing audit A1): "Won't renew" → Non-renewing.
 * The owner's path: a customer rings and says "we won't renew in December". The subscription
 * keeps running to its renewal date, then ends — no renewal quote, no reminder, off the
 * Urgent list, but counted At risk.
 */
import { describe, it, expect } from "vitest";
import {
  isNonRenewing, nonRenewingLabel, nonRenewingNote, subStatusPill, renewalRefusal, nonRenewingInputError,
  canEndAtTermEnd,
} from "./non-renewing";
import { subscriptionExceptions } from "./exceptions";

const LEAVING = {
  status: "active", auto_renew: false, renewal_date: "2026-12-15",
  non_renew_reason: "Moving to Microsoft 365", non_renew_said_on: "2026-11-01",
};

describe("isNonRenewing", () => {
  it("auto_renew off on a live subscription", () => {
    expect(isNonRenewing(LEAVING)).toBe(true);
    expect(isNonRenewing({ ...LEAVING, status: "paused" })).toBe(true);
  });
  it("not when renewing, unknown, or already ended", () => {
    expect(isNonRenewing({ ...LEAVING, auto_renew: true })).toBe(false);
    expect(isNonRenewing({ ...LEAVING, auto_renew: undefined })).toBe(false);
    expect(isNonRenewing({ ...LEAVING, status: "cancelled" })).toBe(false);
    expect(isNonRenewing({ ...LEAVING, status: "expired" })).toBe(false);
  });
});

describe("the status pill", () => {
  it("says Non-renewing and the day it ends", () => {
    expect(nonRenewingLabel(LEAVING)).toBe("Non-renewing · ends 15 Dec 2026");
    expect(subStatusPill(LEAVING)).toEqual({ label: "Non-renewing · ends 15 Dec 2026", kind: "warning", nonRenewing: true });
  });
  it("a renewing one keeps its plain status", () => {
    expect(subStatusPill({ ...LEAVING, auto_renew: true })).toEqual({ label: "Active", kind: "success", nonRenewing: false });
    expect(subStatusPill({ ...LEAVING, status: "cancelled" })).toEqual({ label: "Cancelled", kind: "danger", nonRenewing: false });
  });
  it("the drawer note names who said what and when (portal switch-off has no reason)", () => {
    expect(nonRenewingNote(LEAVING)).toBe("Customer said on 1 Nov 2026: Moving to Microsoft 365");
    expect(nonRenewingNote({ ...LEAVING, non_renew_reason: null, non_renew_said_on: null })).toBe("Auto-renew was turned off");
  });
});

describe("exceptions chip — one fact, one place", () => {
  it("the old red 'Won't auto-renew' chip now reads as the non-renewing status", () => {
    const [f] = subscriptionExceptions({ ...LEAVING });
    expect(f.key).toBe("auto_renew_off");
    expect(f.label).toBe("Non-renewing · ends 15 Dec 2026");
    expect(f.tone).toBe("warning");
  });
});

describe("no renewal quote or reminder for a non-renewing subscription", () => {
  it("Generate / Send now are refused with the way back", () => {
    expect(renewalRefusal(LEAVING)).toMatch(/Won't renew/);
    expect(renewalRefusal(LEAVING)).toMatch(/Undo/);
    expect(renewalRefusal({ ...LEAVING, auto_renew: true })).toBeNull();
  });
});

describe("input", () => {
  const today = "2026-11-01";
  it("needs a reason of 5+ characters and a date not in the future", () => {
    expect(nonRenewingInputError({ reason: "no", saidOn: today, today })).toMatch(/at least 5/);
    expect(nonRenewingInputError({ reason: "Moving away", saidOn: "2026-11-02", today })).toMatch(/future/);
    expect(nonRenewingInputError({ reason: "Moving away", saidOn: "", today })).toMatch(/date/);
    expect(nonRenewingInputError({ reason: "Moving away", saidOn: today, today })).toBeNull();
  });
});

describe("Cancel → At end of term is offered only when there is a term end to stop at", () => {
  it("live, renewing, with a renewal date", () => {
    expect(canEndAtTermEnd({ status: "active", auto_renew: true, renewal_date: "2026-12-15" })).toBe(true);
    expect(canEndAtTermEnd({ status: "active", auto_renew: true, renewal_date: null })).toBe(false);
    expect(canEndAtTermEnd({ status: "expired", auto_renew: true, renewal_date: "2026-10-01" })).toBe(false);
    expect(canEndAtTermEnd(LEAVING)).toBe(false);   // already set
  });
});

describe("roles — the same as Cancel (and the SQL function)", () => {
  it("owner / manager / accountant only", async () => {
    const { mayMarkNonRenewing } = await import("./non-renewing");
    for (const r of ["owner", "manager", "accountant"]) expect(mayMarkNonRenewing(r)).toBe(true);
    for (const r of ["billing", "sales", "support", null, undefined]) expect(mayMarkNonRenewing(r)).toBe(false);
  });
  it("the SQL function names the same roles", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const f = readdirSync("supabase/migrations").find((n) => n.endsWith("_r2225_non_renewing.sql"))!;
    expect(readFileSync(`supabase/migrations/${f}`, "utf8")).toMatch(/current_user_has_role\('owner', 'manager', 'accountant'\)/);
  });
});
