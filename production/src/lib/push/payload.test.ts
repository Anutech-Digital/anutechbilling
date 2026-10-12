import { describe, it, expect } from "vitest";
import { pushPayload, dispositionForStatus, isPushDelivered, categoryFor, deviceWants } from "./payload";

describe("what a push says", () => {
  it("sends the attendance reminder to the screen that fixes it", () => {
    /* A notification that lands you on the dashboard, where there is no check-in button,
       is a nag with no exit — the same dead-end §24 forbids in the UI. */
    expect(pushPayload({ kind: "attendance_checkin" }).url).toBe("/attendance/me");
    expect(pushPayload({ kind: "attendance_checkout" }).url).toBe("/attendance/me");
  });

  it("collapses a repeated reminder instead of stacking it", () => {
    /* Same tag = replace. A cron that fires at 10:00 and again at 11:00 should leave ONE
       reminder that moved, not two identical ones that teach people to swipe them away. */
    const a = pushPayload({ kind: "attendance_checkin", name: "Pratik" });
    const b = pushPayload({ kind: "attendance_checkin", name: "Pratik" });
    expect(a.tag).toBe(b.tag);
  });

  it("never collapses two payments, because they are two facts", () => {
    const a = pushPayload({ kind: "payment_received", amount: 20000, customer: "deltaco" });
    const b = pushPayload({ kind: "payment_received", amount: 18232, customer: "deltaco" });
    expect(a.tag).not.toBe(b.tag);
  });

  it("writes money in Indian digit grouping", () => {
    const p = pushPayload({ kind: "payment_received", amount: 500000, customer: "POP TECH" });
    expect(p.title).toContain("₹5,00,000");
    expect(p.title).not.toContain("500,000");
  });

  it("keeps every url a path on this app, never an absolute link", () => {
    const events = [
      { kind: "attendance_checkin" as const },
      { kind: "attendance_checkout" as const },
      { kind: "new_lead" as const, company: "Acme" },
      { kind: "payment_received" as const, amount: 1, customer: "x" },
      { kind: "quote_accepted" as const, quoteId: "Q-1", customer: "x" },
      { kind: "test" as const },
    ];
    for (const e of events) {
      const url = pushPayload(e).url;
      expect(url.startsWith("/"), `${e.kind} → ${url}`).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  it("says something in both the title and the body, always", () => {
    /* An empty body renders as a blank grey box on Android and reads as a broken app. */
    const events = [
      { kind: "attendance_checkin" as const },
      { kind: "new_lead" as const, company: "Acme" },
      { kind: "quote_accepted" as const, quoteId: "Q-1", customer: "Acme" },
      { kind: "test" as const },
    ];
    for (const e of events) {
      const p = pushPayload(e);
      expect(p.title.trim().length, e.kind).toBeGreaterThan(0);
      expect(p.body.trim().length, e.kind).toBeGreaterThan(0);
    }
  });

  it("names the lead, and only mentions a value when there is one", () => {
    expect(pushPayload({ kind: "new_lead", company: "Acme" }).body).toBe("Acme");
    expect(pushPayload({ kind: "new_lead", company: "Acme", value: 40800 }).body).toContain("₹40,800");
    /* A zero-value lead must not read as "₹0" — that looks like a priced deal worth
       nothing rather than a deal nobody has priced. */
    expect(pushPayload({ kind: "new_lead", company: "Acme", value: 0 }).body).toBe("Acme");
  });
});

describe("when to throw a subscription away", () => {
  it("deletes only the two codes that mean permanently gone", () => {
    expect(dispositionForStatus(404)).toBe("delete");
    expect(dispositionForStatus(410)).toBe("delete");
  });

  it("NEVER deletes on an auth failure — that is our key, not their device", () => {
    /* 401/403 means the VAPID key is wrong, so EVERY subscription fails at once.
       Deleting on those codes would wipe every device in the tenant on the first bad
       deploy, and nobody would find out until the day a notification mattered. */
    expect(dispositionForStatus(401)).toBe("config-error");
    expect(dispositionForStatus(403)).toBe("config-error");
  });

  it("keeps the subscription when the push service is just having a bad minute", () => {
    for (const s of [429, 500, 502, 503, 504]) {
      expect(dispositionForStatus(s), String(s)).toBe("keep");
    }
  });

  it("treats an unknown code as keep, because guessing costs a real device", () => {
    for (const s of [0, 302, 418, 451]) {
      expect(dispositionForStatus(s), String(s)).toBe("keep");
    }
  });

  it("counts 201 as delivered — that is what the spec returns", () => {
    expect(isPushDelivered(201)).toBe(true);
    expect(isPushDelivered(200)).toBe(true);
    expect(isPushDelivered(400)).toBe(false);
    expect(isPushDelivered(410)).toBe(false);
  });
});

/* ── Offers are a separate consent, not a separate sentence ─────────────────── */

describe("work alerts and offers are different permissions", () => {
  it("files an offer under offers and everything else under operational", () => {
    expect(categoryFor({ kind: "offer", title: "20% off", body: "This month" })).toBe("offers");
    for (const e of [
      { kind: "attendance_checkin" as const },
      { kind: "attendance_checkout" as const },
      { kind: "new_lead" as const, company: "Acme" },
      { kind: "payment_received" as const, amount: 1, customer: "x" },
      { kind: "quote_accepted" as const, quoteId: "Q-1", customer: "x" },
      { kind: "test" as const },
    ]) {
      expect(categoryFor(e), e.kind).toBe("operational");
    }
  });

  it("refuses to deliver a category the device never agreed to", () => {
    /* The whole point. A device that only took work alerts must never get an offer —
       otherwise the person revokes the permission and the payment alerts go too. */
    expect(deviceWants(["operational"], "offers")).toBe(false);
    expect(deviceWants(["operational"], "operational")).toBe(true);
    expect(deviceWants(["operational", "offers"], "offers")).toBe(true);
  });

  it("treats missing or malformed consent as no consent", () => {
    /* A null column, a failed read, an old row — none of those are permission. */
    expect(deviceWants(null, "operational")).toBe(false);
    expect(deviceWants(undefined, "offers")).toBe(false);
    expect(deviceWants([], "operational")).toBe(false);
    expect(deviceWants(["OFFERS"], "offers")).toBe(false); // case matters; no fuzzy matching
  });
});

describe("an offer's payload is checked, not trusted — a human types it", () => {
  it("never ships an empty title", () => {
    /* A nameless notification renders as a grey box and reads as a broken app. */
    expect(pushPayload({ kind: "offer", title: "   ", body: "Something" }).title).toBe("ResellerOS");
  });

  it("drops a url that is not a path on this app", () => {
    for (const url of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "mailto:x@y.z"]) {
      expect(pushPayload({ kind: "offer", title: "T", body: "B", url }).url, url).toBe("/dashboard");
    }
    expect(pushPayload({ kind: "offer", title: "T", body: "B", url: "/coupons" }).url).toBe("/coupons");
  });

  it("gives two different announcements two different tags", () => {
    const a = pushPayload({ kind: "offer", title: "20% off Workspace", body: "x" });
    const b = pushPayload({ kind: "offer", title: "Free migration", body: "x" });
    expect(a.tag).not.toBe(b.tag);
  });
});
