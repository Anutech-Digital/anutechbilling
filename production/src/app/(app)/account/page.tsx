/**
 * /account — the personal login's Account page (GP-07a, R-2115). Opened from the avatar menu,
 * not a sidebar row (nav.ts OFF_MENU_ROLES). A personal login cannot open /settings or /team,
 * so this is where it sees who it is signed in as. Profile edits, data export and account
 * deletion (DPDP) are later G-PERSONAL cards.
 */
"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { submitSignOut } from "@/components/layout/account-menu-items";

export default function AccountPage() {
  const { data: me, isLoading } = useCurrentUser();

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[720px] mx-auto space-y-5">
      <h1 className="text-2xl md:text-3xl font-serif text-ink">Account</h1>
      <Card className="p-6 space-y-4">
        {isLoading ? (
          <Skeleton className="h-12 w-64 rounded" />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-ink-3">Name</dt>
            <dd className="text-ink">{me?.fullName || "—"}</dd>
            <dt className="text-ink-3">Email</dt>
            <dd className="text-ink break-all">{me?.authEmail || "—"}</dd>
          </dl>
        )}
        <Button variant="outline" onClick={submitSignOut}>Sign out</Button>
      </Card>
    </div>
  );
}
