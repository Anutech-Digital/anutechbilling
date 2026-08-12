/**
 * My Attendance — self check-in for logged-in app users (migration 0216).
 *
 * The login proves WHO you are, and — when the tenant keeps require_selfie on —
 * a live selfie proves you're actually present (anti buddy-punching, same as the
 * shared kiosk). No PIN: the login already is the identity. If the user isn't
 * yet linked to an employee record, they pick themselves once.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
} from "@/lib/queries/my-attendance";
import { LeaveRequestDialog } from "@/components/features/attendance/leave-request-dialog";

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
        <p className="text-[11px] uppercase tracking-wider text-ink-3">Payroll &amp; HR</p>
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
          Attendance load nahi ho payi. Page refresh karke dobara try karo.
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
          <HistoryCard />
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
        <h2 className="font-serif text-xl">Attendance ke liye consent</h2>
      </div>
      <div className="mt-5 space-y-3 text-sm text-ink-2">
        <p>Attendance mark karte waqt aapki ek <b>selfie</b> aur <b>location</b> capture hogi. Ye sirf <b>attendance ke liye</b> use hoti hai — aur kuch nahi.</p>
        <ul className="space-y-2 text-[13px]">
          <li className="flex gap-2"><span className="text-indigo">•</span> Sirf attendance ke liye — koi tracking nahi.</li>
          <li className="flex gap-2"><span className="text-indigo">•</span> Selfie sirf <b>{months} mahine</b> tak rakhi jaati hai, phir apne-aap delete.</li>
          <li className="flex gap-2"><span className="text-indigo">•</span> Aap kabhi bhi consent wapas le sakte ho — tab aapki saari selfies delete ho jaayengi.</li>
        </ul>
      </div>
      <Button className="w-full mt-6" disabled={record.isPending} onClick={() => record.mutate()}>
        {record.isPending ? "…" : "Main samajh gaya — consent deta hoon"}
      </Button>
      <p className="text-[11px] text-ink-3 mt-3 text-center">DPDP Act 2023 ke hisaab se — aapki marzi se hi data liya jaata hai.</p>
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
      setErr("Is browser me camera nahi khulta."); return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => {}); }
      setCamOn(true); setErr(null);
    } catch { setErr("Camera allow karke dobara try karo."); }
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
              <Icon name="eye" size={20} /><span className="text-[9px]">Tap</span>
            </button>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Ek baar apna face enroll karo</div>
          <p className="text-[12px] text-ink-3 mt-0.5">
            {err ?? "Face verification ON hai. Seedha camera dekho aur enroll karo — aage har check-in isi se match hoga."}
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
function ConsentStatus({ consentAt, retentionDays }: { consentAt: string; retentionDays: number }) {
  const withdraw = useWithdrawConsent();
  const [confirming, setConfirming] = React.useState(false);
  const months = Math.round(retentionDays / 30);
  return (
    <Card className="mt-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[12px] text-ink-3">
          <div className="flex items-center gap-1.5 text-emerald font-medium">
            <Icon name="check_circle" size={13} /> Consent diya
          </div>
          <p className="mt-1">
            {new Date(consentAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · selfie {months} mahine tak rakhi jaati hai.
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

/** Last 14 days of the caller's own attendance — transparency builds trust. */
function HistoryCard() {
  const histQ = useMyAttendanceHistory(14);
  const rows = histQ.data ?? [];
  if (histQ.isLoading) return <Skeleton className="mt-4 h-32 w-full rounded-xl" />;
  if (!rows.length) return null;
  return (
    <Card className="mt-4 p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-3">Aapka recent record</div>
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
                : r.check_in && !r.check_out ? <span className="ml-2 text-amber-ink">· check-out reh gaya</span> : null}
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

  // ── Camera (only when a selfie is required and there's still a punch to make) ─
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = React.useState(false);
  const [camErrMsg, setCamErrMsg] = React.useState<string | null>(null);
  const needsCam = requireSelfie && pending;

  const startCam = React.useCallback(async () => {
    if (streamRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCamErrMsg("Is browser me camera nahi khulta. Site Chrome (https) me kholo, in-app browser me nahi.");
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
      setCamOn(true); setCamErrMsg(null);
    } catch (e) {
      const nm = (e as Error).name || "";
      setCamErrMsg(
        nm === "NotAllowedError" || nm === "SecurityError"
          ? "Camera blocked — circle pe tap karke Allow choose karo (ya browser settings me is site ke liye camera on karo)."
          : nm === "NotReadableError" || nm === "TrackStartError" || nm === "AbortError"
            ? "Camera busy hai — Meet/Zoom/WhatsApp jaise apps band karke circle pe dobara tap karo."
            : nm === "NotFoundError" || nm === "OverconstrainedError" || nm === "DevicesNotFoundError"
              ? "Is device pe camera nahi mila."
              : `Camera error: ${nm || "unknown"} — circle pe tap karke retry karo.`,
      );
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

  function onMark() {
    setConfirmQuick(false);
    const photo = requireSelfie ? capture() : null;
    mark.mutate({
      photo,
      code,
      lat: coords.current?.lat ?? null,
      lng: coords.current?.lng ?? null,
      accuracy: coords.current?.accuracy ?? null,
      device: getDeviceToken(),
    });
  }

  function onPrimary() {
    // Quick check-out (just checked in) → confirm first, so a stray tap doesn't end the day.
    if (quickCheckout && !confirmQuick) { setConfirmQuick(true); return; }
    onMark();
  }

  return (
    <Card className="p-6 md:p-8 text-center">
      <p className="text-sm text-ink-3">Namaste</p>
      <p className="font-serif text-2xl mt-0.5">{name}</p>

      {needsCam && (
        <div className="mt-5">
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
              <span className="text-[10px] leading-tight">Camera on karne ke liye tap</span>
            </button>
          )}
          <p className={cn("mt-2 text-xs", camErrMsg ? "text-rose" : "text-ink-3")}>
            {camErrMsg ?? (camOn ? "Camera dekho — selfie ke saath attendance mark hogi." : "Selfie zaroori hai.")}
          </p>
        </div>
      )}

      {requirePresence && pending && (
        <div className="mt-5 text-left">
          <label htmlFor="office-code" className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
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
          <p className="mt-1.5 text-[11px] text-ink-3">
            Office tablet pe abhi jo code chal raha hai wahi daalo — isse pata chalta hai aap office me hi ho.
          </p>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-hairline p-4">
          <p className="text-[11px] uppercase tracking-wider text-ink-3">Check-in</p>
          <p className={cn("font-serif text-2xl mt-1 tabular-nums", checkIn ? "text-emerald" : "text-ink-3")}>
            {fmtTime(checkIn)}
          </p>
        </div>
        <div className="rounded-lg border border-hairline p-4">
          <p className="text-[11px] uppercase tracking-wider text-ink-3">Check-out</p>
          <p className={cn("font-serif text-2xl mt-1 tabular-nums", checkOut ? "text-indigo" : "text-ink-3")}>
            {fmtTime(checkOut)}
          </p>
        </div>
      </div>

      <div className="mt-6">
        {state === "done" && fmtDuration(checkIn, checkOut) && (
          <p className="mb-3 text-sm text-ink-2">Aaj office me: <b className="text-ink">{fmtDuration(checkIn, checkOut)}</b></p>
        )}
        {confirmQuick ? (
          <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-4">
            <p className="text-sm text-ink">
              Aapne sirf <b>{Math.max(1, Math.round(minsSince(checkIn)))} min</b> pehle check-in kiya tha — pakka check-out karna hai?
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setConfirmQuick(false)}>Nahi, rehne do</Button>
              <Button className="flex-1" loading={mark.isPending} onClick={onMark}>Haan, check-out</Button>
            </div>
          </div>
        ) : state === "done" ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-soft px-4 py-2 text-sm text-emerald">
            <Icon name="check_circle" className="h-4 w-4" />
            Aaj ki attendance complete hai
          </div>
        ) : (
          <Button
            size="lg"
            className="w-full h-14 text-base"
            onClick={onPrimary}
            disabled={mark.isPending || (requireSelfie && !camOn) || (requirePresence && code.length !== 6)}
          >
            <Icon name={state === "out" ? "check" : "logout"} className="h-5 w-5 mr-2" />
            {mark.isPending ? "…" : state === "out" ? "Check In" : "Check Out"}
          </Button>
        )}

        {canUndo && !confirmQuick && (
          <button
            className="mt-3 text-[12px] text-ink-3 hover:text-rose disabled:opacity-50"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
          >
            {undo.isPending ? "Undo ho raha hai…" : `Galti se ${state === "done" ? "check-out" : "check-in"} ho gaya? Undo karo`}
          </button>
        )}
      </div>

      <p className="text-[11px] text-ink-3 mt-4">
        {[
          "Login",
          requireSelfie ? "selfie" : null,
          requirePresence ? "office code" : null,
          pending && geoState === "ok" ? "location" : null,
        ].filter(Boolean).join(" + ")}
        {" — "}
        itne proof ke saath aapki attendance record hoti hai, taaki koi aur na laga sake.
      </p>
    </Card>
  );
}

function LinkEmployeeCard() {
  const empQ = useEmployees();
  const link = useSetMyEmployee();
  const [selected, setSelected] = React.useState<string>("");

  const employees = (empQ.data ?? []).filter((e) => e.is_active);

  return (
    <Card className="p-6 md:p-8">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
          <Icon name="user" className="h-6 w-6 text-amber-ink" />
        </div>
        <h2 className="font-serif text-xl">Apna naam select karo</h2>
        <p className="text-sm text-ink-3 mt-1">
          Attendance mark karne se pehle, ek baar apne employee record se link karo.
        </p>
      </div>

      {empQ.isLoading ? (
        <Skeleton className="h-10 w-full mt-6" />
      ) : employees.length === 0 ? (
        <p className="mt-6 text-center text-sm text-ink-3">
          Koi active employee record nahi mila. Owner se kaho ki Payroll me aapko employee ke roop me add kare.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger>
              <SelectValue placeholder="Employee choose karo" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="w-full"
            disabled={!selected || link.isPending}
            onClick={() => link.mutate(selected)}
          >
            {link.isPending ? "Link ho raha hai…" : "Link & continue"}
          </Button>
        </div>
      )}
    </Card>
  );
}
