import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNotifications, countUnread, newLeadTitle, notifReadStore, NOTIFICATION_LIMIT, todayBoundsIST } from "./notification-items";
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

describe("badge = panel unread count (R-1122)", () => {
  const tasks = [task("a", NOW - 2 * DAY), task("b", NOW - DAY), task("c", NOW)];

  it("3 due tasks: Mark all read takes the count to 0, a new overdue task brings it back", () => {
    const before = buildNotifications({ tasks, readIds: new Set(), now: NOW });
    expect(countUnread(before)).toBe(3);

    const read = new Set(before.map((n) => n.id));
    expect(countUnread(buildNotifications({ tasks, readIds: read, now: NOW }))).toBe(0);

    const more = [...tasks, task("d", NOW - 3 * DAY)];
    expect(countUnread(buildNotifications({ tasks: more, readIds: read, now: NOW }))).toBe(1);
  });

  it("an opened task stops counting; a DB event counts until its read_at is set", () => {
    const db = dbLead("n1", "L1");
    const items = buildNotifications({ dbNotifs: [db], tasks, readIds: new Set(["task-a"]), now: NOW });
    expect(countUnread(items)).toBe(3); // b, c, n1

    const readDb = { ...db, read_at: new Date(NOW).toISOString() } as NotificationRow;
    expect(countUnread(buildNotifications({ dbNotifs: [readDb], tasks, readIds: new Set(["task-a"]), now: NOW }))).toBe(2);
  });
});

describe("shared read-state store (R-1122: bell and panel read the same set)", () => {
  it("markRead reaches every subscriber and the next snapshot", () => {
    const seen: number[] = [];
    const off = notifReadStore.subscribe(() => seen.push(notifReadStore.getSnapshot().size));
    const start = notifReadStore.getSnapshot().size;
    notifReadStore.markRead(["task-x", "task-y"]);
    expect(notifReadStore.getSnapshot().has("task-x")).toBe(true);
    expect(seen).toEqual([start + 2]);
    // Same ids again: same snapshot, no notify (useSyncExternalStore must not loop).
    const snap = notifReadStore.getSnapshot();
    notifReadStore.markRead(["task-x"]);
    expect(notifReadStore.getSnapshot()).toBe(snap);
    expect(seen).toHaveLength(1);
    off();
  });
});

describe("topbar badge uses the panel's count (R-1122)", () => {
  it("does not add the raw due-task count any more", () => {
    const src = readFileSync(join(__dirname, "topbar.tsx"), "utf8");
    expect(src).not.toMatch(/useTaskCountDueOrOverdue/);
    expect(src).toMatch(/useNotificationFeed\(/);
  });
});
