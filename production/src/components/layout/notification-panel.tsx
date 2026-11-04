/**
 * NotificationPanel — slide-out (Sheet) showing REAL recent events for this
 * tenant. No sample/placeholder data — a brand-new empty workspace correctly
 * shows an empty state, never fabricated money.
 *
 * Sources (all tenant-scoped via RLS):
 *   • Tasks due today or overdue  → actionable "follow-up" alerts (drive unread)
 *   • Leads created in the last 7 days → informational "new lead" events
 * Read-state is remembered in localStorage so "Mark all read" sticks.
 * Realtime push can later prepend to this same list.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildNotifications, countUnread, notifReadStore, type NotificationItem } from "./notification-items";
import { useTasks } from "@/lib/queries/tasks";
import { useRecentLeads } from "@/lib/queries/leads";
import { useCelebrations } from "@/lib/queries/contacts";
import { useNotifications, useMarkNotificationRead, useMarkAllNotificationsRead } from "@/lib/queries/notifications";
import { useBusinessShell } from "@/lib/hooks/useBusinessShell";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isPersonalSession } from "@/lib/workspace/kind";

/** R-2175: the empty bell says what WOULD show up — a personal workspace has no leads or follow-ups. */
export function bellEmptyBody(business: boolean): string {
  return business
    ? "Follow-ups due today and new leads will show up here."
    : "Updates about your account will show up here.";
}

/**
 * R-1122: the list + unread count that BOTH the bell badge (topbar) and this panel show.
 * Same sources, same shared read-state store, same countUnread — so they always agree and
 * "Mark all read" clears the badge. react-query dedupes the reads between the two.
 */
export function useNotificationFeed() {
  /* R-2175: tasks, leads and contacts are business records — a personal session has none and
     the data gateway refuses them (R-2125). Its bell shows only its own notifications. */
  const business = useBusinessShell();
  const { data: tasks, isLoading: tasksLoading } = useTasks("all", { enabled: business });
  /* Only the leads it shows: created in the last 7 days, 30 at most, five columns (S40).
     This panel is mounted on every page and used to load every lead with select("*"). */
  const { data: leads, isLoading: leadsLoading } = useRecentLeads(business);
  const { data: celebrations, isLoading: celebrationsLoading } = useCelebrations(7, { enabled: business });
  /* Asli events — DB se (audit B4): payment/quote-accept/lead/ticket. Read-state
     row par hai, har device par ek. */
  const { data: dbNotifs, isLoading: notifsLoading } = useNotifications();

  // Persisted read-state (localStorage) shared with the bell, so "Mark all read" sticks
  // across refresh and the badge drops the same instant.
  const readIds = React.useSyncExternalStore(
    notifReadStore.subscribe, notifReadStore.getSnapshot, notifReadStore.getServerSnapshot,
  );

  const items = React.useMemo(
    () => buildNotifications({ dbNotifs, tasks, leads, celebrations, readIds }),
    [tasks, leads, celebrations, readIds, dbNotifs],
  );
  /* Pehli load par "You're all caught up" jhooth tha (R-247) — data aane tak skeleton. */
  const loading = items.length === 0 && (tasksLoading || leadsLoading || notifsLoading || celebrationsLoading);
  return { items, unreadCount: countUnread(items), loading };
}

export function NotificationPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { items, unreadCount, loading } = useNotificationFeed();
  const { data: me } = useCurrentUser();
  /* R-2176: /tasks is a business page — a personal session's bell has no "All tasks" footer. */
  const personal = isPersonalSession(me ? { role: me.role } : null);
  const markDbRead = useMarkNotificationRead();
  const markDbAll  = useMarkAllNotificationsRead();

  const markAllRead = () => {
    notifReadStore.markRead(items.map((n) => n.id));
    // DB events ka read_at bhi — warna doosre device par sab wapas unread.
    markDbAll.mutate();
  };

  const openItem = (n: NotificationItem) => {
    notifReadStore.markRead([n.id]);
    if (n.id.startsWith("db-")) markDbRead.mutate(n.id.slice(3));
    onOpenChange(false);
    router.push(n.link as never);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col" hideClose>
        {/* Header */}
        <SheetHeader className="!p-4 flex flex-row items-center justify-between gap-2 border-b border-hairline">
          <div>
            <SheetTitle className="text-base">Notifications</SheetTitle>
            <SheetDescription className="text-2xs mt-0.5">
              {loading
                ? "Loading…"
                : items.length === 0
                ? "You're all caught up"
                : unreadCount > 0
                ? `${unreadCount} need${unreadCount === 1 ? "s" : ""} attention · ${items.length} recent`
                : `All caught up · ${items.length} recent`}
            </SheetDescription>
          </div>
          {/* gap-3: "Mark all read" sat right against the × (Pawan, 16 Oct — R-1122). */}
          <div className="flex items-center gap-3">
            <button
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className={cn(
                "text-xs font-medium px-2 py-1 rounded",
                unreadCount === 0
                  ? "text-ink-3 cursor-default"
                  : "text-indigo hover:bg-indigo-soft cursor-pointer",
              )}
            >
              Mark all read
            </button>
            <button
              onClick={() => onOpenChange(false)}
              className="p-1.5 rounded hover:bg-paper-2"
              aria-label="Close notifications"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </SheetHeader>

        {/* Items */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div aria-busy="true">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="px-4 py-3 border-b border-hairline flex gap-3 items-start">
                  <Skeleton className="w-8 h-8 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-2 pt-0.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon="bell"
              title="You're all caught up"
              body={bellEmptyBody(!personal)}
            />
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={cn(
                  "w-full px-4 py-3 border-b border-hairline last:border-0 flex gap-3 items-start",
                  "hover:bg-paper-2 transition-colors",
                  n.unread && "bg-paper-2/60",
                )}
              >
                <button onClick={() => openItem(n)} className="flex gap-3 items-start text-left flex-1 min-w-0">
                  <div
                    className={cn(
                      "w-8 h-8 rounded-full grid place-items-center flex-shrink-0",
                      n.tone === "emerald" && "bg-emerald-soft text-emerald",
                      n.tone === "indigo" && "bg-indigo-soft text-indigo",
                      n.tone === "amber" && "bg-amber-soft text-amber-ink",
                      n.tone === "rose" && "bg-rose-soft text-rose-ink",
                      n.tone === "slate" && "bg-slate-soft text-slate",
                    )}
                  >
                    <Icon name={n.icon} size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-sm leading-snug text-ink",
                        n.unread ? "font-semibold" : "font-normal",
                      )}
                    >
                      {n.title}
                    </div>
                    <div className="text-2xs text-ink-3 mt-1 leading-snug">{n.meta}</div>
                  </div>
                </button>
                {n.wishHref ? (
                  <a
                    href={n.wishHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 self-center inline-flex items-center gap-1 rounded-md border border-emerald/30 text-emerald text-2xs font-medium px-2 py-1 hover:bg-emerald-soft/50 transition-colors"
                    aria-label="Send WhatsApp wish"
                  >
                    <Icon name="whatsapp" size={13} /> Wish
                  </a>
                ) : n.unread ? (
                  <span className="w-2 h-2 rounded-full bg-indigo flex-shrink-0 mt-1.5" aria-hidden="true" />
                ) : null}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {!personal && (
        <div className="flex items-center justify-between p-3 border-t border-hairline bg-paper-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            icon="clock"
            onClick={() => {
              onOpenChange(false);
              router.push("/tasks" as never);
            }}
          >
            All tasks
          </Button>
        </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
