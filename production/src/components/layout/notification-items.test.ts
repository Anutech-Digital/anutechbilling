import { describe, it, expect } from "vitest";
import { buildNotifications, newLeadTitle, NOTIFICATION_LIMIT, todayBoundsIST } from "./notification-items";
import type { NotificationRow } from "@/lib/supabase/database.types";
import type { TaskWithLink } from "@/lib/queries/tasks";

const NOW = Date.parse("2026-10-06T06:30:00Z"); // 12:00 IST
const DAY = 24 * 3600 * 1000;

function dbLead(id: string, leadId: string): NotificationRow {
  return {
    id, kind: "lead.created", title: "New enquiry — Acme", body: "Ravi · 5 seats",
    href: "/leads", entity_id: leadId, read_at: null, created_at: new Date(NOW - 3600_000).toISOString(),
  } as unknown as NotificationRow;
}

function task(id: string, dueMs: number): TaskWithLink {
  return {
    id, title: `Task ${id}`, status: "pending", due_at: new Date(dueMs).toISOString(), lead_id: null,
    leads: null, customers: null, quotes: null,
  } as unknown as TaskWithLink;
}

describe("buildNotifications (R-247)", () => {
  it("shows a website lead once, not as DB event + recent lead", () => {
    const items = buildNotifications({
      dbNotifs: [dbLead("n1", "L1")],
      leads: [
        { id: "L1", company: "Acme", value: null, contact_name: "Ravi", created_at: new Date(NOW - 3600_000).toISOString() },
        { id: "L2", company: "Beta", value: null, contact_name: null, created_at: new Date(NOW - 7200_000).toISOString() },
      ],
      readIds: new Set(), now: NOW,
    });
    expect(items.map((i) => i.id)).toEqual(["db-n1", "lead-L2"]);
  });

  it("never ends a title with '· ' when the company is blank", () => {
    expect(newLeadTitle({ company: "", contact_name: "Ravi" })).toBe("New lead · Ravi");
    expect(newLeadTitle({ company: "  ", contact_name: null })).toBe("New lead");
    const items = buildNotifications({
      leads: [{ id: "L3", company: "", value: null, contact_name: "", created_at: new Date(NOW - 60_000).toISOString() }],
      readIds: new Set(), now: NOW,
    });
    expect(items[0].title).toBe("New lead");
    for (const i of items) expect(i.title.trim().endsWith("·")).toBe(false);
  });

  it("keeps old overdue tasks when the list is over the cap", () => {
    const { start } = todayBoundsIST(NOW);
    const recentLeads = Array.from({ length: NOTIFICATION_LIMIT }, (_, n) => ({
      id: `R${n}`, company: `Co ${n}`, value: null, contact_name: null,
      created_at: new Date(NOW - (n + 1) * 60_000).toISOString(),
    }));
    const items = buildNotifications({
      tasks: [task("old", start - 20 * DAY), task("today", start + 3600_000)],
      leads: recentLeads,
      readIds: new Set(), now: NOW,
    });
    expect(items).toHaveLength(NOTIFICATION_LIMIT);
    expect(items.map((i) => i.id).slice(0, 2)).toEqual(["task-today", "task-old"]);
  });
});
