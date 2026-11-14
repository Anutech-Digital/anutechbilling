import { WarmScope } from "@/site/components/chrome/WarmScope";

/** Website theme switch (Settings → Branding, docs/WEBSITE-THEME.md): ResellerOS about. Classic unchanged. */
export default function WarmLayout({ children }: { children: React.ReactNode }) {
  return <WarmScope kind="product">{children}</WarmScope>;
}
