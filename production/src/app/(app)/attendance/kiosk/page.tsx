/**
 * Attendance kiosk — the office keeps this page open on a shared tablet/phone
 * (logged in as the owner). Each employee taps their name and enters their PIN
 * to check in / out. Because the device is physically at the office, presence
 * is guaranteed. PIN is verified server-side (mark_attendance RPC).
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";
import { useEmployees, useAttendance, useMarkAttendance, useAttendanceNetwork, type Employee } from "@/lib/queries/payroll";

function istToday(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function istPeriod(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}

export default function AttendanceKioskPage() {
  const empQ = useEmployees();
  const attQ = useAttendance(istPeriod());
  const netQ = useAttendanceNetwork();
  const [pinFor, setPinFor] = React.useState<Employee | null>(null);

  const net = netQ.data;
  const locked = (net?.allowedIps.length ?? 0) > 0;
  const offNetwork = locked && net?.onAllowedNetwork === false;

  // Selfies are captured inside the PIN pad — the camera starts on the tap that
  // opens it (a user gesture, required by mobile browsers) and shows a live
  // preview (a visible <video>, so mobile actually renders frames to capture).

  async function goFullscreen() {
    try { await document.documentElement.requestFullscreen(); } catch { /* not supported */ }
  }

  const today = istToday();
  const employees = (empQ.data ?? []).filter((e) => e.is_active);
  const todayAtt = new Map(
    (attQ.data ?? []).filter((a) => a.work_date === today).map((a) => [a.employee_id, a]),
  );

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      <div className="mb-6 text-center relative">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Attendance</h1>
        <p className="text-sm text-ink-3 mt-1">Tap your name and enter your PIN to check in or out.</p>
        <div className="mt-2 flex items-center justify-center gap-3 text-[11px]">
          {locked ? (
            <span className={cn("inline-flex items-center gap-1", offNetwork ? "text-rose" : "text-emerald")}>
              <Icon name={offNetwork ? "alert" : "lock"} size={12} />
              {offNetwork ? "Not on the office network — marking is blocked here" : "Locked to office network"}
            </span>
          ) : (
            <span className="text-ink-3">Network lock off</span>
          )}
          <span className="inline-flex items-center gap-1 text-ink-3">
            <Icon name="eye" size={12} /> Selfie taken at check-in
          </span>
          <button onClick={goFullscreen} className="text-ink-3 hover:text-ink inline-flex items-center gap-1">
            <Icon name="external" size={12} /> Fullscreen
          </button>
        </div>
      </div>

      {net?.requirePresence && <PresenceCodeBanner />}

      {empQ.isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : employees.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No employees" body="Add employees in Payroll → Employees, then set their PIN." /></Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {employees.map((e) => {
            const a = todayAtt.get(e.id);
            const done = a?.check_out != null;
            const inOnly = a?.check_in != null && a?.check_out == null;
            return (
              <button
                key={e.id}
                onClick={() => setPinFor(e)}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors min-h-[96px] flex flex-col justify-between",
                  done ? "border-hairline bg-paper-2/50"
                       : inOnly ? "border-emerald/40 bg-emerald-soft/30"
                       : "border-hairline bg-paper hover:border-amber/50 hover:bg-amber-soft/20",
                )}
              >
                <div className="font-medium text-ink leading-tight">{e.name}</div>
                <div className="text-[11px] mt-2">
                  {done ? (
                    <span className="text-ink-3">In {fmtTime(a!.check_in)} · Out {fmtTime(a!.check_out)}</span>
                  ) : inOnly ? (
                    <span className="text-emerald font-medium">In since {fmtTime(a!.check_in)} — tap to check out</span>
                  ) : (
                    <span className="text-ink-3">Not checked in</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {pinFor && <PinPad employee={pinFor} requireSelfie={net?.requireSelfie ?? true} onClose={() => setPinFor(null)} />}
    </div>
  );
}

/**
 * The rotating office code — shown big on the office tablet. Employees checking
 * in from their OWN phones (My Attendance) must type this current code, so they
 * can only do it while physically in the office reading this screen.
 */
