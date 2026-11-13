/**
 * Public website footer — a forest-green panel ("Forest — dark panels",
 * docs/WEBSITE-THEME.md).
 *
 * The company line names ANUTECH DIGITAL PVT LTD. The footers this replaces
 * still said "Excel Technologies Pvt Ltd", a historical name (CLAUDE.md §1,
 * AGENTS.md L19).
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export function SiteFooter() {
  return (
    <footer className="bg-[hsl(var(--site-forest))] text-[#E9F0EC]">
      <div className="mx-auto max-w-[1320px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#F4B740] text-[#17241F]">
              <Icon name="layout" className="h-4 w-4" />
            </span>
            <span className="font-serif text-lg">ResellerOS</span>
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-medium">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href as never} className="text-[#C9DED6] transition-colors hover:text-white">
                {l.label}
              </Link>
            ))}
            <a href="mailto:hello@resellersos.in" className="text-[#C9DED6] transition-colors hover:text-white">
              Contact
            </a>
          </nav>
        </div>
        <p className="mt-8 border-t border-white/15 pt-6 text-[13px] text-[#B5CBC2]">
          © {new Date().getFullYear()} ANUTECH DIGITAL PVT LTD · Made for Indian cloud resellers
        </p>
      </div>
    </footer>
  );
}
