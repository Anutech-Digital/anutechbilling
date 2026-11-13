/**
 * Public website footer — a forest-green panel ("Forest — dark panels",
 * docs/WEBSITE-THEME.md).
 *
 * Theme only: each page passes the links and the company line its footer
 * already had, word for word. The "Contact" mail link was on every old footer
 * and is always shown.
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";

interface SiteFooterProps {
  links: ReadonlyArray<{ href: string; label: string }>;
  /** The company line under the links, exactly as the page had it. */
  note: string;
  /** Show the ResellerOS wordmark (the landing page's footer had it). */
  showBrand?: boolean;
}

export function SiteFooter({ links, note, showBrand = false }: SiteFooterProps) {
  return (
    <footer className="bg-[hsl(var(--site-forest))] text-[#E9F0EC]">
      <div className="mx-auto max-w-[1320px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          {showBrand && (
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#F4B740] text-[#17241F]">
                <Icon name="layout" className="h-4 w-4" />
              </span>
              <span className="font-serif text-lg">ResellerOS</span>
            </div>
          )}
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-medium">
            {links.map((l) => (
              <Link key={l.href} href={l.href as never} className="text-[#C9DED6] transition-colors hover:text-white">
                {l.label}
              </Link>
            ))}
            <a href="mailto:hello@resellersos.in" className="text-[#C9DED6] transition-colors hover:text-white">
              Contact
            </a>
          </nav>
        </div>
        <p className="mt-8 border-t border-white/15 pt-6 text-[13px] text-[#B5CBC2]">{note}</p>
      </div>
    </footer>
  );
}
