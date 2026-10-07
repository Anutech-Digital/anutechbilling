"use client";

/**
 * R-391: the app shell's second line of the forced password change.
 *
 * The middleware redirects on the server when it can see the flag (GoTrue — live). On R-161's
 * Auth.js session (staging) the middleware's user carries no app_metadata, but the browser's
 * `auth.getUser()` does on both paths, so useCurrentUser reports it and this sends the member
 * to /change-password. Renders nothing.
 */
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { changePasswordUrl } from "@/lib/auth/must-change-password";

export function MustChangePasswordGate() {
  const { data: me } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (!me?.mustChangePassword) return;
    const search = typeof window === "undefined" ? "" : window.location.search;
    router.replace(changePasswordUrl(`${pathname ?? ""}${search}`));
  }, [me?.mustChangePassword, pathname, router]);

  return null;
}
