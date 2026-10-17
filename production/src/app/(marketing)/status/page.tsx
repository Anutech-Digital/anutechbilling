import type { Metadata } from "next";
import { STATUS_SERVICES } from "@/site/lib/data/misc";

export const metadata: Metadata = {
  title: "System status",
  description: "Ninety days of status per service. SLA credits apply automatically — you never have to file for one.",
};

/**
 * Six services, each with a dot, its 90-day uptime and 30 bars (3 days per bar; amber =
 * degraded). Static demo data from the handoff — a real status feed replaces
 * STATUS_SERVICES, and nothing on this page needs to change shape for that.
 */
export default function StatusPage() {
  const anyBad = STATUS_SERVICES.some((s) => s.bad.length > 0);
  return (
    <section className="section rise">
      <div className="wrap" style={{ maxWidth: 860 }}>
        <div
          className="mono-label"
          style={{
            display: "inline-block", padding: "8px 14px", borderRadius: 999, marginBottom: 24,
            background: anyBad ? "#FdF6E7" : "#EEF7F0",
            color: anyBad ? "var(--warning)" : "var(--success)",
            border: `1px solid ${anyBad ? "var(--warning)" : "var(--success)"}`,
          }}
        >
          {anyBad ? "MINOR DEGRADATION IN THE LAST 90 DAYS" : "ALL SYSTEMS OPERATIONAL"}
        </div>
        <h1 className="h1-narrow" style={{ marginBottom: 8 }}>System status</h1>
        <p className="body-lg" style={{ margin: "0 0 34px" }}>
          Ninety days per service, three days per bar. SLA credits apply automatically — you never
          have to file for one.
        </p>

        {STATUS_SERVICES.map((s) => (
          <div key={s.name} style={{ padding: "18px 0", borderTop: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <span
                aria-hidden
                style={{ width: 9, height: 9, borderRadius: 999, flex: "none", background: s.bad.length ? "var(--warning)" : "var(--success)" }}
              />
              <span style={{ fontSize: 16, fontWeight: 700 }}>{s.name}</span>
              <span className="meta">{s.note}</span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 14, fontWeight: 500 }}>{s.uptime}</span>
            </div>
            <div style={{ display: "flex", gap: 3 }} aria-label={`${s.name}: ${s.bad.length} degraded period(s) in 90 days`}>
              {Array.from({ length: 30 }, (_, i) => (
                <span
                  key={i}
                  style={{ flex: 1, height: 26, borderRadius: 2, background: s.bad.includes(i) ? "var(--bar-warn)" : "var(--bar-ok)" }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
