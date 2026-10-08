import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bulkReminderTargets,
  bulkReminderConfirm,
  sendNowStep,
  sendNowConfirm,
  sentToastText,
  matchesRenewalSearch,
  readJsonSafe,
  type RenewalRowLike,
} from "./reminders";

const sub = (over: Partial<RenewalRowLike["sub"]> = {}): RenewalRowLike["sub"] => ({
  id: "s1",
  customer_name: "Acme Pvt Ltd",
  domain: "acme.in",
  renewal_state: "pending",
  renewal_date: "2026-10-20",
  term_months: 12,
  ...over,
});

describe("R-239 bulk reminder", () => {
  it("never targets renewed or suspended subscriptions", () => {
    const t = bulkReminderTargets([
      { sub: sub({ id: "a" }), daysUntil: 5 },
      { sub: sub({ id: "b", renewal_state: "renewed" }), daysUntil: 5 },
      { sub: sub({ id: "c", renewal_state: "suspended" }), daysUntil: 5 },
      { sub: sub({ id: "d" }), daysUntil: 45 },
      { sub: sub({ id: "e" }), daysUntil: -2 },
    ]);
    expect(t.map((r) => r.sub.id)).toEqual(["a"]);
  });

  it("confirm states the true count and the first 5 names", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ sub: sub({ id: `s${i}`, customer_name: `C${i}` }), daysUntil: 3 }));
    const c = bulkReminderConfirm(rows);
    expect(c.title).toBe("Email 7 customers?");
    expect(c.body).toContain("C0, C1, C2, C3, C4");
    expect(c.body).toContain("and 2 more");
    expect(c.body).not.toContain("C5");
    expect(bulkReminderConfirm(rows.slice(0, 1)).title).toBe("Email 1 customer?");
  });
});

describe("R-239 send now", () => {
  it("predicts the step the server will send (same cadence rule)", () => {
    const today = new Date("2026-10-06T06:00:00Z");
    expect(sendNowStep(sub({ renewal_date: "2026-10-20" }), 0, today)).toBe("notice_sent");
    expect(sendNowStep(sub({ renewal_date: "2026-12-30" }), 0, today)).toBe("notice_sent"); // pending → notice_sent
    expect(sendNowStep(sub({ renewal_date: "2026-10-03" }), 7, today)).toBe("grace_period");
  });

  it("confirm names the customer and the email", () => {
    const c = sendNowConfirm(sub(), "reminder_1");
    expect(c.title).toContain("Acme Pvt Ltd");
    expect(c.body).toContain("Reminder 1 (T-12)");
  });

  it("success toast uses the label, never the raw state key", () => {
    const t = sentToastText({ status: "sent", step: "notice_sent" }, "Acme");
    expect(t).toBe("Sent “Notice sent (T-15)” to Acme");
    expect(t).not.toMatch(/notice_sent/);
    expect(sentToastText({ status: "logged", step: "weird_step" }, "Acme")).toBe("Logged renewal email to Acme");
  });
});

describe("R-239 search", () => {
  it("matches customer name and domain, case-insensitive", () => {
    expect(matchesRenewalSearch(sub(), "")).toBe(true);
    expect(matchesRenewalSearch(sub(), "acme")).toBe(true);
    expect(matchesRenewalSearch(sub(), "ACME.IN")).toBe(true);
    expect(matchesRenewalSearch(sub(), "globex")).toBe(false);
    expect(matchesRenewalSearch(sub({ domain: null }), "acme")).toBe(true);
  });
});

describe("R-239 server errors", () => {
  it("an HTML 500 does not become 'Unexpected token <'", async () => {
    const res = new Response("<html>Internal Server Error</html>", { status: 500 });
    const j = await readJsonSafe(res);
    expect(j.error).toBe("Server error (500)");
  });
  it("JSON body passes through", async () => {
    const res = new Response(JSON.stringify({ error: "No email on file" }), { status: 400 });
    expect((await readJsonSafe(res)).error).toBe("No email on file");
  });
});

describe("R-239 page wiring", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.tsx"), "utf8");
  it("bulk + send now ask first", () => {
    expect(src).toMatch(/bulkReminderConfirm\(/);
    expect(src).toMatch(/sendNowConfirm\(/);
    expect(src).toMatch(/await confirm\(/);
  });
  it("no raw error text or raw step in toasts", () => {
    expect(src).not.toMatch(/Failed: \$\{/);
    expect(src).not.toMatch(/Send failed: \$\{/);
    expect(src).not.toMatch(/\$\{json\.step\}/);
  });
  it("search filters all three buckets", () => {
    expect(src).toMatch(/matchesRenewalSearch\(/);
  });
});
