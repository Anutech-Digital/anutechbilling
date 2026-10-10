import { describe, expect, it } from "vitest";
import { officeNetworkDecision } from "./office-network";

const OFFICE = ["203.0.113.10"];

describe("kiosk — Pardeep 10 Oct: 'kiosk sirf office wifi par'", () => {
  it("refuses when no office network is locked, and says how to lock it", () => {
    const d = officeNetworkDecision({ purpose: "kiosk", allowedIps: [], ip: "203.0.113.10" });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe("KIOSK_NOT_LOCKED");
      expect(d.error).toContain("Lock to this network");
    }
  });
  it("refuses off the office network", () => {
    expect(officeNetworkDecision({ purpose: "kiosk", allowedIps: OFFICE, ip: "198.51.100.7" }).ok).toBe(false);
  });
  it("refuses when the IP could not be read", () => {
    expect(officeNetworkDecision({ purpose: "kiosk", allowedIps: OFFICE, ip: "" }).ok).toBe(false);
  });
  it("works on the office network", () => {
    expect(officeNetworkDecision({ purpose: "kiosk", allowedIps: OFFICE, ip: "203.0.113.10" })).toEqual({ ok: true, flag: null });
  });
  it("an 'anywhere' employee or the owner does not unlock the kiosk off-site", () => {
    expect(officeNetworkDecision({ purpose: "kiosk", allowedIps: OFFICE, ip: "198.51.100.7", anywhere: true, isOwner: true }).ok).toBe(false);
  });
});

describe("self check-in (My Attendance)", () => {
  it("no office network locked yet → allowed, no flag (nothing to compare against)", () => {
    expect(officeNetworkDecision({ purpose: "self", allowedIps: [], ip: "198.51.100.7" })).toEqual({ ok: true, flag: null });
  });
  it("on the office Wi-Fi → allowed", () => {
    expect(officeNetworkDecision({ purpose: "self", allowedIps: OFFICE, ip: "203.0.113.10" })).toEqual({ ok: true, flag: null });
  });
  it("from home → refused with the next step", () => {
    const d = officeNetworkDecision({ purpose: "self", allowedIps: OFFICE, ip: "198.51.100.7" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain("Can mark from outside office");
  });
  it("from home, allowed outside → allowed and flagged for the owner", () => {
    expect(officeNetworkDecision({ purpose: "self", allowedIps: OFFICE, ip: "198.51.100.7", anywhere: true }))
      .toEqual({ ok: true, flag: "outside_office" });
  });
  it("the owner is not exempt from the office rule for their own attendance", () => {
    expect(officeNetworkDecision({ purpose: "self", allowedIps: OFFICE, ip: "198.51.100.7", isOwner: true }).ok).toBe(false);
  });
});

describe("registering a device", () => {
  it("off-site is refused for a normal employee", () => {
    const d = officeNetworkDecision({ purpose: "register_device", allowedIps: OFFICE, ip: "198.51.100.7" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("REGISTER_OFF_NETWORK");
  });
  it("off-site is allowed for the owner and for 'outside office' staff (still needs owner approval)", () => {
    expect(officeNetworkDecision({ purpose: "register_device", allowedIps: OFFICE, ip: "198.51.100.7", isOwner: true }).ok).toBe(true);
    expect(officeNetworkDecision({ purpose: "register_device", allowedIps: OFFICE, ip: "198.51.100.7", anywhere: true }).ok).toBe(true);
  });
  it("on the office Wi-Fi is allowed", () => {
    expect(officeNetworkDecision({ purpose: "register_device", allowedIps: OFFICE, ip: "203.0.113.10" }).ok).toBe(true);
  });
});
