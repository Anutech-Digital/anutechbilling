/**
 * The attendance check-in / check-out popup.
 *
 * Mounted once in the (app) shell, so it can reach somebody wherever they are in the
 * app — which is what "Computer ko open karte hi … popup mil jaye" actually needs. A
 * reminder that only lives on /attendance/me would only be seen by people who already
 * remembered to go there.
 *
 * ─── IT NUDGES; IT DOES NOT PUNCH ───────────────────────────────────────────
 * There is no check-in button in this dialog, and that is deliberate. The real check-in
 * on /attendance/me can require a selfie, a DPDP consent record, a rotating office
 * presence code and a face match, depending on tenant settings. Putting a "Check in"
 * button here would mean either reimplementing all of that — a second check-in path that
 * drifts from the first — or quietly bypassing it, which turns a reminder into a way to
 * mark attendance from home. So the dialog explains and links; the guards stay in one
 * place.
 *
 * ─── HONEST LIMIT ───────────────────────────────────────────────────────────
 * This can only fire while the app is open in a tab. If somebody never opens ResellerOS,
 * nothing here reaches them — a real push would need the Notifications API or email, and
 * neither is wired. The check-out half is the one that mostly benefits: people tend to
 * have the app open during the day and forget the evening punch, which is exactly the
 * miss that was reported.
 */
"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useMyAttendanceToday, useMyReminderPrefs, useTodayWorkingDay } from "@/lib/queries/my-attendance";
import {
  decideAttendanceReminder,
  istNow,
  dismissKey,
  snoozeKey,
  type ReminderKind,
} from "@/lib/attendance/reminders";

/** How often the clock is re-checked. 30s so an 18:00 reminder is never more than 30s late. */
const TICK_MS = 30_000;
const SNOOZE_MIN = 15;

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode / disabled storage. Losing the dismissal is survivable; throwing here
    // would take the whole app shell down with it.
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* see readLocal */
  }
}

export function AttendanceReminder() {
  const router = useRouter();
  const pathname = usePathname();

  const { data: me } = useCurrentUser();
  const { data: today } = useMyAttendanceToday();
  /* The same working-day answer the cron resolves server-side. */
  const { data: workingDay } = useTodayWorkingDay();
  const { data: prefs } = useMyReminderPrefs();

  // A ticking clock, so the check-out reminder arrives at the configured minute rather
  // than only on the next navigation.
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());                       // after mount only — the server has no clock
    const t = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const userId = me?.userId ?? null;

  /**
   * The dismissed / snoozed state, mirrored into React.
   *
   * localStorage is the durable copy — it has to survive a reload, or "Not today" would
   * mean "until you press F5". But React cannot observe it, so it is read into state and
   * both are written together. An earlier version kept a bump counter in the dependency
   * array instead; that works, and it also makes the dependency a lie, which is exactly
   * what the exhaustive-deps rule is for. Holding the value itself makes the dependency
   * real.
   */
  const [dismissals, setDismissals] = React.useState<{
    check_in: string | null;
    check_out: string | null;
    snoozeDate: string | null;
    snoozeUntilMin: number | null;
  }>({ check_in: null, check_out: null, snoozeDate: null, snoozeUntilMin: null });

  // Read after mount only — localStorage does not exist while rendering on the server.
  React.useEffect(() => {
    if (!userId) return;
    const date = istNow(new Date()).date;
    const raw = readLocal(snoozeKey(userId, date));
    const parsed = raw === null ? null : Number(raw);
    setDismissals({
      check_in: readLocal(dismissKey(userId, "check_in")),
      check_out: readLocal(dismissKey(userId, "check_out")),
      snoozeDate: date,
      snoozeUntilMin: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    });
  }, [userId]);

  const decision = React.useMemo(() => {
    if (!now || !userId || !today || !prefs) return { kind: null as ReminderKind | null, reason: "loading" };

    const ist = istNow(now);

    return decideAttendanceReminder({
      now: ist,
      linked: today.linked,
      checkIn: today.linked ? today.check_in : null,
      checkOut: today.linked ? today.check_out : null,
      enabled: prefs.enabled,
      checkoutReminderAt: prefs.checkoutAt,
      dismissed: { check_in: dismissals.check_in, check_out: dismissals.check_out },
      // A snooze belongs to the day it was made. Left un-scoped, a 23:50 snooze would
      // still be suppressing the reminder at 00:05 the next morning.
      snoozedUntilMin: dismissals.snoozeDate === ist.date ? dismissals.snoozeUntilMin : null,
      onAttendanceScreen: pathname?.startsWith("/attendance") ?? false,
      /* Same answer the cron uses. Without it the popup would keep appearing on a Sunday
         while the push correctly stayed quiet — the screen and the phone disagreeing about
         the same day, which is the thing the shared decision function exists to prevent. */
      nonWorkingDayReason: workingDay?.reason ?? null,
    });
  }, [now, userId, today, prefs, pathname, dismissals, workingDay]);

  const kind = decision.kind;

  const handleDismiss = () => {
    if (!userId || !now || !kind) return;
    const date = istNow(now).date;
    writeLocal(dismissKey(userId, kind), date);
    setDismissals((d) => ({ ...d, [kind]: date }));
  };

  const handleSnooze = () => {
    if (!userId || !now) return;
    const ist = istNow(now);
    const until = ist.minutes + SNOOZE_MIN;
    writeLocal(snoozeKey(userId, ist.date), String(until));
    setDismissals((d) => ({ ...d, snoozeDate: ist.date, snoozeUntilMin: until }));
  };

  const handleGo = () => {
    // Not dismissed: they are on their way to punch, and if they get distracted the
    // reminder should still be waiting. Marking it done here would lose the very punch
    // this exists to catch.
    router.push("/attendance/me");
  };

  if (!kind) return null;

  const isCheckIn = kind === "check_in";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleSnooze(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${isCheckIn ? "bg-indigo-soft" : "bg-amber-soft"}`}>
            <Icon name={isCheckIn ? "clock" : "logout"} size={22} className={isCheckIn ? "text-indigo-ink" : "text-amber-ink"} />
          </div>
          <DialogTitle className="text-center text-xl font-serif">
            {isCheckIn ? "You haven't checked in yet" : "You haven't checked out yet"}
          </DialogTitle>
          <DialogDescription className="text-center text-sm">
            {isCheckIn
              ? "No check-in recorded today. It takes one tap."
              : "You checked in this morning but haven't checked out. Without a check-out, the day counts as incomplete."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 pt-1">
          <Button variant="primary" onClick={handleGo} className="w-full font-bold">
            {isCheckIn ? "Open attendance" : "Check out"}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSnooze} className="flex-1">
              Remind me in {SNOOZE_MIN} min
            </Button>
            <Button variant="ghost" onClick={handleDismiss} className="flex-1">
              Not today
            </Button>
          </div>
          <p className="text-xs text-ink-3 text-center pt-1">
            Turn this reminder off or change its time on My attendance (/attendance/me).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
