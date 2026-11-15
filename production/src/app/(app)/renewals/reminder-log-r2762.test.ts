/**
 * R-2762 — Renewals drawer Follow-ups: every renewal reminder sent for the subscription (date,
 * channel, step, to whom) with the count, newest first, from renewal_email_log + whatsapp_reminder_log.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { drawerReminderRows, reminderLogWords, REMINDER_LOG_MAX, type ReminderLog } from "./reminder-log";

const log = (over: Partial<ReminderLog> = {}): ReminderLog => ({ email: [], whatsapp: [], ...over });

describe("R-2762 reminder rows", () => {
  it("lists email + WhatsApp reminders newest first, with channel, step, recipient and status", () => {
    const rows = drawerReminderRows(log({
      email: [
        { id: "e1", cadence_step: "early_notice", recipient_email: "a@x.in", status: "sent", sent_at: "2026-10-01T04:00:00Z" },
        { id: "e2", cadence_step: "reminder_1", recipient_email: "a@x.in", status: "sent", sent_at: "2026-10-19T04:00:00Z" },
      ],
      whatsapp: [{ id: "w1", kind: "renewal_upcoming", phone: "+919800000000", status: "read", sent_at: "2026-10-10T04:00:00Z", created_at: "2026-10-10T03:59:00Z" }],
    }));
    expect(rows.map((r) => r.id)).toEqual(["email:e2", "whatsapp:w1", "email:e1"]);
    expect(rows[0]).toMatchObject({ channel: "Email", what: "Reminder 1 (T-12)", to: "a@x.in", status: "Sent", reached: true, when: "19 Oct 2026" });
    expect(rows[1]).toMatchObject({ channel: "WhatsApp", what: "Renewal coming up", to: "+919800000000", status: "Read", reached: true });
    expect(rows[2].what).toBe("Early notice (T-30)");
  });

  it("a stubbed / failed / skipped email is listed but never counted as sent", () => {
    const rows = drawerReminderRows(log({
      email: [
        { id: "s", cadence_step: "notice_sent", recipient_email: "a@x.in", status: "stubbed", sent_at: "2026-10-03T04:00:00Z" },
        { id: "f", cadence_step: "reminder_2", recipient_email: "a@x.in", status: "failed", sent_at: "2026-10-02T04:00:00Z" },
        { id: "k", cadence_step: "reminder_3", recipient_email: "(missing)", status: "skipped", sent_at: "2026-10-01T04:00:00Z" },
      ],
    }));
    expect(rows.map((r) => [r.status, r.reached, r.to])).toEqual([
      ["Not sent — email sending is not set up", false, "a@x.in"],
      ["Failed to send", false, "a@x.in"],
      ["Not sent — no contact email", false, null],
    ]);
    expect(reminderLogWords(rows, { reminder_count: 3 })).toBe("No reminder sent yet · 3 tries not sent");
  });

  it("WhatsApp without sent_at is dated by created_at; an unknown step reads in plain words", () => {
    const [r] = drawerReminderRows(log({ whatsapp: [{ id: "w", kind: "renewal_grace", phone: null, status: "sent", sent_at: null, created_at: "2026-11-02T10:00:00Z" }] }));
    expect(r).toMatchObject({ when: "2 Nov 2026", what: "Grace period", to: null, status: "Sent" });
    const [e] = drawerReminderRows(log({ email: [{ id: "e", cadence_step: "manual_note", recipient_email: "a@x.in", status: "sent", sent_at: "2026-11-02T10:00:00Z" }] }));
    expect(e.what).toBe("Manual note");
  });

  it("no log (not loaded / failed) → no rows", () => {
    expect(drawerReminderRows(null)).toEqual([]);
    expect(drawerReminderRows(undefined)).toEqual([]);
  });
});

describe("R-2762 Reminders line", () => {
  const rows = drawerReminderRows(log({
    email: [
      { id: "e1", cadence_step: "early_notice", recipient_email: "a@x.in", status: "sent", sent_at: "2026-10-01T04:00:00Z" },
      { id: "e2", cadence_step: "reminder_1", recipient_email: "a@x.in", status: "sent", sent_at: "2026-11-02T04:00:00Z" },
      { id: "e3", cadence_step: "reminder_2", recipient_email: "a@x.in", status: "failed", sent_at: "2026-11-05T04:00:00Z" },
    ],
    whatsapp: [{ id: "w1", kind: "renewal_upcoming", phone: "+91", status: "delivered", sent_at: "2026-10-10T04:00:00Z", created_at: "2026-10-10T04:00:00Z" }],
  }));

  it("count + channels + the last one that went out (not the last try)", () => {
    expect(reminderLogWords(rows, { reminder_count: 9 })).toBe("3 reminders sent (2 email, 1 WhatsApp) · last 2 Nov 2026 · 1 try not sent");
  });

  it("one channel only says which", () => {
    expect(reminderLogWords(rows.filter((r) => r.channel === "WhatsApp"), {})).toBe("1 reminder sent by WhatsApp · last 10 Oct 2026");
    expect(reminderLogWords(rows.filter((r) => r.channel === "Email" && r.reached), {})).toBe("2 reminders sent by email · last 2 Nov 2026");
  });

  it("empty logs → the subscription's counter; nothing at all → No reminder sent yet", () => {
    expect(reminderLogWords([], { reminder_count: 0 })).toBe("No reminder sent yet");
    expect(reminderLogWords([], {})).toBe("No reminder sent yet");
    expect(reminderLogWords([], { reminder_count: 2, last_reminder_sent_at_v2: "2026-11-02T05:00:00Z" })).toBe("2 reminders sent · last 2 Nov 2026");
  });
});

describe("R-2762 the read (drawer-data.ts)", () => {
  const src = readFileSync(new URL("./drawer-data.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function readReminderLog"), src.indexOf("export function useRenewalDrawerData"));

  it("reads both logs for THIS subscription in one parallel step, tenant-scoped, browser client (RLS), capped", () => {
    expect(fn).toMatch(/Promise\.all\(/);
    expect(fn).toMatch(/from\("renewal_email_log"\)[\s\S]*\.eq\("subscription_id", subId\)[\s\S]*order\("sent_at", \{ ascending: false \}\)[\s\S]*limit\(REMINDER_LOG_MAX\)/);
    expect(fn).toMatch(/from\("whatsapp_reminder_log"\)[\s\S]*\.eq\("subject_type", "subscription"\)[\s\S]*\.eq\("subject_id", subId\)[\s\S]*\.in\("status", \[\.\.\.WA_SENT_STATUSES\]\)/);
    expect(fn.match(/\.eq\("tenant_id", tenantId\)/g)?.length).toBe(2);
    expect(src).toMatch(/createClient\(\)/);
    expect(src).not.toMatch(/service[_-]?role|createAdminClient|SUPABASE_SERVICE/i);
    expect(REMINDER_LOG_MAX).toBeGreaterThanOrEqual(50);
  });

  it("is part of the drawer's one query (no extra request per row) and a log failure never hides the documents", () => {
    const hook = src.slice(src.indexOf("export function useRenewalDrawerData"));
    expect(hook).toMatch(/Promise\.all\(\[[\s\S]*readReminderLog\(/);
    expect(fn).toMatch(/return null/);
    expect(hook).toMatch(/last_reminder_sent_at_v2/);   // a new reminder re-reads it
  });
});