function PresenceCodeBanner() {
  const [code, setCode] = React.useState<string | null>(null);
  const [secs, setSecs] = React.useState(0);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/attendance/presence-code");
      if (!res.ok) return;
      const j = (await res.json()) as { code: string; secondsRemaining: number };
      setCode(j.code); setSecs(j.secondsRemaining);
    } catch { /* transient — next tick retries */ }
  }, []);

  React.useEffect(() => {
    void refresh();
    const tick = setInterval(() => {
      setSecs((s) => {
        if (s <= 1) { void refresh(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [refresh]);

  return (
    <Card className="mb-5 p-4 md:p-5 border-amber/40 bg-amber-soft/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-amber-ink font-semibold">Office check-in code</div>
          <p className="text-xs text-ink-3 mt-0.5 max-w-md">
            Apne phone se attendance mark karne wale employees ye code daalenge. Har {secs > 0 ? "" : "kuch"} second me badalta hai — office me hi dikhega.
          </p>
        </div>
        <div className="text-center">
          <div className="font-mono text-4xl md:text-5xl font-bold tracking-[0.25em] tabular-nums text-ink">
            {code ?? "······"}
          </div>
          <div className="text-[11px] text-ink-3 mt-1">refreshes in {secs}s</div>
        </div>
      </div>
    </Card>
  );
}

function PinPad({ employee, requireSelfie, onClose }: { employee: Employee; requireSelfie: boolean; onClose: () => void }) {
  const mark = useMarkAttendance();
  const [pin, setPin] = React.useState("");
  const [result, setResult] = React.useState<{ ok: boolean; msg: string } | null>(null);

  // Camera lives here: opening the pad is the user gesture mobile browsers need,
  // and the live preview below is a visible <video> so frames actually render.
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = React.useState(false);
  const [camErrMsg, setCamErrMsg] = React.useState<string | null>(null);
  const camErr = camErrMsg !== null;
  const startCam = React.useCallback(async () => {
    if (streamRef.current) return;
    // Browser too old / insecure context → no camera API at all.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCamErrMsg("This browser can't open the camera here. Open the site in Chrome (https), not an in-app browser.");
      return;
    }
    // Try the front camera first; many laptops don't advertise a facingMode,
    // so fall back to ANY camera before giving up.
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
      const name = (e as Error).name || "";
      setCamErrMsg(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera blocked — tap the circle above and choose Allow (or enable camera for this site in browser settings)."
          : name === "NotReadableError" || name === "TrackStartError" || name === "AbortError"
            ? "Camera is busy — close other apps/tabs using it (Meet, Zoom, WhatsApp), then tap the circle again."
            : name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError"
              ? "No camera found on this device."
              : `Camera error: ${name || "unknown"} — tap the circle to retry.`,
      );
    }
  }, []);
  React.useEffect(() => {
    // Try to start automatically (works when permission is already granted).
    // If the browser needs a gesture/permission, the placeholder below is a
    // button that retries getUserMedia from a direct tap (reliable on mobile).
    void startCam();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  }, [startCam]);
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

  const push = (d: string) => { if (pin.length < 6 && !result) setPin((p) => p + d); };
  const back = () => setPin((p) => p.slice(0, -1));

  async function submit() {
    if (pin.length < 4) return;
    const photo = capture();
    if (requireSelfie && !photo) {
      setResult({ ok: false, msg: "Turn on the camera — a selfie is required" });
      setTimeout(() => setResult(null), 1600);
      return;
    }
    try {
      const action = await mark.mutateAsync({ employeeId: employee.id, pin, photo });
      const msg = action === "checked_in" ? "Checked in ✓"
        : action === "checked_out" ? "Checked out ✓"
        : action === "too_soon" ? "Abhi to check-in hua — ignore kiya"
        : "Already done for today";
      setResult({ ok: true, msg });
      setTimeout(onClose, 1400);
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
      setTimeout(() => { setResult(null); setPin(""); }, 1400);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-xs p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-center mb-4">
          <video
            ref={videoRef}
            autoPlay muted playsInline
            className={cn(
              "mx-auto mb-3 h-20 w-20 rounded-full border border-hairline bg-paper-2 object-cover [transform:scaleX(-1)]",
              camOn ? "" : "hidden",
            )}
          />
          {!camOn && (
            <button
              type="button"
              onClick={startCam}
              className="mx-auto mb-3 flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border border-dashed border-hairline bg-paper-2 text-ink-3 hover:border-amber/50 hover:text-amber-ink"
            >
              <Icon name="eye" size={22} />
              <span className="text-[9px] leading-tight">Tap for camera</span>
            </button>
          )}
          <div className="font-serif text-2xl text-ink">{employee.name}</div>
          <div className="text-xs text-ink-3 mt-0.5">
            {camOn
              ? "Look at the camera & enter PIN"
              : camErr
                ? `${camErrMsg}${requireSelfie ? "" : " Or just enter PIN."}`
                : "Enter PIN"}
          </div>
        </div>

        {result ? (
          <div className={cn("text-center py-8 font-medium", result.ok ? "text-emerald" : "text-rose")}>{result.msg}</div>
        ) : (
          <>
            <div className="flex justify-center gap-2 mb-5 h-4">
              {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
                <span key={i} className={cn("w-3 h-3 rounded-full", i < pin.length ? "bg-ink" : "bg-hairline")} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} onClick={() => push(d)} className="h-14 rounded-lg border border-hairline text-xl font-medium text-ink hover:bg-paper-2 active:bg-paper-2">{d}</button>
              ))}
              <button onClick={back} className="h-14 rounded-lg text-ink-3 hover:bg-paper-2" aria-label="Backspace"><Icon name="arrow_left" size={20} className="mx-auto" /></button>
              <button onClick={() => push("0")} className="h-14 rounded-lg border border-hairline text-xl font-medium text-ink hover:bg-paper-2">0</button>
              <button onClick={submit} disabled={pin.length < 4 || mark.isPending} className="h-14 rounded-lg bg-amber text-white font-medium disabled:opacity-40" aria-label="Submit"><Icon name="check" size={22} className="mx-auto" /></button>
            </div>
          </>
        )}

        <button onClick={onClose} className="mt-4 w-full text-center text-xs text-ink-3 hover:text-ink">Cancel</button>
      </Card>
    </div>
  );
}
