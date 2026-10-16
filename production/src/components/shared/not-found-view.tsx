/**
 * The "this page doesn't exist" screen (R-052, 1 Oct 2026). Before this, a wrong or old
 * link showed Next's bare black-on-white "404 | This page could not be found." with no
 * way back. Used by the root not-found (any unknown URL, logged in or not — /dashboard
 * sends a visitor to login on its own) and by (app)/not-found (inside the sidebar).
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { HostBrand } from "@/site/lib/host-brand";

/** R-1458: `brand` (root 404 only) — on anutech.in the screen wears Anutech Digital and
 *  leads back to the site; without it, or on any other host, it is unchanged. */
export function NotFoundView({ inApp = false, brand }: { inApp?: boolean; brand?: HostBrand }) {
  const company = !inApp && brand?.site === "company" ? brand : null;
  return (
    <div className={inApp ? "flex min-h-[60vh] items-center justify-center p-6" : "flex min-h-screen items-center justify-center bg-paper p-6"}>
      <div className="w-full max-w-md text-center">
        {company && <p className="mb-6 text-sm font-semibold text-ink">{company.name}</p>}
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft text-amber-ink">
          <Icon name="search" size={22} />
        </div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Page not found</p>
        <h1 className="mb-3 font-serif text-2xl text-ink">This link doesn&apos;t lead anywhere.</h1>
        <p className="mb-6 text-sm text-ink-2">
          It may be an old or mistyped link, or the record was deleted. Nothing is lost on your side.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {company?.back ? (
            <Button asChild variant="primary" icon="home">
              <Link href={company.back.href}>{company.back.label}</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="primary" icon="home">
                <Link href="/dashboard">Go to dashboard</Link>
              </Button>
              {!inApp && (
                <Button asChild variant="outline">
                  <Link href="/">Home page</Link>
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
