"use client";

/**
 * Office location (R-438) — the row in the attendance settings card where the OWNER sets
 * where the office is and what self check-in ("My Attendance") does outside it:
 *   Off   — location only recorded (as before)
 *   Flag  — the mark goes through with an "Outside office" flag in the register
 *   Block — refused: "You are about 500 m from the office"
 * The distance is measured inside the database (mark_self_attendance), so it cannot be
 * skipped. Staff the owner allowed to mark from anywhere are flagged, never blocked.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  DEFAULT_RADIUS_M, describeDistance, distanceM, GEOFENCE_MODES, type GeofenceMode,
} from "@/lib/attendance/geofence";
import { useOfficeLocation, useSetOfficeLocation } from "@/lib/queries/attendance-office-location";

const MODE_LABEL: Record<GeofenceMode, string> = { off: "Off", flag: "Flag", block: "Block" };
const MODE_HELP: Record<GeofenceMode, string> = {
  off: "Location is only recorded. Check-in works from anywhere.",
  flag: "Check-in from outside the circle works but shows an Outside office flag in the register.",
  block: "Check-in from outside the circle is refused. Staff you allowed to mark from anywhere are flagged instead.",
};

type Here = { lat: number; lng: number; accuracy: number };

export function OfficeLocationRow() {
  const q = useOfficeLocation();
  const save = useSetOfficeLocation();
  const saved = q.data;
  const canEdit = saved?.canEdit ?? false;

  const [lat, setLat] = React.useState<number | null>(null);
  const [lng, setLng] = React.useState<number | null>(null);
  const [radius, setRadius] = React.useState<number>(DEFAULT_RADIUS_M);
  const [mode, setMode] = React.useState<GeofenceMode>("off");
  const [here, setHere] = React.useState<Here | null>(null);
  const [locating, setLocating] = React.useState(false);
  const [locError, setLocError] = React.useState<string | null>(null);

  const savedKey = saved ? `${saved.lat}|${saved.lng}|${saved.radiusM}|${saved.mode}` : "";
  React.useEffect(() => {
    if (!saved) return;
    setLat(saved.lat); setLng(saved.lng); setRadius(saved.radiusM); setMode(saved.mode);
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = saved ? `${lat}|${lng}|${radius}|${mode}` !== savedKey : false;
  const hasSpot = lat !== null && lng !== null;

  function locateMe() {
    setLocError(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocError("This browser cannot share its location. Open this page on your phone at the office.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const h = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setHere(h);
        setLat(Number(h.lat.toFixed(6)));
        setLng(Number(h.lng.toFixed(6)));
      },
      (err) => {
        setLocating(false);
        setLocError(err.code === err.PERMISSION_DENIED
          ? "Location permission is off. Allow location for this site in the browser, then try again."
          : "Could not get your location. Step near a window or turn on GPS, then try again.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  const fromSaved = here && saved?.lat != null && saved?.lng != null
    ? distanceM(saved.lat, saved.lng, here.lat, here.lng) : null;

  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <div className="text-sm font-medium text-ink flex items-center gap-2">
        <Icon name="map_pin" size={14} className={saved && saved.mode !== "off" ? "text-emerald" : "text-ink-3"} />
        Office location · {MODE_LABEL[saved?.mode ?? "off"]}
        {saved && saved.mode !== "off" && <span className="text-ink-3 font-normal">· {saved.radiusM} m circle</span>}
      </div>
      <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
        {MODE_HELP[saved?.mode ?? "off"]} Applies to self check-in from a phone (My Attendance).
      </p>

      {canEdit ? (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ lat, lng, radiusM: radius, mode });
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" icon="map_pin" loading={locating} onClick={locateMe}>
              Use my current location
            </Button>
            {hasSpot ? (
              <a
                className="text-xs text-ink-2 underline font-mono"
                href={`https://www.google.com/maps?q=${lat},${lng}`}
                target="_blank"
                rel="noreferrer"
              >
                {lat!.toFixed(5)}, {lng!.toFixed(5)}
              </a>
            ) : (
              <span className="text-xs text-ink-3">No office location yet — stand in the office and tap the button.</span>
            )}
          </div>
          {here && (
            <p className="text-xs text-ink-3">
              This phone&apos;s GPS is accurate to about {Math.round(here.accuracy)} m
              {fromSaved !== null && <> · {describeDistance(fromSaved)} from the saved office</>}.
              {here.accuracy > 100 && " That is weak — try again near a window for a better fix."}
            </p>
          )}
          {locError && <p className="text-xs text-rose" role="alert">{locError}</p>}

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-2">
              Circle (metres)
              <Input type="number" required min={25} max={5000} step={1} value={radius} className="mt-1 w-24"
                onChange={(e) => setRadius(Number(e.target.value))} />
            </label>
            <div className="text-xs text-ink-2">
              Outside the circle
              <div className="mt-1 inline-flex rounded-md border border-hairline overflow-hidden" role="group" aria-label="Outside the circle">
                {GEOFENCE_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    disabled={m !== "off" && !hasSpot}
                    title={m !== "off" && !hasSpot ? "Set the office location first" : undefined}
                    onClick={() => setMode(m)}
                    className={cn(
                      "px-3 h-9 text-xs border-l border-hairline first:border-l-0 disabled:opacity-40",
                      mode === m ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-hairline/40",
                    )}
                  >
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
            <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>Save location</Button>
          </div>
          {mode !== (saved?.mode ?? "off") && <p className="text-xs text-ink-3">{MODE_HELP[mode]}</p>}
        </form>
      ) : (
        <p className="mt-1 text-xs text-ink-3">Only the owner can change the office location.</p>
      )}
    </div>
  );
}
