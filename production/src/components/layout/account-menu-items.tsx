/**
 * Account menu items (sidebar footer dropdown).
 *
 * R-1439: "Login / Switch Account" used to be a plain link to /login. The middleware sends a
 * signed-in person straight off /login back to their home (AUTH_PREFIXES), so the click
 * looked dead. This app has one login per browser — no multi-account switcher — so
 * switching means: sign out (server route clears the auth cookies) and land on /login.
 *
 * R-1453: "Website ↗" opens the public product homepage in a new tab, so nobody has to sign
 * out to see it. It points at PRODUCT_HOME_ROUTE, not "/": on staging/local "/" is the company
 * page, and the live hosts 301 the route to https://reselleros.anutech.in/ (site-split.ts).
 */
"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { PRODUCT_HOME_ROUTE } from "@/site/lib/site-split";

/** R-1500: the product homepage sends a signed-in user to /dashboard unless the URL has
 *  ?preview=1, so the link carries it. The live 301 and the product-host rewrite keep the
 *  query (decideSite). A signed-in user typing the bare address still gets the dashboard. */
export const WEBSITE_HREF = `${PRODUCT_HOME_ROUTE}?preview=1`;

/** POST to the sign-out route — it clears the auth COOKIES (the browser-client signOut left
 *  them, so /login bounced back) and 303-redirects to /login. No client await = can't hang. */
export function submitSignOut(): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/auth/sign-out";
  document.body.appendChild(form);
  form.submit();
}

export function AccountMenuItems() {
  return (
    <>
      <DropdownMenuItem onSelect={submitSignOut}>
        <Icon name="user" size={14} /> Switch account (signs you out)
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href="/settings">
          <Icon name="settings" size={14} /> Settings
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href="/team">
          <Icon name="users" size={14} /> Team
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={WEBSITE_HREF} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={14} /> Website <span aria-hidden="true">↗</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={submitSignOut}>
        <Icon name="logout" size={14} /> Sign out
      </DropdownMenuItem>
    </>
  );
}
