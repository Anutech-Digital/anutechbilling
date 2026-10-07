/**
 * The notification panel's list, as a plain function so it can be tested (R-247).
 *
 * Three audit bugs lived in the old inline useMemo:
 *   • a lead from the website showed twice — once as the DB "lead.created" event and
 *     again from the recent-leads list. The recent-leads copy is now skipped when a DB
 *     event already names that lead (entity_id).
 *   • a lead with no company read "New lead · " — the title now falls back to the
 *     contact name, and to plain "New lead" when both are empty.
 *   • slice(0, 30) after a newest-first sort dropped the OLDEST overdue tasks — the ones
 *     that need doing most. Tasks due today / overdue now come first, then the rest.
 */
import { rupee, formatDate, toWhatsAppDigits } from "@/lib/utils";
import type { NotificationRow } from "@/lib/supabase/database.types";
import type { TaskWithLink } from "@/lib/queries/tasks";
import type { Celebration } from "@/lib/queries/contacts";

export type NotifTone = "emerald" | "indigo" | "amber" | "rose" | "slate";

export interface NotificationItem {
  id: string;
  title: string;
  meta: string;
  icon: string;
  tone: NotifTone;
  unread: boolean;
  link: string;
  when: number; // ms, for sorting
  /** When set, the item shows a 1-tap WhatsApp "Wish" button (birthdays). */
  wishHref?: string;
  /** Tasks due today or overdue — listed before everything else so the cap never drops them. */
  actionable?: boolean;
}

export interface RecentLead {
  id: string;
  company: string | null;
  value: number | null;
  contact_name: string | null;
  created_at: string;
}

export const NOTIFICATION_LIMIT = 30;

const KIND_META: Record<string, { icon: string; tone: NotifTone }> = {
  "payment.received": { icon: "rupee",  tone: "emerald" },
  "quote.accepted":   { icon: "check",  tone: "emerald" },
  "lead.created":     { icon: "target", tone: "amber"   },
  "ticket.created":   { icon: "help",   tone: "indigo"  },
};

/** End-of-today and start-of-today as UTC ms, computed in IST (matches the
 *  tasks query's day boundary so "due today / overdue" agrees with the badge). */
export function todayBoundsIST(now = Date.now()) {
  const istNow = new Date(now + 5.5 * 3600 * 1000);
  const endMs = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1) - 5.5 * 3600 * 1000;
  return { start: endMs - 24 * 3600 * 1000, end: endMs };
}

/** "New lead · Acme", "New lead · Ravi" when the company is blank, else just "New lead". */
export function newLeadTitle(lead: Pick<RecentLead, "company" | "contact_name">): string {
  const name = lead.company?.trim() || lead.contact_name?.trim();
  return name ? `New lead · ${name}` : "New lead";
}

export function buildNotifications(input: {
  dbNotifs?: NotificationRow[] | null;
  tasks?: TaskWithLink[] | null;
  leads?: RecentLead[] | null;
  celebrations?: Celebration[] | null;
  readIds: Set<string>;
  now?: number;
}): NotificationItem[] {
  const now = input.now ?? Date.now();
  const out: NotificationItem[] = [];
  const { start, end } = todayBoundsIST(now);

  // 0. Asli events (DB) — payment/quote/lead/ticket; yahi badge ke pehle chalak hain.
  const leadsInDb = new Set<string>();
  for (const n of input.dbNotifs ?? []) {
    const km = KIND_META[n.kind] ?? { icon: "bell", tone: "slate" as NotifTone };
    if (n.kind === "lead.created" && n.entity_id) leadsInDb.add(n.entity_id);
    out.push({
      id: `db-${n.id}`,
      title: n.title,
      meta: `${n.body ? n.body + " · " : ""}${formatDate(n.created_at)}`,
      icon: km.icon,
      tone: km.tone,
      unread: !n.read_at,
      link: n.href ?? "/dashboard",
      when: new Date(n.created_at).getTime(),
    });
  }

  // 1. Actionable: tasks due today or overdue (pending / snoozed only).
  for (const t of input.tasks ?? []) {
    if (t.status !== "pending" && t.status !== "snoozed") continue;
    const due = new Date(t.due_at).getTime();
    if (due >= end) continue; // future tasks aren't "notifications" yet
    const overdue = due < start;
    const who = t.leads?.company || t.customers?.name || t.quotes?.customer_name || null;
    out.push({
      id: `task-${t.id}`,
      title: t.title,
      meta: `${overdue ? "Overdue" : "Due today"}${who ? ` · ${who}` : ""} · ${formatDate(t.due_at)}`,
      icon: overdue ? "alert" : "clock",
      tone: overdue ? "rose" : "amber",
      unread: !input.readIds.has(`task-${t.id}`),
      link: t.lead_id ? `/leads?lead=${t.lead_id}` : "/tasks",
      when: due,
      actionable: true,
    });
  }

  // 2. Informational: leads that arrived in the last 7 days — unless a DB event already shows it.
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  for (const l of input.leads ?? []) {
    if (leadsInDb.has(l.id)) continue;
    const created = new Date(l.created_at).getTime();
    if (created < weekAgo) continue;
    const contact = l.contact_name?.trim();
    // The contact name moves into the title when there is no company — don't print it twice.
    const showContact = contact && l.company?.trim();
    out.push({
      id: `lead-${l.id}`,
      title: newLeadTitle(l),
      meta: `${formatDate(l.created_at)}${l.value ? ` · ${rupee(l.value, { compact: true })}` : ""}${showContact ? ` · ${contact}` : ""}`,
      icon: "target",
      tone: "amber",
      unread: false, // info, doesn't drive the unread dot
      link: `/leads?lead=${l.id}`,
      when: created,
    });
  }

  // 3. Relationship: upcoming birthdays / anniversaries (next 7 days).
  //    Today's celebration drives the unread dot ("wish them NOW"); the rest
  //    are a gentle heads-up. Each carries a 1-tap WhatsApp wish.
  for (const c of input.celebrations ?? []) {
    const first = c.name.split(" ")[0] || c.name;
    const isBday = c.kind === "birthday";
    const whenLabel = c.inDays === 0 ? "Today" : c.inDays === 1 ? "Tomorrow" : `in ${c.inDays} days`;
    const wa = toWhatsAppDigits(c.phone);
    const wishText = isBday
      ? `Happy Birthday ${first}! 🎂🎉 Aapka din shubh aur mangalmay ho.`
      : `Happy Anniversary ${first}! 💐🎉 Dher saari shubhkaamnaayein.`;
    out.push({
      id: `celebration-${c.id}`,
      title: `${isBday ? "🎂" : "💍"} ${c.name}'s ${c.kind}`,
      meta: `${whenLabel}${c.age != null ? ` · turning ${c.age}` : ""} · ${formatDate(c.dateISO)}`,
      icon: "sparkles",
      tone: isBday ? "amber" : "indigo",
      unread: c.inDays === 0,           // only today's nudges the badge
      link: `/contacts/${c.contactId}`,
      // Sort so nearer celebrations sit higher, just under today's tasks.
      when: now - c.inDays * 3_600_000,
      wishHref: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(wishText)}` : undefined,
    });
  }

  // Tasks first (so the cap can't drop an old overdue one), newest first within each group.
  return out
    .sort((a, b) => Number(!!b.actionable) - Number(!!a.actionable) || b.when - a.when)
    .slice(0, NOTIFICATION_LIMIT);
}
