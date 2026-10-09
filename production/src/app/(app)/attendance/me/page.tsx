/**
 * My Attendance — self check-in for logged-in app users (migration 0216).
 *
 * The login proves WHO you are, and — when the tenant keeps require_selfie on —
 * a live selfie proves you're actually present (anti buddy-punching, same as the
 * shared kiosk). No PIN: the login already is the identity. If the user isn't
 * yet linked to an employee record, they pick themselves once.
 *
 * Logically handles Desktop PCs without webcams by allowing Google OAuth-verified
 * desktop check-ins when webcam hardware is unavailable.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getDeviceToken } from "@/lib/attendance/device";
import { useEmployees, useAttendanceNetwork } from "@/lib/queries/payroll";
import {
  useMyAttendanceToday,
  useMarkSelfAttendance,
  useSetMyEmployee,
  useMyAttendanceHistory,
  useRecordConsent,
  useWithdrawConsent,
  useEnrollMyFace,
  useUndoLastPunch,
  useMyReminderPrefs,
  useSetMyReminderPrefs,
} from "@/lib/queries/my-attendance";
import { LeaveRequestDialog } from "@/components/features/attendance/leave-request-dialog";
import { ThisDeviceCard, useDeviceSignature } from "./device-card";
import { dayStatus, formatGap, formatWorked, type ShiftRules } from "@/lib/attendance/shift";
import { useShiftRules } from "@/lib/queries/attendance-shift";
import { minutesToTimeValue, parseTimeToMinutes } from "@/lib/attendance/reminders";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "8h 12m" between two timestamps — the real "office me kitne time" answer. */
function fmtDuration(inIso: string | null, outIso: string | null): string | null {
  if (!inIso || !outIso) return null;
  const mins = Math.max(0, Math.round((new Date(outIso).getTime() - new Date(inIso).getTime()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Today as YYYY-MM-DD in IST, whatever timezone this device is set to. */
function todayIstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export default function MyAttendancePage() {
  const meQ = useMyAttendanceToday();
  const netQ = useAttendanceNetwork();
  const requireSelfie = netQ.data?.requireSelfie ?? true;
  const requirePresence = netQ.data?.requirePresence ?? false;
  const requireFaceMatch = netQ.data?.requireFaceMatch ?? false;
  const [leaveOpen, setLeaveOpen] = React.useState(false);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[560px] mx-auto">
      <div className="mb-6 text-center">
        <p className="text-2xs uppercase tracking-wider text-ink-3">Payroll &amp; HR</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight mt-1">My Attendance</h1>
        <p className="text-sm text-ink-3 mt-1">{todayLabel()}</p>

        {meQ.data?.linked && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="default"
              size="sm"
              onClick={() => setLeaveOpen(true)}
              className="gap-1.5 text-xs rounded-full border-hairline hover:bg-paper-2"
            >
              <Icon name="calendar" size={13} className="text-amber-ink" />
              Apply Leave / Missed Punch
            </Button>
          </div>
        )}
      </div>

      <LeaveRequestDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        employeeName={meQ.data && meQ.data.linked ? meQ.data.employee_name : undefined}
      />

      {meQ.isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : meQ.error ? (
        <Card className="p-6 text-center text-sm text-rose">
          Could not load your attendance. Refresh the page and try again.
        </Card>
      ) : meQ.data && !meQ.data.linked ? (
        <LinkEmployeeCard />
      ) : meQ.data && meQ.data.linked && requireSelfie && !meQ.data.consent_at ? (
        <ConsentCard retentionDays={meQ.data.retention_days} />
      ) : meQ.data && meQ.data.linked ? (
        <>
          {requireFaceMatch && !meQ.data.face_enrolled && <EnrollFaceCard />}
          <CheckInCard
            name={meQ.data.employee_name}
            checkIn={meQ.data.check_in}
            checkOut={meQ.data.check_out}
            requireSelfie={requireSelfie}
            requirePresence={requirePresence}
          />
          <ThisDeviceCard />
          <HistoryCard />
          <ReminderSettingsCard />
          {meQ.data.consent_at && (
            <ConsentStatus consentAt={meQ.data.consent_at} retentionDays={meQ.data.retention_days} />
          )}
        </>
      ) : null}
    </div>
  );
}

/** DPDP consent — shown once before the first selfie check-in. */
function ConsentCard({ retentionDays }: { retentionDays: number }) {
  const record = useRecordConsent();
  const months = Math.round(retentionDays / 30);
  return (
    <Card className="p-6 md:p-8">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-soft">
          <Icon name="lock" className="h-6 w-6 text-indigo" />
        </div>
        <h2 className="font-serif text-xl">Consent for attendance</h2>
      </div>
      <div className="mt-5 space-y-3 text-sm text-ink-2">
        <p>When you mark attendance, a <b>selfie</b> and your <b>location</b> are captured. They are used <b>only for attendance</b> — nothing else.</p>
        <ul className="space-y-2 text-[13px]">
          <li className="flex gap-2"><span className="text-indigo">•</span> Only for attendance — no tracking.</li>
          <li className="flex gap-2"><span className="text-indigo">•</span> Selfies are kept for <b>{months} months</b>, then deleted automatically.</li>
          <li className="flex gap-2"><span className="text-indigo">•</span> You can withdraw consent at any time — all your selfies are then deleted.</li>
        </ul>
      </div>
      <Button className="w-full mt-6" disabled={record.isPending} onClick={() => record.mutate()}>
        {record.isPending ? "…" : "I understand — I give consent"}
      </Button>
      <p className="text-xs text-ink-3 mt-3 text-center">As per the DPDP Act 2023 — data is collected only with your consent.</p>
    </Card>
  );
}

/** One-time reference-face enrollment (Phase 4). */
function EnrollFaceCard() {
  const enroll = useEnrollMyFace();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const start = React.useCallback(async () => {
    if (streamRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErr("The camera does not open in this browser."); return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => {}); }
      setCamOn(true); setErr(null);
    } catch { setErr("Allow the camera and try again."); }
  }, []);

  React.useEffect(() => {
    void start();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  }, [start]);

  function capture(): string | null {
    const v = videoRef.current;
    if (!v || !camOn || !v.videoWidth) return null;
    const w = 320, h = Math.round((v.videoHeight / v.videoWidth) * 320) || 240;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.7);
  }

  return (
    <Card className="mb-4 p-5 border-indigo/30">
      <div className="flex items-start gap-4">
        <div className="shrink-0">
          <video ref={videoRef} autoPlay muted playsInline
            className={cn("h-20 w-20 rounded-full border border-hairline bg-paper-2 object-cover [transform:scaleX(-1)]", camOn ? "" : "hidden")} />
          {!camOn && (
            <button type="button" onClick={start}
              className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border border-dashed border-hairline bg-paper-2 text-ink-3">
              <Icon name="eye" size={20} /><span className="text-xs">Tap</span>
            </button>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Enroll your face once</div>
          <p className="text-[12px] text-ink-3 mt-0.5">
            {err ?? "Face verification is on. Look straight at the camera and enroll — every future check-in is matched against it."}
          </p>
          <Button size="sm" className="mt-2" disabled={!camOn || enroll.isPending}
            onClick={() => { const p = capture(); if (p) enroll.mutate(p); }}>
            {enroll.isPending ? "…" : "Capture & enroll"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Consent status + withdraw (right to erasure) — transparency. */
/**
 * Reminder settings — the "time set karne ka option" half of the request.
 *
 * Lives on this screen and not in /settings because this is where somebody already is
 * when they think about their punches, and because the setting is personal: /settings is
 * the tenant's configuration, not one person's.
 *
 * Saves on change rather than behind a Save button. Two controls with no other state
 * cannot get into a half-saved condition, and a Save button on a two-field card is the
 * kind of thing people leave un-pressed.
 */
function ReminderSettingsCard() {
  const prefsQ = useMyReminderPrefs();
  const save = useSetMyReminderPrefs();

  // Local mirror so the time input stays responsive while the write is in flight.
  const [timeValue, setTimeValue] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!prefsQ.data) return;
    const mins = parseTimeToMinutes(prefsQ.data.checkoutAt);
    setTimeValue(mins == null ? "18:00" : minutesToTimeValue(mins));
  }, [prefsQ.data]);

  // The migration may not be applied yet on a given environment; the hook returns null
  // rather than throwing, and the card simply does not appear. Better than a card whose
  // controls silently do nothing.
  if (!prefsQ.data) return null;

  const enabled = prefsQ.data.enabled;

  return (
    <Card className="mt-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <Icon name="clock" size={13} className="text-ink-3" />
            Punch reminder
          </div>
          <p className="mt-1 text-[12px] text-ink-3">
            Shows a popup when the app is open and a check-in or check-out is missing.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={save.isPending}
          onCheckedChange={(v) => save.mutate({ enabled: v })}
          aria-label="Punch reminder on or off"
        />
      </div>

      {enabled && (
        <div className="mt-3 pt-3 border-t border-hairline flex items-center justify-between gap-3">
          <label htmlFor="checkout-reminder-at" className="text-[12px] text-ink-2">
            Check-out reminder time
          </label>
          <input
            id="checkout-reminder-at"
            type="time"
            value={timeValue ?? "18:00"}
            disabled={save.isPending}
            onChange={(e) => setTimeValue(e.target.value)}
            onBlur={(e) => {
              const mins = parseTimeToMinutes(e.target.value);
              // A cleared or half-typed time is ignored rather than saved — writing
              // "00:00" here would put a popup on the screen at midnight.
              if (mins == null) {
                const current = parseTimeToMinutes(prefsQ.data?.checkoutAt ?? "");
                setTimeValue(current == null ? "18:00" : minutesToTimeValue(current));
                return;
              }
              save.mutate({ checkoutAt: `${minutesToTimeValue(mins)}:00` });
            }}
            className="rounded-md border border-hairline bg-paper px-2 py-1 text-sm text-ink font-mono focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      )}
    </Card>
  );
}

function ConsentStatus({ consentAt, retentionDays }: { consentAt: string; retentionDays: number }) {
  const withdraw = useWithdrawConsent();
  const [confirming, setConfirming] = React.useState(false);
  const months = Math.round(retentionDays / 30);
  return (
    <Card className="mt-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[12px] text-ink-3">
          <div className="flex items-center gap-1.5 text-emerald font-medium">
            <Icon name="check_circle" size={13} /> Consent given
          </div>
          <p className="mt-1">
            {new Date(consentAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · selfies kept for {months} months.
          </p>
        </div>
        {confirming ? (
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" variant="danger" loading={withdraw.isPending}
              onClick={() => withdraw.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
              Delete my selfies
            </Button>
          </div>
        ) : (
          <button className="text-[12px] text-rose hover:underline shrink-0" onClick={() => setConfirming(true)}>
            Withdraw
          </button>
        )}
      </div>
    </Card>
  );
}

/**
 * Late / left early / half-day tags for one day (R-604). Late and left-early are shown
 * only; half-day is what payroll counts as half a day — so its tooltip says so.
 */
function DayTags({ workDate, checkIn, checkOut, rules }: {
  workDate: string; checkIn: string | null; checkOut: string | null; rules: ShiftRules;
}) {
  const s = dayStatus(workDate, checkIn, checkOut, rules);
  if (!s.present) return null;
  const tags: { label: string; title: string; tone: "amber" | "muted" }[] = [];
  if (s.late) tags.push({ label: `Late ${formatGap(s.lateByMinutes)}`, title: `Checked in after ${rules.shiftStart} + ${rules.lateGraceMinutes} min grace`, tone: "amber" });
  /* A half-day already says the day was short — "left 4h 25m early" beside it is noise. */
  if (s.leftEarly && !s.halfDay) tags.push({ label: `Left ${formatGap(s.leftEarlyByMinutes)} early`, title: `Office closes at ${rules.shiftEnd}`, tone: "muted" });
  if (s.halfDay) tags.push({ label: "Half day", title: `Under ${rules.halfDayUnderHours} hours (${formatWorked(s.workedMinutes ?? 0)}) — payroll counts this day as half`, tone: "amber" });
  if (!tags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span key={t.label} title={t.title}
          className={cn("rounded-full px-2 py-0.5 text-2xs font-medium",
            t.tone === "amber" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-2")}>
          {t.label}
        </span>
      ))}
    </span>
  );
}

/** Last 14 days of the caller's own attendance — transparency builds trust. */
function HistoryCard() {
  const histQ = useMyAttendanceHistory(14);
  const rulesQ = useShiftRules();
  const rows = histQ.data ?? [];
  if (histQ.isLoading) return <Skeleton className="mt-4 h-32 w-full rounded-xl" />;
  if (!rows.length) return null;
  return (
    <Card className="mt-4 p-4">
      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">Your recent record</div>
      <ul className="divide-y divide-hairline">
        {rows.map((r) => (
          <li key={r.work_date} className="flex items-center justify-between py-2 text-sm">
            <span className="text-ink-2">
              {new Date(r.work_date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
            </span>
            <span className="tabular-nums text-ink-3 text-[13px]">
              {fmtTime(r.check_in)} <span className="text-ink-3/60">→</span> {fmtTime(r.check_out)}
              {fmtDuration(r.check_in, r.check_out)
                ? <span className="ml-2 text-ink-2">· {fmtDuration(r.check_in, r.check_out)}</span>
                : r.check_in && !r.check_out ? <span className="ml-2 text-amber-ink">· no check-out</span> : null}
              {rulesQ.data && (
                <span className="ml-2 align-middle">
                  <DayTags workDate={r.work_date} checkIn={r.check_in} checkOut={r.check_out} rules={rulesQ.data} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CheckInCard({
  name,
  checkIn,
  checkOut,
  requireSelfie,
  requirePresence,
}: {
  name: string;
  checkIn: string | null;
  checkOut: string | null;
  requireSelfie: boolean;
  requirePresence: boolean;
}) {
  const mark = useMarkSelfAttendance();
  const undo = useUndoLastPunch();
  const device = useDeviceSignature();
  const rulesQ = useShiftRules();
  const state: "out" | "in" | "done" = !checkIn ? "out" : !checkOut ? "in" : "done";
  const pending = state !== "done";

  const [confirmQuick, setConfirmQuick] = React.useState(false);
  const minsSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity);
  // A check-out < 10 min after check-in is probably a mis-tap → ask first.
  const quickCheckout = state === "in" && minsSince(checkIn) < 10;
  // Undo affordance: last punch was in the last 15 min.
  const lastPunch = checkOut ?? checkIn;
  const canUndo = state !== "out" && minsSince(lastPunch) < 15;

  // ── Presence code (only when the office requires it) ─────────────────────────
  const [code, setCode] = React.useState("");

  // ── GPS (soft audit signal — captured whenever the phone shares it) ──────────
  const coords = React.useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [geoState, setGeoState] = React.useState<"idle" | "ok" | "denied">("idle");
  React.useEffect(() => {
    if (!pending || typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { coords.current = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }; setGeoState("ok"); },
      () => setGeoState("denied"),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }, [pending]);

  // ── Camera & Desktop Detection ─
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = React.useState(false);
  const [camErrMsg, setCamErrMsg] = React.useState<string | null>(null);
  const [noCamDetected, setNoCamDetected] = React.useState(false);
  const needsCam = requireSelfie && pending;

  const startCam = React.useCallback(async () => {
    if (streamRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCamErrMsg("The camera does not open in this browser. Open the site in Chrome (https), not an in-app browser.");
      return;
    }
    async function grab(): Promise<MediaStream> {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } catch (e1) {
        const n = (e1 as Error).name;
        if (n === "OverconstrainedError" || n === "NotFoundError" || n === "DevicesNotFoundError" || n === "TypeError") {
          return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        throw e1;
      }
    }
    try {
      const s = await grab();
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => {}); }
      setCamOn(true); setCamErrMsg(null); setNoCamDetected(false);
    } catch (e) {
      const nm = (e as Error).name || "";
      if (nm === "NotFoundError" || nm === "DevicesNotFoundError" || nm === "OverconstrainedError") {
        setNoCamDetected(true);
        setCamErrMsg("Desktop PC (No webcam detected) — Google Auth Verified Mode");
      } else {
        setCamErrMsg(
          nm === "NotAllowedError" || nm === "SecurityError"
            ? "Camera blocked — tap the circle and choose Allow (or turn the camera on for this site in browser settings)."
            : nm === "NotReadableError" || nm === "TrackStartError" || nm === "AbortError"
              ? "Camera is busy — close Meet/Zoom and tap the circle again."
              : `Camera error: ${nm || "unknown"} — tap the circle to retry.`,
        );
      }
    }
  }, []);

  React.useEffect(() => {
    if (needsCam) void startCam();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCamOn(false); };
  }, [needsCam, startCam]);

  function capture(): string | null {
    const v = videoRef.current;
    if (!v || !camOn || !v.videoWidth) return null;
    const w = 320, h = Math.round((v.videoHeight / v.videoWidth) * 320) || 240;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.6);
  }

  async function onMark() {
    setConfirmQuick(false);
    const photo = requireSelfie && !noCamDetected ? capture() : null;
    // R-606: when the workspace requires a registered device, the press is signed first.
    const deviceAssertion = await device.sign();
    if (deviceAssertion === false) return;
    mark.mutate({
      photo,
      code,
      lat: coords.current?.lat ?? null,
      lng: coords.current?.lng ?? null,
      accuracy: coords.current?.accuracy ?? null,
      device: noCamDetected ? "desktop_no_webcam" : getDeviceToken(),
      deviceAssertion,
    });
  }

  function onPrimary() {
    // Quick check-out (just checked in) → confirm first, so a stray tap doesn't end the day.
    if (quickCheckout && !confirmQuick) { setConfirmQuick(true); return; }
    void onMark();
  }

  return (
    <Card className="p-6 md:p-8 text-center">
      <p className="text-sm text-ink-3">Hello</p>
      <p className="font-serif text-2xl mt-0.5">{name}</p>

      {needsCam && (
        <div className="mt-5">
          {noCamDetected ? (
            <div className="p-3.5 rounded-xl border border-amber/30 bg-amber/5 text-xs text-ink-2 space-y-1 my-2">
              <div className="flex items-center justify-center gap-1.5 font-semibold text-amber-ink">
                <Icon name="laptop" size={16} />
                <span>Desktop PC (No Webcam) Mode</span>
              </div>
              <p className="text-xs text-ink-3">
                System detected desktop PC without webcam. Authenticated via Google Account.
              </p>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay muted playsInline
                className={cn(
                  "mx-auto h-28 w-28 rounded-full border border-hairline bg-paper-2 object-cover [transform:scaleX(-1)]",
                  camOn ? "" : "hidden",
                )}
              />
              {!camOn && (
                <button
                  type="button"
                  onClick={startCam}
                  className="mx-auto flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-full border border-dashed border-hairline bg-paper-2 text-ink-3 hover:border-amber/50 hover:text-amber-ink"
                >
                  <Icon name="eye" size={24} />
                  <span className="text-xs leading-tight">Tap to turn on camera</span>
                </button>
              )}
              <p className={cn("mt-2 text-xs", camErrMsg ? "text-rose" : "text-ink-3")}>
                {camErrMsg ?? (camOn ? "Look at the camera — attendance is marked with a selfie." : "A selfie is required.")}
              </p>
            </>
          )}
        </div>
      )}

      {requirePresence && pending && (
        <div className="mt-5 text-left">
          <label htmlFor="office-code" className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
            Office code
          </label>
          <input
            id="office-code"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit"
            className="mt-1 w-full rounded-lg border border-hairline bg-paper px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] tabular-nums focus:border-amber focus:outline-none"
          />
          <p className="mt-1.5 text-xs text-ink-3">
            Enter the code showing on the office tablet right now — it confirms you are in the office.
          </p>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-hairline p-4">
          <p className="text-2xs uppercase tracking-wider text-ink-3">Check-in</p>
          <p className={cn("font-serif text-2xl mt-1 tabular-nums", checkIn ? "text-emerald" : "text-ink-3")}>
            {fmtTime(checkIn)}
          </p>
        </div>
        <div className="rounded-lg border border-hairline p-4">
          <p className="text-2xs uppercase tracking-wider text-ink-3">Check-out</p>
          <p className={cn("font-serif text-2xl mt-1 tabular-nums", checkOut ? "text-indigo" : "text-ink-3")}>
            {fmtTime(checkOut)}
          </p>
        </div>
      </div>

      {rulesQ.data && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>Office hours {rulesQ.data.shiftStart}–{rulesQ.data.shiftEnd}</span>
          <DayTags workDate={todayIstDate()} checkIn={checkIn} checkOut={checkOut} rules={rulesQ.data} />
        </p>
      )}

      <div className="mt-6">
        {state === "done" && fmtDuration(checkIn, checkOut) && (
          <p className="mb-3 text-sm text-ink-2">In office today: <b className="text-ink">{fmtDuration(checkIn, checkOut)}</b></p>
        )}
        {confirmQuick ? (
          <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-4">
            <p className="text-sm text-ink">
              You checked in only <b>{Math.max(1, Math.round(minsSince(checkIn)))} min</b> ago — check out now?
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setConfirmQuick(false)}>No, keep me in</Button>
              <Button className="flex-1" loading={mark.isPending} onClick={onMark}>Yes, check out</Button>
            </div>
          </div>
        ) : state === "done" ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-soft px-4 py-2 text-sm text-emerald">
            <Icon name="check_circle" className="h-4 w-4" />
            Today's attendance is complete
          </div>
        ) : (
          <Button
            size="lg"
            className="w-full h-14 text-base"
            onClick={onPrimary}
            disabled={mark.isPending || device.signing || (requireSelfie && !camOn && !noCamDetected) || (requirePresence && code.length !== 6)}
          >
            <Icon name={state === "out" ? "check" : "logout"} className="h-5 w-5 mr-2" />
            {mark.isPending || device.signing ? "…" : state === "out" ? "Check In" : "Check Out"}
          </Button>
        )}
        {device.hint}

        {canUndo && !confirmQuick && (
          <button
            className="mt-3 text-[12px] text-ink-3 hover:text-rose disabled:opacity-50"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
          >
            {undo.isPending ? "Undoing…" : `${state === "done" ? "Checked out" : "Checked in"} by mistake? Undo`}
          </button>
        )}
      </div>

      <p className="text-xs text-ink-3 mt-4">
        {[
          "Google Auth Login",
          noCamDetected ? "desktop mode" : requireSelfie ? "selfie" : null,
          requirePresence ? "office code" : null,
          device.required ? "registered device" : null,
          pending && geoState === "ok" ? "location" : null,
        ].filter(Boolean).join(" + ")}
        {" — "}
        your attendance is recorded with these proofs.
      </p>
    </Card>
  );
}

function LinkEmployeeCard() {
  const empQ = useEmployees();
  const setEmp = useSetMyEmployee();
  const [selectedId, setSelectedId] = React.useState<string>("");

  const rows = (empQ.data ?? []).filter((e) => e.is_active !== false);

  return (
    <Card className="p-6 md:p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
        <Icon name="user" className="h-6 w-6 text-amber-ink" />
      </div>
      <h2 className="font-serif text-xl">Select your profile</h2>
      <p className="text-sm text-ink-3 mt-1">
        First time here — pick your name from the list. Once linked, you will not be asked again.
      </p>

      {empQ.isLoading ? (
        <Skeleton className="mt-5 h-10 w-full rounded-md" />
      ) : empQ.error ? (
        <p className="mt-4 text-xs text-rose">Could not load employees.</p>
      ) : (
        <div className="mt-5 space-y-3">
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select your name…" />
            </SelectTrigger>
            <SelectContent>
              {rows.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            className="w-full"
            disabled={!selectedId || setEmp.isPending}
            onClick={() => setEmp.mutate(selectedId)}
          >
            {setEmp.isPending ? "Linking…" : "Save & Continue"}
          </Button>
        </div>
      )}
    </Card>
  );
}
