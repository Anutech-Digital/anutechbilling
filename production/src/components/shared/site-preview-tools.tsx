"use client";
/**
 * R-1508: the preview strip's contents — loaded only for a browser holding the website-preview
 * cookie (SitePreviewBar). Shown only to a signed-in TEAM member: useCurrentUser must find their
 * users row with a workspace (tenantId). Anyone else — signed out, a customer, a stranded login —
 * gets nothing.
 *
 * "Report a problem" opens the app's one Help panel (R-158/R-383, components/shared/ai-help) on its
 * Report tab; the panel files through useSubmitFeedback with this website page's path, into the same
 * Admin → Feedback / AI-Help queue as a report from an app page. Ctrl+Shift+B works here too.
 *
 * It lives with the app's components, not under src/site: it is staff tooling (the app's Help
 * panel, a link into the staff app), and the website's own code never links a customer to
 * /dashboard (site/support-page.test.ts guards that).
 */
import * as React from "react";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { AiHelp, openHelpReport } from "@/components/shared/ai-help";
import { GlobalBugReporter } from "@/components/shared/global-bug-reporter";

const linkCls =
  "inline-flex min-h-9 items-center rounded px-3 py-1.5 font-medium underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper";

export default function SitePreviewTools() {
  const { data: me } = useCurrentUser();
  if (!me?.tenantId) return null;
  return (
    <>
      <div
        role="region"
        aria-label="Website preview"
        data-site-preview-bar=""
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-ink px-4 py-1 text-sm text-paper"
      >
        <span>Website preview — you are signed in</span>
        <span className="flex flex-wrap items-center gap-2">
          <button type="button" className={linkCls} onClick={() => openHelpReport()}>
            Report a problem
          </button>
          <a href="/dashboard" className={linkCls}>
            Back to dashboard
          </a>
        </span>
      </div>
      <GlobalBugReporter />
      <AiHelp />
    </>
  );
}
