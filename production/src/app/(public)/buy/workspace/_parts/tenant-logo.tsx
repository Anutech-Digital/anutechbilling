/**
 * R-1969: the website tenant's logo on /buy/workspace (header, phone header, thanks header,
 * footer). The real logo from the tenant row when there is one; otherwise nothing — the company
 * name next to it says who sells. Never a made-up letter tile (the 26 Oct audit saw a lone "R"
 * where the logo should be).
 */
import type { BuyBrand } from "./brand";

export function TenantLogo({ brand, className, alt = "" }: { brand: BuyBrand | null; className: string; alt?: string }) {
  if (!brand?.logoUrl) return null;
  /* eslint-disable-next-line @next/next/no-img-element -- tenant logo, any host */
  return <img src={brand.logoUrl} alt={alt} className={className} />;
}
