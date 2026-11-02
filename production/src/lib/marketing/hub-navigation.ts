export interface HubLink { label: string; href: string }

/** The first place to work when a platform card is opened. */
export const TOOL_WORKSPACES: Readonly<Record<string, HubLink>> = {
  "meta-ads": { label: "Open Meta Ads workspace", href: "/marketing/ads?platform=meta-ads" },
  "google-ads": { label: "Open Google Ads workspace", href: "/marketing/ads?platform=google-ads" },
  "linkedin-ads": { label: "Open LinkedIn Ads workspace", href: "/marketing/ads?platform=linkedin-ads" },
  "google-business": { label: "Open Google Business Profile", href: "/marketing/google-business" },
  indiamart: { label: "Open IndiaMART leads", href: "/marketing/indiamart" },
  justdial: { label: "Open JustDial", href: "https://www.justdial.com/Free-Listing" },
  "whatsapp-business": { label: "Open WhatsApp marketing", href: "/marketing/whatsapp" },
  "email-campaigns": { label: "Open email campaigns", href: "/campaigns" },
  "search-console": { label: "Open Search Console", href: "https://search.google.com/search-console" },
  ga4: { label: "Open Google Analytics", href: "https://analytics.google.com" },
  "facebook-page": { label: "Open Meta Business", href: "https://business.facebook.com" },
  "linkedin-page": { label: "Open LinkedIn Company Page", href: "/marketing/linkedin" },
};

export function isExternalWorkspace(href: string): boolean {
  return /^https?:\/\//.test(href);
}

export function workspaceRoute(href: string): string {
  return href.split("?")[0];
}
