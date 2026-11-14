import { SiteChromeOnWarm } from "@/site/components/chrome/WarmSiteChrome";

/** Warm theme: inside the company website's header and footer, as designed (Classic unchanged). */
export default function SiteChromeLayout({ children }: { children: React.ReactNode }) {
  return <SiteChromeOnWarm>{children}</SiteChromeOnWarm>;
}
