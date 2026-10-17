import type { Metadata } from "next";
import { COMPARE_ROWS } from "@/site/lib/data/copy";

export const metadata: Metadata = {
  title: "Why us",
  description: "Ten differences between Anutech Digital and the usual way, stated flatly. No competitor named.",
};

/**
 * Ten rows, us vs "the typical platform" — no competitor is ever named (PROJECT_NOTES:
 * "ResellerClub … is the competitor, never the brand. Never name competitors on the page").
 * The Anutech column renders on the dark band in --primary-on-dark with success-green values.
 */
export default function WhyUsPage() {
  return (
    <section className="section rise">
      <div className="wrap">
        <div style={{ maxWidth: 640, marginBottom: 34 }}>
          <h1 className="h1-page" style={{ marginBottom: 16 }}>Us, against the usual way.</h1>
          <p className="body-lg" style={{ margin: 0 }}>
            Ten differences, stated flatly. No competitor named — if you have used one of the big
            platforms, you will recognise the right-hand column on your own.
          </p>
        </div>

        <div className="tablewrap">
          <table className="rates" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th></th>
                <th style={{ color: "var(--primary-on-dark)" }}>ANUTECH DIGITAL</th>
                <th style={{ color: "#5C6672" }}>TYPICAL PLATFORM</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((r) => (
                <tr key={r.label}>
                  <td style={{ fontWeight: 600 }}>{r.label}</td>
                  <td style={{ color: "var(--success)", fontWeight: 600 }}>{r.us}</td>
                  <td style={{ color: "var(--text-muted)" }}>{r.them}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
