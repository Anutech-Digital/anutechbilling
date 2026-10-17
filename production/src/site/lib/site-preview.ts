/**
 * R-1508 (17 Oct 2026, Pawan, staging report fdd10544): "website preview" for a signed-in team member.
 *
 * On dev/staging hosts the website's "/" and the product page /reselleros send a signed-in user to
 * /dashboard unless the URL says ?preview=1 (R-1500's account-menu "Website ↗" link carries it). But
 * the moment the tester pressed the site's own Home link, the ?preview=1 was gone and the dashboard
 * came back — so the website could not be tested while signed in.
 *
 * Now: a signed-in visit with ?preview=1 sets a browser-session cookie (no expiry; gone when the
 * browser closes). Both pages honour EITHER the ?preview=1 OR this cookie. Typing a bare "/" without
 * having opened the preview keeps today's behaviour (dashboard). The middleware clears the cookie on
 * a signed-out request, so a signed-out visitor never carries it.
 *
 * Not httpOnly on purpose: the website's "Back to dashboard / Report a problem" strip
 * (SitePreviewBar) reads it in the browser, so the shared website layout never has to read cookies
 * on the server — that would turn every statically cached website page (ISR) into a per-request
 * render for all visitors. The cookie grants nothing: it only stops the dashboard bounce, and the
 * strip itself appears only after the browser confirms a signed-in team member.
 */

export const SITE_PREVIEW_COOKIE = "ros_site_preview";

/** The cookie's options — a browser-session cookie (no maxAge/expires). */
export const SITE_PREVIEW_COOKIE_OPTIONS = { path: "/", sameSite: "lax", httpOnly: false } as const;

/** Is this website request in preview (stay on the website, do not bounce a signed-in user)? */
export function isSitePreview(previewParam: string | string[] | undefined | null, cookieValue: string | undefined | null): boolean {
  const p = Array.isArray(previewParam) ? previewParam[0] : previewParam;
  return p === "1" || cookieValue === "1";
}

/** Page side: ?preview=1 answers at once; only otherwise is the cookie read (`readCookie`). */
export async function sitePreviewOn(
  previewParam: string | string[] | undefined | null,
  readCookie: () => Promise<string | undefined>,
): Promise<boolean> {
  if (isSitePreview(previewParam, undefined)) return true;
  return isSitePreview(undefined, await readCookie());
}

/**
 * What the middleware does with the preview cookie on one request.
 * "set": signed in and the URL carries ?preview=1 — remember it for this browser session.
 * "clear": signed out but the cookie is still there (signed out in this browser) — drop it.
 * "keep": anything else (API calls never touch it).
 */
export function sitePreviewCookieAction(i: {
  pathname: string;
  previewParam: string | null;
  cookieValue: string | undefined;
  signedIn: boolean;
}): "set" | "clear" | "keep" {
  if (i.pathname.startsWith("/api/")) return "keep";
  if (!i.signedIn) return i.cookieValue !== undefined ? "clear" : "keep";
  if (i.previewParam === "1" && i.cookieValue !== "1") return "set";
  return "keep";
}

/** Browser side: does document.cookie carry the preview cookie? */
export function hasSitePreviewCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((c) => c.trim() === `${SITE_PREVIEW_COOKIE}=1`);
}
