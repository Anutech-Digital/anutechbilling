/**
 * Ad landing pages — the list the app shows under Marketing → Ads landing pages
 * (Pardeep, 4 Oct 2026: "ads landing pages ko bhi app me show karo").
 *
 * One row per page under src/app/(lp)/lp/. Add the row in the same change that adds a page
 * (/lp/google-workspace now forwards to the Starter page), or the team cannot find, copy or check it.
 * Leads are matched by `leads.landing_page_url`, which stores the path + utm params only.
 */
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";

export interface AdLandingPage {
  /** Path on the public site, e.g. "/lp/google-workspace". Leads are matched on it. */
  path: string;
  title: string;
  product: string;
  /** The offer the page leads with — what the ad copy must agree with. */
  offer: string;
  /** Where the visitor's request lands, for the person who answers it. */
  captures: string;
  addedOn: string; // ISO date
}

/** The public marketing domain the ads point at. */
export const PUBLIC_SITE_ORIGIN = "https://anutech.in";

export const AD_LANDING_PAGES: readonly AdLandingPage[] = [
  {
    path: "/lp/google-workspace-1",
    title: "Google Workspace (all plans) — Google Ads Landing Page 1",
    product: "Google Workspace — category page for broad keywords",
    offer: "Starter 30+ users ₹1,650 first year up top; all 4 plans with live prices below + free setup and migration",
    captures: "Call-back form (name + mobile), enquiry per plan, Free trial, WhatsApp",
    addedOn: "2026-10-05",
  },
  {
    path: "/lp/google-workspace-business-starter-1",
    title: "Google Workspace Business Starter — Google Ads Landing Page 1",
    product: "Google Workspace Business Starter",
    offer: "30+ users, new account: ₹1,650/user for the first year (49% off) + free setup and migration",
    captures: "Call-back form (name + mobile), Free trial / Buy enquiry, WhatsApp",
    addedOn: "2026-10-04",
  },
  {
    path: "/lp/google-workspace-business-standard-1",
    title: "Google Workspace Business Standard — Google Ads Landing Page 1",
    product: "Google Workspace Business Standard",
    offer: `Free setup and email migration + ${WORKSPACE_TRIAL_DAYS}-day free trial (no first-year discount)`,
    captures: "Call-back form (name + mobile), Free trial / Buy enquiry, WhatsApp",
    addedOn: "2026-10-04",
  },
  {
    path: "/lp/google-workspace-business-plus-1",
    title: "Google Workspace Business Plus — Google Ads Landing Page 1",
    product: "Google Workspace Business Plus",
    offer: `Free setup and email migration + ${WORKSPACE_TRIAL_DAYS}-day free trial (no first-year discount)`,
    captures: "Call-back form (name + mobile), Free trial / Buy enquiry, WhatsApp",
    addedOn: "2026-10-04",
  },
  {
    path: "/lp/google-workspace-enterprise-1",
    title: "Google Workspace Enterprise — Google Ads Landing Page 1",
    product: "Google Workspace Enterprise",
    offer: "No list price: quote within a day + migration planning and rollout",
    captures: "Call-back form (name + mobile), Quote enquiry, WhatsApp",
    addedOn: "2026-10-04",
  },
];

/** Final URL to paste into Google Ads. Auto-tagging adds the gclid; leads keep it. */
export function adFinalUrl(page: AdLandingPage): string {
  return PUBLIC_SITE_ORIGIN + page.path;
}
