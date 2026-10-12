/**
 * R-897: sendCustomerMessage refuses while "Customer messages" is OFF, and in a cron pass
 * respects the job's companies and practice run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: "off" as "off" | "on" | "dry_run",
  sendEmail: vi.fn(async () => ({ status: "sent", providerId: "p1", errorMessage: null, provider: "smtp" })),
  sendWhatsApp: vi.fn(async () => ({ wamid: "w1", status: "sent", raw: {} })),
  recordEmail: vi.fn(async () => {}),
  automationState: vi.fn(async () => h.state),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: h.sendEmail, isEmailConfigured: () => true }));
vi.mock("@/lib/email/log", () => ({ recordEmail: h.recordEmail }));
vi.mock("@/lib/whatsapp/client", () => ({ sendWhatsApp: h.sendWhatsApp }));
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: h.automationState,
  cronTenants: vi.fn(async () => ({ on: ["t-a"], dry: ["t-b"] })),
  recordRun: vi.fn(async () => {}),
}));

import { sendCustomerEmail, sendCustomerWhatsApp, sendInternalEmail, CustomerMessageRefusedError } from "./index";
import { gatedCron } from "@/lib/automation/cron-gate";
import { NextRequest, NextResponse } from "next/server";

const mail = (tenantId: string | null) => ({
  to: "cust@example.in", subject: "Hello", text: "x", kind: "test",
  ...(tenantId ? { route: { tenantId } } : {}),
});

beforeEach(() => { h.state = "off"; vi.clearAllMocks(); process.env.CRON_SECRET = "s"; });

describe("customer messages switch", () => {
  it("OFF (the default): email refused, recorded in email_log, sender never called", async () => {
    const r = await sendCustomerEmail(mail("t-a"));
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toMatch(/switched off/);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.recordEmail).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t-a", recipient: "cust@example.in" }), expect.objectContaining({ status: "failed" }));
    expect(h.automationState).toHaveBeenCalledWith("t-a", "customer_messages");
  });

  it("OFF: WhatsApp refused with CustomerMessageRefusedError, sender never called", async () => {
    await expect(sendCustomerWhatsApp({ tenantId: "t-a", to: "9999", message: { kind: "text", text: "hi" } }))
      .rejects.toBeInstanceOf(CustomerMessageRefusedError);
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
  });

  it("ON: email and WhatsApp go", async () => {
    h.state = "on";
    expect((await sendCustomerEmail(mail("t-a"))).status).toBe("sent");
    expect((await sendCustomerWhatsApp({ tenantId: "t-a", to: "9999", message: { kind: "text", text: "hi" } })).wamid).toBe("w1");
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  it("a message naming no company is refused even when ON", async () => {
    h.state = "on";
    expect((await sendCustomerEmail(mail(null))).status).toBe("failed");
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("internal mail is not gated", async () => {
    expect((await sendInternalEmail(mail("t-a"))).status).toBe("sent");
    expect(h.automationState).not.toHaveBeenCalled();
  });
});

describe("inside a cron pass", () => {
  const req = () => new NextRequest("http://localhost/api/cron/renewals", { headers: { authorization: "Bearer s" } });

  it("a company the job is not on for is refused; the practice-run company only counts", async () => {
    h.state = "on";
    const results: string[] = [];
    await gatedCron("renewals", async () => {
      results.push((await sendCustomerEmail(mail("t-a"))).status);
      results.push((await sendCustomerEmail(mail("t-b"))).status);
      results.push((await sendCustomerEmail(mail("t-c"))).status);
      return NextResponse.json({});
    })(req());
    /* live pass (t-a on): t-a sent, t-b and t-c refused; dry pass (t-b): t-a and t-c refused, t-b practice */
    expect(results).toEqual(["sent", "failed", "failed", "failed", "stubbed", "failed"]);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });
});
