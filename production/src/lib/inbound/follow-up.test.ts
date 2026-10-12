import { describe, it, expect } from "vitest";
import { decideFollowUp, type FollowUpInput } from "./follow-up";

/**
 * The fixtures are the nine real inbound_emails rows in production on
 * 13 Aug 2026, because the point of this module is behaving correctly on the mail
 * this business actually receives.
 */
const base: FollowUpInput = { fromEmail: "someone@example.com", subject: "Hello", isEnquiry: true };

describe("hard suppressions beat the model — the safety property", () => {
  // extractWithGemini returns null on ANY failure and the webhook then defaults
  // isEnquiry to true so a real enquiry is never dropped. That default must not
  // put a bounce notice on someone's task list.
  const aiSaysYes = { isEnquiry: true as boolean | null };

  it("refuses a no-reply sender even when the model says it is an enquiry", () => {
    const d = decideFollowUp({ ...base, ...aiSaysYes, fromEmail: "no-reply@accounts.google.com", subject: "Security alert" });
    expect(d.create).toBe(false);
    expect(d.suppressedBy).toBe("robot_sender");
  });

  it("refuses every robot local-part shape", () => {
    for (const addr of [
      "noreply@google.com", "no_reply@x.in", "donotreply@x.in", "do-not-reply@x.in",
      "mailer-daemon@x.in", "postmaster@x.in", "bounces@x.in", "notifications@x.in",
      "alerts@x.in", "automated@x.in",
      // The real one from production, with a hashed local part.
      "no-reply-dngjqu_ppjzkqvpl2u-rea@mail.anthropic.com",
    ]) {
      const d = decideFollowUp({ ...base, ...aiSaysYes, fromEmail: addr });
      expect(d.create, addr).toBe(false);
      expect(d.suppressedBy, addr).toBe("robot_sender");
    }
  });

  it("refuses auto-replies and bounces by subject", () => {
    for (const subject of [
      "Automatic reply: your enquiry", "Out of office until Monday",
      "Undeliverable: Quote request", "Delivery Status Notification (Failure)",
      "Mail delivery failed: returning message to sender",
    ]) {
      const d = decideFollowUp({ ...base, ...aiSaysYes, subject });
      expect(d.create, subject).toBe(false);
      expect(d.suppressedBy, subject).toBe("auto_reply");
    }
  });

  it("refuses bulk mail on List-Unsubscribe, whatever the header casing", () => {
    for (const key of ["List-Unsubscribe", "list-unsubscribe", "LIST-UNSUBSCRIBE"]) {
      const d = decideFollowUp({ ...base, ...aiSaysYes, headers: { [key]: "<mailto:x@y.z>" } });
      expect(d.create, key).toBe(false);
      expect(d.suppressedBy, key).toBe("bulk_mail");
    }
  });

  it("refuses Precedence: bulk and Auto-Submitted (RFC 3834)", () => {
    expect(decideFollowUp({ ...base, headers: { Precedence: "bulk" } }).suppressedBy).toBe("bulk_mail");
    expect(decideFollowUp({ ...base, headers: { "Auto-Submitted": "auto-generated" } }).suppressedBy).toBe("auto_reply");
    // "no" is the only value that means a human sent it.
    expect(decideFollowUp({ ...base, headers: { "Auto-Submitted": "no" } }).create).toBe(true);
  });

  it("refuses an unusable sender address", () => {
    for (const from of ["", null, undefined, "not-an-address"]) {
      const d = decideFollowUp({ ...base, fromEmail: from as string });
      expect(d.create, String(from)).toBe(false);
    }
  });
});

describe("the model's verdict", () => {
  it("respects an explicit non-enquiry", () => {
    const d = decideFollowUp({ ...base, isEnquiry: false, subject: "Your seat was upgraded" });
    expect(d.create).toBe(false);
    expect(d.suppressedBy).toBe("not_an_enquiry");
  });

  it("creates NO task when triage did not run, even though the lead is still captured", () => {
    // The webhook defaults isEnquiry to true when Gemini fails, so the lead is
    // never lost. A task is a different bar: it interrupts a person, so it is not
    // created off a guess nobody checked.
    for (const v of [null, undefined]) {
      const d = decideFollowUp({ ...base, isEnquiry: v as boolean | null });
      expect(d.create).toBe(false);
      expect(d.suppressedBy).toBe("unclassified");
      expect(d.reason).toMatch(/lead is still captured/i);
    }
  });
});

