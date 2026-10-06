/**
 * What the customer sees after clicking the link in their "confirm your email"
 * trial mail. The confirm route (api/public/trial/hosting/confirm) redirects to
 * /hosting/trial?confirmed=<status> and this renders that status.
 *
 * This is all that is left of the old trial FORM. On 24 Sep 2026 "Start free
 * trial" moved into the cart (Pardeep: no page in between), so the details are
 * now collected at checkout and the trial is started by lib/hosting/start-trial.
 * The confirmation link still lands here, which is why the page survives.
 *
 * Once the DMS engine has created the account (provisioned / already), the main
 * button is the Customer Portal login (1 Oct 2026, Pawan): the hosting lives in
 * the customer's DMS account, and DMS emails them a "set your password" link for
 * it. While a person still has to set it up (pending / error) the page says so
 * plainly and does not promise a login that does not exist yet.
 *
 * Styled to match the hosting landing (Manrope + Instrument Serif, the cream /
 * orange palette). It renders under (marketing), so the site menu is above it.
 */
import { trialSans as manrope } from "@/lib/fonts";
import { CLIENT_AREA_URL } from "@/site/lib/config";
import { TRIAL_STATUSES } from "@/site/lib/trial-statuses";


const C = {
  ink: "#17120F", ink2: "#4A403A", paper: "#FDFBF8",
  accBorder: "#FBD3B8", accSurf: "#FFF1E7", successSurf: "#F0FDF4", successBorder: "#BBF7D0",
};

export function HostingTrialStatus({ status }: { status: string }) {
  const m = TRIAL_STATUSES[status] ?? TRIAL_STATUSES.invalid;
  const btn = { display: "inline-block", padding: "14px 24px", borderRadius: 11, fontSize: 15, fontWeight: 700, textDecoration: "none" } as const;
  return (
    <div className={manrope.variable} style={{ fontFamily: "var(--htf-sans), system-ui, sans-serif", background: C.paper, color: C.ink, padding: "clamp(32px,6vw,64px) 20px clamp(48px,8vw,80px)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: m.ok ? C.successSurf : C.accSurf, border: `1px solid ${m.ok ? C.successBorder : C.accBorder}`, borderRadius: 18, padding: "clamp(28px,4vw,44px)", textAlign: "center" }}>
        <div style={{ fontSize: 40 }} aria-hidden>{m.ok ? "✓" : "!"}</div>
        <h1 style={{ fontSize: "clamp(24px,4vw,34px)", fontWeight: 800, letterSpacing: "-.03em", marginTop: 8 }}>{m.title}</h1>
        <p style={{ marginTop: 14, fontSize: 17, lineHeight: 1.55, color: C.ink2 }}>{m.body}</p>
        <div style={{ marginTop: 22, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {m.portal && (
            <a href={CLIENT_AREA_URL} style={{ ...btn, background: C.ink, color: C.paper }}>Log in to the Customer Portal</a>
          )}
          <a
            href="/hosting#choose"
            style={m.portal ? { ...btn, background: "transparent", color: C.ink, border: `1px solid ${C.ink}` } : { ...btn, background: C.ink, color: C.paper }}
          >
            Back to hosting
          </a>
        </div>
      </div>
    </div>
  );
}
