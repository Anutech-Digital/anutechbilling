/**
 * R-520: the ResellerOS site's own header and footer (reselleros.anutech.in).
 * Short nav: logo → "/", Features, Pricing, Log in, Start free trial. Nothing about the
 * company's domains/hosting/custom-software offer — that lives on anutech.in.
 * App tokens (bg-paper / text-ink / amber) so light and dark themes both work.
 */
import Image from "next/image";
import Link from "next/link";
import { PLATFORM_OPERATOR } from "@/lib/platform";
import { CLIENT_AREA_URL } from "@/site/lib/config";
import { COMPANY_ORIGIN } from "@/site/lib/site-split";
import { HOME } from "@/site/lib/data/reselleros-home";

/** The DMS customer panel, only when it is a real separate address — never the staff /login (R-460). */
export const CUSTOMER_LOGIN_URL: string | null = /^https?:\/\//.test(CLIENT_AREA_URL) ? CLIENT_AREA_URL : null;

export function ProductHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-paper/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <Link href="/" className="flex min-w-0 items-center gap-2 text-ink" aria-label="ResellerOS home">
          <Image src={PLATFORM_OPERATOR.logo} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-full" />
          <span className="truncate font-serif text-lg">{PLATFORM_OPERATOR.productName}</span>
        </Link>
        <nav className="flex shrink-0 items-center gap-1 text-sm sm:gap-2" aria-label="Main">
          <a href="#features" className="hidden rounded-md px-2 py-2 text-ink-2 hover:text-ink sm:inline-block">Features</a>
          <Link href="/pricing" className="hidden rounded-md px-2 py-2 text-ink-2 hover:text-ink sm:inline-block">Pricing</Link>
          <Link href="/login" className="rounded-md px-2 py-2 text-ink-2 hover:text-ink">{HOME.ctaLogin}</Link>
          <Link
            href="/signup"
            className="rounded-md bg-amber px-3 py-2 font-medium text-white shadow-sm hover:bg-amber/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
          >
            <span className="sm:hidden">Start free</span>
            <span className="hidden sm:inline">{HOME.ctaPrimary}</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function ProductFooter() {
  return (
    <footer className="mt-16 border-t border-hairline">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 text-xs text-ink-3 sm:px-5 md:flex-row md:items-center md:justify-between">
        <span>
          © {new Date().getFullYear()} {PLATFORM_OPERATOR.legalName} · {PLATFORM_OPERATOR.city}
        </span>
        <nav className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Footer">
          <Link href="/pricing" className="hover:text-ink">Pricing</Link>
          <Link href="/about" className="hover:text-ink">About</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          {CUSTOMER_LOGIN_URL && (
            <a href={CUSTOMER_LOGIN_URL} className="hover:text-ink">{HOME.clientLoginCta}</a>
          )}
          <a href={COMPANY_ORIGIN} className="hover:text-ink">{HOME.companyLink}</a>
        </nav>
      </div>
    </footer>
  );
}
