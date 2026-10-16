/**
 * Account menu items (sidebar footer dropdown).
 *
 * R-1439: "Login / Switch Account" used to be a plain link to /login. The middleware sends a
 * signed-in person straight off /login back to their home (AUTH_PREFIXES), so the click
 * looked dead. This app has one login per browser — no multi-account switcher — so
 * switching means: sign out (server route clears the auth cookies) and land on /login.
 */
"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

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
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={submitSignOut}>
        <Icon name="logout" size={14} /> Sign out
      </DropdownMenuItem>
    </>
  );
}