describe("real production emails", () => {
  it("creates a high-priority task for the Microsoft 365 enquiry", () => {
    const d = decideFollowUp({
      fromEmail: "rohan@brightretail.in",
      subject: "Need Microsoft 365 Business Premium for 25 users",
      bodyText: "Please share pricing for 25 users.",
      isEnquiry: true,
    });
    expect(d.create).toBe(true);
    expect(d.priority).toBe("high");
    expect(d.dueInHours).toBe(4);
    expect(d.signals).toEqual(expect.arrayContaining([expect.stringContaining("quantity")]));
  });

  it("creates a task for the Hinglish quotation request", () => {
    const d = decideFollowUp({
      fromEmail: "pardeep@example.test",
      subject: "100 google workspace email id ke liye quotation chahiye",
      isEnquiry: true,
      isReplyToExistingLead: true,
    });
    expect(d.create).toBe(true);
    expect(d.priority).toBe("high");
    expect(d.signals.join(" ")).toMatch(/quot/i);
  });

  it("skips the Google security alert", () => {
    expect(decideFollowUp({
      fromEmail: "no-reply@accounts.google.com", subject: "Security alert", isEnquiry: false,
    }).create).toBe(false);
  });

  it("does NOT suppress the tenant's own domain", () => {
    // sales@anutech.in and pardeep@example.test both appear as senders in
    // production and correctly produce leads — staff forward enquiries in.
    // Suppressing own-domain would break a path that works today.
    const d = decideFollowUp({
      fromEmail: "sales@anutech.in",
      subject: "mujhe 20 google workspace account chahiye",
      isEnquiry: true,
    });
    expect(d.create).toBe(true);
  });
});

describe("priority and due date", () => {
  const at = (over: Partial<FollowUpInput>) => decideFollowUp({ ...base, ...over });

  it("is high when money and urgency are both present", () => {
    const d = at({ subject: "Urgent: need a quote today" });
    expect(d.priority).toBe("high");
    expect(d.dueInHours).toBe(4);
  });

  it("is medium on a single strong signal", () => {
    const d = at({ subject: "Pricing for Google Workspace" });
    expect(d.priority).toBe("medium");
    expect(d.dueInHours).toBe(24);
  });

  it("is low on a bare enquiry with no signal", () => {
    const d = at({ subject: "Hello" });
    expect(d.priority).toBe("low");
    expect(d.dueInHours).toBe(72);
  });

  it("reads Hinglish urgency, which this business actually receives", () => {
    expect(at({ subject: "quotation jaldi bhej do" }).priority).toBe("high");
    expect(at({ subject: "abhi price chahiye" }).priority).toBe("high");
  });

  it("counts a quantity as a real buying signal", () => {
    expect(at({ subject: "50 seats required" }).signals.join(" ")).toMatch(/quantity/);
    expect(at({ subject: "25 licenses" }).signals.join(" ")).toMatch(/quantity/);
  });

  it("ranks a reply on an open lead above an identical cold email", () => {
    const cold  = at({ subject: "Interested in Workspace" });
    const reply = at({ subject: "Interested in Workspace", isReplyToExistingLead: true });
    const order = { low: 0, medium: 1, high: 2 } as const;
    expect(order[reply.priority]).toBeGreaterThanOrEqual(order[cold.priority]);
  });

  it("explains itself — every task carries the signals that raised it", () => {
    const d = at({ subject: "urgent quote for 30 users" });
    expect(d.signals.length).toBeGreaterThanOrEqual(3);
    expect(d.reason).toMatch(/urgency/);
  });
});

describe("scanning limits and robustness", () => {
  it("ignores a signal buried deep in a quoted thread", () => {
    // A months-old quoted reply must not set today's priority. Only the head of
    // the body is scanned.
    const d = decideFollowUp({
      ...base, subject: "Thanks",
      bodyText: "ok\n".repeat(3000) + " urgent quote for 100 users ",
    });
    expect(d.priority).toBe("low");
  });

  it("never throws on missing or odd input", () => {
    for (const input of [
      { ...base, subject: null, bodyText: null },
      { ...base, subject: "", bodyText: "" },
      { ...base, headers: {} },
      { ...base, headers: null },
      { fromEmail: "a@b.c", subject: undefined, isEnquiry: true },
    ] as FollowUpInput[]) {
      expect(() => decideFollowUp(input)).not.toThrow();
    }
  });

  it("always produces a usable, bounded title when it creates a task", () => {
    const d = decideFollowUp({ ...base, subject: "x".repeat(400) });
    expect(d.create).toBe(true);
    expect(d.title.length).toBeLessThanOrEqual(120);
    expect(d.title.startsWith("Follow up:")).toBe(true);
  });

  it("falls back to the AI summary when there is no subject", () => {
    const d = decideFollowUp({ ...base, subject: "", summary: "Wants 40 Zoho mailboxes" });
    expect(d.title).toContain("Wants 40 Zoho mailboxes");
  });

  it("leaves title empty and due at zero when it does not create a task", () => {
    const d = decideFollowUp({ ...base, isEnquiry: false });
    expect(d.title).toBe("");
    expect(d.dueInHours).toBe(0);
  });
});
