"use client";

/**
 * /change-password — R-391. An owner set a temporary password for this account
 * (/team → Set temporary password); the member picks their own before using the app.
 * The middleware (GoTrue) and the app shell's MustChangePasswordGate (both paths) send them
 * here. The change itself is /api/settings/change-password, which re-checks the temporary
 * password and clears the flag in the same write.
 */
import * as React from "react";
import { useSearchParams } from "next/navigation";
import ChangePasswordCard from "@/components/features/settings/change-password-card";
import { safeNextPath } from "@/lib/auth/must-change-password";

export default function ChangePasswordPage() {
  return (
    <React.Suspense fallback={null}>
      <ForcedChange />
    </React.Suspense>
  );
}

function ForcedChange() {
  const next = safeNextPath(useSearchParams().get("next"));
  return (
    <div className="space-y-4">
      {/* Hard navigation: the browser's cached identity (and R-161's in-memory token) is
          rebuilt, so the shell does not see the old flag and bounce back here. */}
      <ChangePasswordCard forced onChanged={() => { window.location.href = next; }} />
      <form action="/auth/sign-out" method="post" className="text-center">
        <button type="submit" className="text-sm text-ink-3 hover:underline">Sign out</button>
      </form>
    </div>
  );
}
