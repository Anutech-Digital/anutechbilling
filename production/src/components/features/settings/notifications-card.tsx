/**
 * Notifications — turn push on for THIS device, and choose what it may interrupt you for.
 *
 * ─── PER DEVICE, NOT PER PERSON ─────────────────────────────────────────────
 * A push subscription belongs to one browser on one machine. Somebody who turns this on
 * their phone has not turned it on for their laptop, and saying so on the card avoids the
 * commonest confusion: "I enabled it, why is my laptop quiet".
 *
 * ─── TWO SWITCHES, AND OFFERS IS OFF ────────────────────────────────────────
 * The browser has ONE permission for this site, so an offer and a payment alert arrive
 * through the same door. Somebody annoyed by an offer turns off NOTIFICATIONS, and the
 * payment alert goes with it. So the consent is split in our own data, and offers start
 * off — a default-on marketing channel is consent by omission.
 *
 * ─── EVERY DEAD END GETS A REASON ───────────────────────────────────────────
 * Three states cannot be fixed by pressing the button again, and each says why (§24):
 * an iPhone that has not installed the app (iOS gives web push only to installed PWAs),
 * a browser that has blocked notifications (we cannot re-prompt — only the browser's own
 * settings can undo that), and a server with no VAPID keys.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Support =
  | { ok: true }
  | { ok: false; reason: "no-push"; hint: string }
  | { ok: false; reason: "ios-needs-install"; hint: string };

function detectSupport(): Support {
  if (typeof window === "undefined") return { ok: true };  // decided again after mount
  const hasPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasPush) return { ok: true };

  /* iOS gives web push only to a PWA added to the home screen, and only from 16.4. In
     Safari-in-a-tab the APIs are simply absent, so this is the likeliest reason on a
     phone — and it is fixable, which is why it is worth naming rather than showing a
     flat "not supported". */
  const ua = navigator.userAgent;
  const isApple = /iPhone|iPad|iPod/.test(ua);
  if (isApple) {
    return {
      ok: false,
      reason: "ios-needs-install",
      hint: "On iPhone, notifications work only after you add ResellerOS to your home screen: tap Share, then “Add to Home Screen”, then open it from there.",
    };
  }
  return {
    ok: false,
    reason: "no-push",
    hint: "This browser does not support web notifications. Chrome, Edge or Firefox on this device will.",
  };
}

