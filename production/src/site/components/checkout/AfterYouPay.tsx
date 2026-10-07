/**
 * "After you pay" — three short lines on checkout and the done page (R-229, 7 Oct 2026),
 * so a buyer knows when hosting, a domain, Workspace and SSL go live before paying.
 * The text comes from AFTER_YOU_PAY (SLA in site/lib/config), the one place times live.
 */
import type { CSSProperties } from "react";
import { AFTER_YOU_PAY } from "@/site/lib/config";

export function AfterYouPay({ style }: { style?: CSSProperties }) {
  return (
    <div style={style}>
      <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>After you pay</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
        {AFTER_YOU_PAY.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}
