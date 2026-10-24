import type { Metadata } from "next";
import { IST_TZ } from "@/lib/dates/ist";
import { getStatusSnapshot, type OverallState, type ServiceState } from "./checks";

export const metadata: Metadata = {
  title: "System status",
  description: "Live status of our website, database, payment gateway, domain registry API and email — checked every minute.",
};

/**
 * R-1503: what each service is doing NOW, from live server-side checks (checks.ts) — no
 * invented availability figures. Rendered per request; the checks themselves are cached for 60 s,
 * so this page cannot be used to hammer the database or a partner API.
 */
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<ServiceState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  "not-configured": "Not configured",
};

const STATE_COLOR: Record<ServiceState, string> = {
  operational: "var(--success)",
  degraded: "var(--warning)",
  down: "var(--danger)",
  "not-configured": "var(--text-secondary)",
};

const BANNER: Record<OverallState, { text: string; color: string; bg: string }> = {
  operational: { text: "ALL SYSTEMS OPERATIONAL", color: "var(--success)", bg: "#EEF7F0" },
  degraded: { text: "SOME SYSTEMS ARE SLOW", color: "var(--warning)", bg: "#FdF6E7" },
  down: { text: "SOME SYSTEMS ARE DOWN", color: "var(--danger)", bg: "#FCEDEC" },
};

function istTime(d: Date): string {
  return `${d.toLocaleString("en-IN", {
    timeZone: IST_TZ, day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  })} IST`;
}

export default async function StatusPage() {
  const snap = await getStatusSnapshot();
  const banner = BANNER[snap.overall];
  return (
    <section className="section rise">
      <div className="wrap" style={{ maxWidth: 860 }}>
        <div
          className="mono-label"
          role="status"
          style={{
            display: "inline-block", padding: "8px 14px", borderRadius: 999, marginBottom: 24,
            background: banner.bg, color: banner.color, border: `1px solid ${banner.color}`,
          }}
        >
          {banner.text}
        </div>
        <h1 className="h1-narrow" style={{ marginBottom: 8 }}>System status</h1>
        <p className="body-lg" style={{ margin: "0 0 8px" }}>
          What each service is doing right now, checked live from our servers.
        </p>
        <p className="meta" style={{ margin: "0 0 34px" }}>
          Last checked <time dateTime={snap.checkedAt.toISOString()}>{istTime(snap.checkedAt)}</time>.
          Checks refresh every minute — reload the page to see the latest.
        </p>

        {snap.services.map((s) => (
          <div key={s.key} style={{ padding: "18px 0", borderTop: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
              <span
                aria-hidden
                style={{ width: 9, height: 9, borderRadius: 999, flex: "none", background: STATE_COLOR[s.state] }}
              />
              <span style={{ fontSize: 16, fontWeight: 700 }}>{s.name}</span>
              <span className="meta">{s.note}</span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: STATE_COLOR[s.state] }}>
                {STATE_LABEL[s.state]}
              </span>
            </div>
            <p className="meta" style={{ margin: "0 0 0 19px" }}>{s.explain}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
