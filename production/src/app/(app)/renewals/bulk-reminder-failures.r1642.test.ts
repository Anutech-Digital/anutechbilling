/* R-1642 — the Renewals "Bulk reminder" said only "N failed". The owner could not tell
   WHICH customers did not get their reminder, or why, and had to run the whole batch
   again (re-emailing the ones that did go). Now each failure keeps the customer name and
   the reason, the toast names them, and "Retry failed" re-sends only those. */
import { describe, it, expect } from "vitest";
import { sendBulkReminders, bulkReminderReport, type RenewalRowLike } from "./reminders";

const row = (id: string, name: string): RenewalRowLike => ({
  sub: { id, customer_name: name, renewal_state: null, renewal_date: "2026-11-01", term_months: 12 } as RenewalRowLike["sub"],
  daysUntil: 8,
});

describe("R-1642 — sendBulkReminders keeps who failed and why", () => {
  it("collects name + reason per failure, counts the sent ones", async () => {
    const targets = [row("a", "Acme Pvt Ltd"), row("b", "Bharat Traders"), row("c", "Chola Foods")];
    const r = await sendBulkReminders(targets, async (id) => {
      if (id === "b") return { ok: false, json: { error: "This customer has no email address. Add one on the customer page." } };
      if (id === "c") throw new TypeError("Failed to fetch");
      return { ok: true, json: { email_mode: "live" } };
    });
    expect(r.sent).toBe(1);
    expect(r.failed.map((f) => f.name)).toEqual(["Bharat Traders", "Chola Foods"]);
    expect(r.failed[0].reason).toBe("This customer has no email address. Add one on the customer page.");
    expect(r.failed[1].reason).toBe("Network problem."); // raw fetch text mapped, never shown as-is
    expect(r.failed.map((f) => f.row.sub.id)).toEqual(["b", "c"]); // what "Retry failed" re-sends
  });

  it("maps database plumbing in the server's error to plain words", async () => {
    const r = await sendBulkReminders([row("a", "Acme")], async () => ({
      ok: false, json: { error: 'null value in column "email" violates not-null constraint' },
    }));
    expect(r.failed[0].reason).toBe("A required field is empty.");
  });
});

describe("R-1642 — bulkReminderReport names the failed customers", () => {
  it("partial run: warning naming the failures, with the reason", () => {
    const m = bulkReminderReport({ sent: 4, stub: false, failed: [{ name: "Bharat Traders", reason: "No email address.", row: row("b", "Bharat Traders") }] });
    expect(m.tone).toBe("warning");
    expect(m.title).toBe("Reminded 4 customers · 1 refused");
    expect(m.description).toContain("Bharat Traders — No email address.");
    expect(m.retry).toBe(true);
  });

  it("all failed: error naming them", () => {
    const m = bulkReminderReport({ sent: 0, stub: false, failed: [
      { name: "A", reason: "x", row: row("a", "A") }, { name: "B", reason: "y", row: row("b", "B") },
    ] });
    expect(m.tone).toBe("error");
    expect(m.title).toBe("Could not remind 2 customers");
    expect(m.description).toBe("A — x; B — y");
  });

  it("all sent: success, no retry", () => {
    const m = bulkReminderReport({ sent: 3, stub: false, failed: [] });
    expect(m.tone).toBe("success");
    expect(m.title).toBe("Reminded 3 customers");
    expect(m.retry).toBe(false);
  });

  it("stub mode is said, not hidden", () => {
    expect(bulkReminderReport({ sent: 2, stub: true, failed: [] }).title).toMatch(/stub mode/);
  });
});
