import { WarmScope } from "@/site/components/chrome/WarmScope";

/** Website theme switch (Settings → Branding, docs/WEBSITE-THEME.md): Workspace and Support checkouts and their thank-you pages. Classic unchanged. */
export default function WarmLayout({ children }: { children: React.ReactNode }) {
  return <WarmScope kind="site">{children}</WarmScope>;
}
