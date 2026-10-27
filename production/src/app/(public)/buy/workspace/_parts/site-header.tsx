"use client";
/**
 * R-1970: the buy page's sticky header — the website tenant's name and logo, the section nav
 * (wide screens), the phone (very wide screens) and "Buy now", which takes the visitor to the
 * checkout section on this page. No cart here (DECISIONS 4).
 */
import Link from "next/link";
import { PARTNER_BADGE } from "@/site/lib/config";
import type { BuyBrand, BuyContact } from "./brand";
import { goTo } from "./wordmark";

export const NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: "plans", label: "Plans" },
  { id: "compare", label: "Compare" },
  { id: "why-us", label: "Why us" },
  { id: "faq", label: "FAQ" },
  { id: "talk-to-us", label: "Talk to us" },
];

export function BrandMark({ brand }: { brand: BuyBrand | null }) {
  const name = brand?.name ?? "Google Workspace";
  return (
    <Link href="/" className="flex items-center gap-2.5 min-w-0 no-underline text-ink" aria-label={`${name} home`}>
      {brand?.logoUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element -- tenant logo, any host */
        <img src={brand.logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain bg-white" />
      ) : (
        <span aria-hidden className="h-9 w-9 shrink-0 rounded-lg bg-ink text-paper grid place-items-center font-serif text-xl">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="min-w-0">
        <span className="block font-serif text-[17px] leading-none truncate">{name}</span>
        <span className="block text-[11px] text-ink-3 mt-[3px] truncate">{PARTNER_BADGE}</span>
      </span>
    </Link>
  );
}

export function SiteHeader({
  brand, contact, onNav, onBuy,
}: {
  brand: BuyBrand | null;
  contact: BuyContact;
  onNav: (id: string) => void;
  onBuy: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 bg-paper/95 backdrop-blur-sm border-b border-hairline">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-5">
        <BrandMark brand={brand} />
        <nav aria-label="On this page" className="hidden min-[1000px]:flex gap-1 ml-3">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => (onNav ? onNav(n.id) : goTo(n.id))}
              className="px-3 py-2 text-sm text-ink-2 rounded-md whitespace-nowrap hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3.5 shrink-0">
          {contact.tel && (
            <a href={contact.tel.href} className="hidden min-[1180px]:inline text-sm font-medium text-ink no-underline whitespace-nowrap">
              {contact.tel.display}
            </a>
          )}
          <button
            type="button"
            onClick={onBuy}
            className="h-10 px-[18px] rounded-lg bg-amber text-white text-sm font-semibold whitespace-nowrap hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
          >
            Buy now
          </button>
        </div>
      </div>
    </header>
  );
}
