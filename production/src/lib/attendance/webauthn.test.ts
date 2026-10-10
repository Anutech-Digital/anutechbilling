import { describe, expect, it } from "vitest";
import {
  DEVICE_MESSAGES,
  MAX_DEVICES_PER_EMPLOYEE,
  canRegisterAnother,
  canTransition,
  cleanLabel,
  decideOwnerAction,
  defaultDeviceLabel,
  deviceError,
  employeeIdBytes,
  initialStatus,
  myDeviceSummary,
  relyingParty,
} from "./webauthn";

describe("R-606 device limit (Pardeep: max 2 per employee)", () => {
  it("is two", () => {
    expect(MAX_DEVICES_PER_EMPLOYEE).toBe(2);
  });
  it("counts pending + approved, not revoked", () => {
    expect(canRegisterAnother([])).toBe(true);
    expect(canRegisterAnother([{ status: "approved" }])).toBe(true);
    expect(canRegisterAnother([{ status: "approved" }, { status: "pending" }])).toBe(false);
    expect(canRegisterAnother([{ status: "revoked" }, { status: "revoked" }, { status: "approved" }])).toBe(true);
  });
});

describe("status transitions", () => {
  it("pending → approved / revoked; approved → revoked; revoked is final", () => {
    expect(canTransition("pending", "approved")).toBe(true);
    expect(canTransition("pending", "revoked")).toBe(true);
    expect(canTransition("approved", "revoked")).toBe(true);
    expect(canTransition("approved", "pending")).toBe(false);
    expect(canTransition("revoked", "approved")).toBe(false);
    expect(canTransition("revoked", "pending")).toBe(false);
    expect(canTransition("approved", "approved")).toBe(false);
  });

  it("owner approve refuses a third approved device", () => {
    const devs = [
      { id: "a", status: "approved" },
      { id: "b", status: "approved" },
      { id: "c", status: "pending" },
    ];
    expect(decideOwnerAction({ id: "c", status: "pending" }, devs, "approve")).toEqual({ ok: false, code: "APPROVED_LIMIT" });
    expect(decideOwnerAction({ id: "c", status: "pending" }, devs, "revoke")).toEqual({ ok: true, status: "revoked" });
    expect(decideOwnerAction({ id: "a", status: "approved" }, devs, "approve")).toEqual({ ok: false, code: "BAD_TRANSITION" });
  });

  it("owner approve allowed when room", () => {
    expect(decideOwnerAction({ id: "c", status: "pending" }, [{ id: "a", status: "approved" }, { id: "c", status: "pending" }], "approve"))
      .toEqual({ ok: true, status: "approved" });
  });

  it("only the owner's own registration skips approval", () => {
    expect(initialStatus("owner")).toBe("approved");
    expect(initialStatus("manager")).toBe("pending");
    expect(initialStatus("sales")).toBe("pending");
    expect(initialStatus(null)).toBe("pending");
  });
});

describe("messages say what to do next (§24)", () => {
  it("every message names a next step", () => {
    for (const msg of Object.values(DEVICE_MESSAGES)) {
      expect(msg).toMatch(/ask|register|press|pick|remove|open/i);
    }
  });
  it("the not-registered message is the one Pardeep's colleague will see", () => {
    expect(deviceError("DEVICE_NOT_REGISTERED")).toEqual({
      code: "DEVICE_NOT_REGISTERED",
      error: "This device is not registered for you. Register it on My Attendance and ask the owner to approve.",
    });
    expect(DEVICE_MESSAGES.DEVICE_LIMIT).toBe("You already have 2 devices. Ask the owner to remove one.");
  });
});

describe("relyingParty", () => {
  it("uses forwarded host/proto behind Cloud Run", () => {
    expect(relyingParty({ url: "http://0.0.0.0:8080/api/x", forwardedHost: "reselleros.anutech.in", forwardedProto: "https" }))
      .toEqual({ rpID: "reselleros.anutech.in", origin: "https://reselleros.anutech.in" });
  });
  it("keeps the port in the origin but not in the rpID", () => {
    expect(relyingParty({ url: "http://localhost:3000/api/x" })).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });
  });
});

describe("helpers", () => {
  it("employeeIdBytes is the uuid's 16 bytes", () => {
    const b = employeeIdBytes("46060000-0000-4000-8000-0000000000e1");
    expect(b.length).toBe(16);
    expect(b[0]).toBe(0x46);
    expect(b[15]).toBe(0xe1);
    expect(() => employeeIdBytes("nope")).toThrow();
  });
  it("default labels", () => {
    expect(defaultDeviceLabel({ platform: "Windows" })).toBe("Windows laptop");
    expect(defaultDeviceLabel({ platform: "Android", mobile: true })).toBe("Android phone");
    expect(defaultDeviceLabel({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe("iPhone");
    expect(defaultDeviceLabel({ platform: "macOS", mobile: false })).toBe("Mac");
    expect(defaultDeviceLabel({})).toBe("Computer");
  });
  it("cleanLabel trims and caps", () => {
    expect(cleanLabel("  My   laptop ", "x")).toBe("My laptop");
    expect(cleanLabel("", "Windows laptop")).toBe("Windows laptop");
    expect(cleanLabel(42, "Phone")).toBe("Phone");
    expect(cleanLabel("a".repeat(80), "x")).toHaveLength(40);
  });
  it("myDeviceSummary", () => {
    expect(myDeviceSummary([])).toBe("none");
    expect(myDeviceSummary([{ status: "revoked" }])).toBe("none");
    expect(myDeviceSummary([{ status: "pending" }])).toBe("pending");
    expect(myDeviceSummary([{ status: "pending" }, { status: "approved" }])).toBe("approved");
  });
});
