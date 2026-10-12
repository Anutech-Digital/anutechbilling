import { describe, it, expect } from "vitest";
import { buildUpiIntent, isValidVpa, invoiceUpiIntent } from "./upi";

/**
 * A malformed UPI intent doesn't fail loudly — it sends money to the wrong VPA,
 * or silently drops the amount so the payer types their own. Both are worse
 * than not printing a QR at all, which is why every field is validated.
 */

const ok = (r: ReturnType<typeof buildUpiIntent>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return new URL(r.uri.replace("upi://", "https://"));
};

describe("isValidVpa", () => {
  it("accepts real-world handles", () => {
    for (const v of ["democo@okhdfcbank", "pardeep.a@ybl", "9876543210@paytm", "a_b-c@okaxis"]) {
      expect(isValidVpa(v), v).toBe(true);
    }
  });

  it("rejects what a typo actually looks like", () => {
    // A wrong VPA doesn't error at scan time — the payer just sees a different
    // name, or the transfer fails after they've already tried.
    for (const v of ["", "nope", "@ybl", "user@", "user@@ybl", "user @ybl", "user@1bank", null, undefined]) {
      expect(isValidVpa(v as string), String(v)).toBe(false);
    }
  });
});

describe("buildUpiIntent", () => {
  it("emits the NPCI params an app expects", () => {
    const u = ok(buildUpiIntent({ vpa: "democo@okhdfcbank", payeeName: "Demo Co", amount: 11_800 }));
    expect(u.searchParams.get("pa")).toBe("democo@okhdfcbank");
    expect(u.searchParams.get("pn")).toBe("Demo Co");
    expect(u.searchParams.get("cu")).toBe("INR");
  });

  it("writes the amount with TWO decimals", () => {
    // Several UPI apps drop a bare integer amount, turning a "pay ₹11,800" QR
    // into a "type it yourself" QR without telling anyone.
    expect(ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", amount: 11_800 })).searchParams.get("am")).toBe("11800.00");
    expect(ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", amount: 1 })).searchParams.get("am")).toBe("1.00");
  });

  it("omits the amount for a scan-and-enter QR", () => {
    expect(ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X" })).searchParams.get("am")).toBeNull();
    expect(ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", amount: null })).searchParams.get("am")).toBeNull();
  });

  it("treats ₹0 as 'no amount' — a ₹0 QR looks payable and does nothing", () => {
    expect(ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", amount: 0 })).searchParams.get("am")).toBeNull();
  });

  it("refuses a bad VPA instead of printing a QR that misdirects money", () => {
    const r = buildUpiIntent({ vpa: "not-a-vpa", payeeName: "X", amount: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid UPI ID/i);
  });

  it("refuses a negative or non-numeric amount", () => {
    expect(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", amount: -1 }).ok).toBe(false);
    expect(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", amount: NaN }).ok).toBe(false);
  });

  it("requires a payee name", () => {
    expect(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "   " }).ok).toBe(false);
  });

  it("strips characters that would break the intent string", () => {
    // `&` and `=` inside a note silently truncate or corrupt the params.
    const u = ok(buildUpiIntent({
      vpa: "pardeep@ybl", payeeName: "A & B = Co", amount: 100, note: "Invoice #INV-1 & extras",
    }));
    expect(u.searchParams.get("pn")).toBe("A B Co");
    expect(u.searchParams.get("tn")).toBe("Invoice INV-1 extras");
    // The params that follow must survive intact.
    expect(u.searchParams.get("cu")).toBe("INR");
    expect(u.searchParams.get("am")).toBe("100.00");
  });

  it("keeps the reference alphanumeric so it survives the bank statement", () => {
    const u = ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "X", ref: "INV-ET-2026-27-0006" }));
    expect(u.searchParams.get("tr")).toBe("INV-ET-2026-27-0006");
  });

  it("caps long text rather than emitting an unscannable QR", () => {
    const u = ok(buildUpiIntent({ vpa: "pardeep@ybl", payeeName: "N".repeat(200), note: "x".repeat(200) }));
    expect(u.searchParams.get("pn")!.length).toBeLessThanOrEqual(50);
    expect(u.searchParams.get("tn")!.length).toBeLessThanOrEqual(50);
  });
});

describe("invoiceUpiIntent", () => {
  it("builds a payable intent from an invoice", () => {
    const uri = invoiceUpiIntent({
      vpa: "democo@okhdfcbank", payeeName: "Demo Co",
      invoiceId: "INV-ET-2026-27-0006", amountDue: 11_800,
    })!;
    const u = new URL(uri.replace("upi://", "https://"));
    expect(u.searchParams.get("am")).toBe("11800.00");
    expect(u.searchParams.get("tn")).toBe("Invoice INV-ET-2026-27-0006");
    expect(u.searchParams.get("tr")).toBe("INV-ET-2026-27-0006");
  });

  it("returns null when the tenant hasn't set a VPA — render nothing, not a broken QR", () => {
    expect(invoiceUpiIntent({ vpa: null, payeeName: "X", invoiceId: "INV-1", amountDue: 100 })).toBeNull();
    expect(invoiceUpiIntent({ vpa: "pardeep@ybl", payeeName: null, invoiceId: "INV-1", amountDue: 100 })).toBeNull();
  });

  it("returns null for an invalid VPA rather than a QR that misdirects money", () => {
    expect(invoiceUpiIntent({ vpa: "broken", payeeName: "X", invoiceId: "INV-1", amountDue: 100 })).toBeNull();
  });
});
