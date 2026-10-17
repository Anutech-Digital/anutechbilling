"use client";
/**
 * R-1508 (17 Oct 2026, Pawan, staging report fdd10544): a thin strip at the top of the website for a
 * signed-in team member who opened it in preview (account menu → "Website ↗", ?preview=1):
 * "Back to dashboard" and "Report a problem" — the app's own Help panel, so a website bug goes into
 * the same AI-Help queue with the website page's path.
 *
 * Visitors pay nothing for it: without the preview cookie (site/lib/site-preview.ts) this renders
 * nothing and the tools chunk (the app's Help panel, the current-user query) is never downloaded.
 * With the cookie, the tools still render nothing until the browser confirms a signed-in team
 * member (a users row with a workspace) — a customer or a signed-out visitor never sees them.
 *
 * In the page flow, not floating: R-1498's one floating launcher and the R-230 "nothing floats on
 * /checkout and /done" rules stay exactly as they are.
 */
import * as React from "react";
import { hasSitePreviewCookie } from "@/site/lib/site-preview";

const SitePreviewTools = React.lazy(() => import("@/components/shared/site-preview-tools"));

export function SitePreviewBar() {
  const [previewing, setPreviewing] = React.useState(false);
  React.useEffect(() => { setPreviewing(hasSitePreviewCookie(document.cookie)); }, []);
  if (!previewing) return null;
  return (
    <React.Suspense fallback={null}>
      <SitePreviewTools />
    </React.Suspense>
  );
}