export function NotificationsCard() {
  const [support, setSupport] = React.useState<Support>({ ok: true });
  const [permission, setPermission] = React.useState<NotificationPermission>("default");
  const [enabled, setEnabled] = React.useState(false);
  const [offers, setOffers] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const configured = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);

  /* Read the real state from the browser rather than remembering what we did: the person
     may have revoked the permission in browser settings, or cleared site data, and a card
     that still says "on" is worse than one that says nothing. */
  React.useEffect(() => {
    setSupport(detectSupport());
    if (!("Notification" in window)) return;
    setPermission(Notification.permission);
    void (async () => {
      if (!("serviceWorker" in navigator)) return;
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      setEnabled(Boolean(sub));
    })();
  }, []);

  const save = React.useCallback(async (categories: string[]) => {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({
      /* Required by Chrome: a push that cannot be shown to the user is not allowed. */
      userVisibleOnly: true,
      /* The spec takes the url-safe base64 STRING directly (PushSubscriptionOptionsInit
         accepts BufferSource | string), so the usual hand-written base64→Uint8Array
         helper is dead code — and the version everyone copies trips a real TS error,
         because Uint8Array<ArrayBufferLike> is not the ArrayBuffer-backed view
         BufferSource wants. */
      applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string,
    });
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        categories,
        userAgent: navigator.userAgent.slice(0, 400),
      }),
    });
    if (!res.ok) {
      /* 401 deserves its own sentence. The browser prompt was allowed, the subscription
         was created locally, and then the save failed because THIS browser has no session
         — which happened on the first real attempt at this feature. The raw "Not signed
         in" from the route tells an operator nothing about what to do next, and the
         notification permission they just granted makes it look as though it worked. */
      if (res.status === 401) {
        /* Undo the local subscription: leaving it means the browser thinks it is
           subscribed while the server has never heard of it, and the card would show
           "On" for a device that can never be reached. */
        await sub.unsubscribe().catch(() => {});
        throw new Error(
          "You are signed out in this browser — sign in, then turn notifications on again.",
        );
      }
      throw new Error((await res.json().catch(() => ({}))).error || "Could not save this device");
    }
    return sub;
  }, []);

  /** Must be called from a click — browsers refuse a permission prompt without a gesture. */
  const enable = async () => {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        toast.error("The browser did not allow notifications for this site.", { description: "Click the lock icon next to the address bar, allow Notifications, then try again." });
        return;
      }
      await save(offers ? ["operational", "offers"] : ["operational"]);
      setEnabled(true);
      toast.success("Notifications are on for this device.");
    } catch (err) {
      toastError(err, { fallback: "Could not turn notifications on.", description: "Nothing was changed. Try again — if it keeps failing, try another browser." });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setEnabled(false);
      setOffers(false);
      toast.success("Notifications are off for this device.");
    } finally {
      setBusy(false);
    }
  };

  const toggleOffers = async (next: boolean) => {
    setOffers(next);
    if (!enabled) return;   // saved when they turn notifications on
    setBusy(true);
    try {
      await save(next ? ["operational", "offers"] : ["operational"]);
      toast.success(next ? "Offers will be sent to this device." : "Offers turned off for this device.");
    } catch (err) {
      setOffers(!next);
      toastError(err, { fallback: "Could not save that.", description: "Your offers setting is unchanged. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* The route's nextStep is written to be read by an operator, so show it. */
        toast.error(json.error ?? "Test failed", { description: json.nextStep });
        return;
      }
      toast.success(`Sent to ${json.sent} device${json.sent === 1 ? "" : "s"}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Notifications on this device</h2>
          <p className="mt-0.5 text-sm text-ink-3">
            Alerts reach your phone or laptop even when ResellerOS is closed. This setting is
            per device — turning it on here does not turn it on anywhere else.
          </p>
        </div>
        {enabled && <Badge kind="success" dot>On</Badge>}
      </div>

      {!configured ? (
        <div className="rounded-md border border-amber/40 bg-amber-soft px-3 py-2.5 text-[13px] leading-snug text-amber-ink">
          <b>Push is not set up on the server yet.</b> The VAPID keys are missing, so nothing
          can be delivered. Add <code>NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> and{" "}
          <code>VAPID_PRIVATE_KEY</code> to the deployment, then reload.
        </div>
      ) : !support.ok ? (
        <div className="rounded-md border border-hairline bg-paper-2 px-3 py-2.5 text-[13px] leading-snug text-ink-2">
          {support.hint}
        </div>
      ) : permission === "denied" ? (
        <div className="rounded-md border border-rose/30 bg-rose-soft/60 px-3 py-2.5 text-[13px] leading-snug text-rose-ink">
          <b>This browser has blocked notifications for ResellerOS.</b> We cannot ask again —
          only you can undo it, from the padlock icon next to the address bar → Notifications →
          Allow. Then reload this page.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {enabled ? (
              <>
                <Button variant="default" icon="bell" loading={busy} onClick={disable}>
                  Turn off on this device
                </Button>
                <Button variant="ghost" icon="send" loading={busy} onClick={sendTest}>
                  Send a test notification
                </Button>
              </>
            ) : (
              <Button variant="primary" icon="bell" loading={busy} onClick={enable}>
                Turn on for this device
              </Button>
            )}
          </div>

          {/* ── What may interrupt you ────────────────────────────────────────── */}
          <div className="space-y-2 border-t border-hairline pt-3">
            <div className="flex items-start gap-2.5">
              <Icon name="check_circle" size={15} className="mt-0.5 text-emerald shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Work alerts</p>
                <p className="text-[12px] leading-snug text-ink-3">
                  Attendance reminders, payments received, quotes accepted, new leads. Always on
                  while notifications are on — these are the reason the permission exists.
                </p>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={offers}
                disabled={busy}
                onChange={(e) => void toggleOffers(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline accent-amber"
              />
              <div className="min-w-0">
                <p className={cn("text-sm font-medium", offers ? "text-ink" : "text-ink-2")}>
                  Offers and announcements
                </p>
                <p className="text-[12px] leading-snug text-ink-3">
                  Off by default, and worth leaving off unless you want them: your browser has one
                  notification permission for this whole site, so switching these off later by
                  blocking notifications would silence the work alerts too.
                </p>
              </div>
            </label>
          </div>
        </div>
      )}
    </Card>
  );
}
