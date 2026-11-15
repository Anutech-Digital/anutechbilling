/**
 * R-2852 — a member of a renewal quote billed together logs its reminder step as skipped (the lead
 * subscription's reminder covers the quote). The drawer must say that, never "no contact email".
 */
import { describe, it, expect } from "vitest";
import { drawerReminderRows } from "./reminder-log";
import { TOGETHER_SKIP_RECIPIENT } from "@/lib/renewals/together-reminder";

describe("R-2852 reminder rows", () => {
  it("a billed-together skip reads as such, with no recipient and not counted; a no-contact skip is unchanged", () => {
    const rows = drawerReminderRows({
      email: [
        { id: "t", cadence_step: "reminder_1", recipient_email: TOGETHER_SKIP_RECIPIENT, status: "skipped", sent_at: "2026-10-02T04:00:00Z" },
        { id: "k", cadence_step: "reminder_3", recipient_email: "(missing)", status: "skipped", sent_at: "2026-10-01T04:00:00Z" },
      ],
      whatsapp: [],
    });
    expect(rows.map((r) => [r.status, r.reached, r.to])).toEqual([
      ["Not sent on its own — billed together; the quote's reminder went with the other subscription", false, null],
      ["Not sent — no contact email", false, null],
    ]);
  });
});
