"use client";

/**
 * R-281: "Local test login" — one button per seeded E2E test role, on localhost only.
 *
 * The button sends just the role to POST /api/dev/test-login; the server holds the test
 * account's password (never this file, never the browser) and answers 404 anywhere but
 * `npm run dev:local` on localhost. Never a real person's account.
 */
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TEST_LOGIN_ROLES, type TestLoginRole } from "@/app/api/dev/test-login/rules";

const LABEL: Record<TestLoginRole, string> = {
  owner: "Owner",
  manager: "Manager",
  accountant: "Accountant",
  sales: "Sales",
};

/** Build-time gate (dev:local sets NEXT_PUBLIC_APP_ENV=local) plus the page's own host. */
export function localTestLoginVisible(
  appEnv: string | undefined,
  nodeEnv: string | undefined,
  hostname: string | undefined,
): boolean {
  return appEnv === "local" && nodeEnv !== "production"
    && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
}

export function LocalTestLogin({ nextPath }: { nextPath: string }) {
  const [visible, setVisible] = React.useState(false);
  const [busy, setBusy] = React.useState<TestLoginRole | null>(null);

  /* Host is only known in the browser — checked after mount so SSR and client agree. */
  React.useEffect(() => {
    setVisible(localTestLoginVisible(process.env.NEXT_PUBLIC_APP_ENV, process.env.NODE_ENV, window.location.hostname));
  }, []);

  if (!visible) return null;

  async function signIn(role: TestLoginRole) {
    setBusy(role);
    try {
      const res = await fetch("/api/dev/test-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(out.error ?? `Test login failed (${res.status})`);
        return;
      }
      /* Hard navigation, as the password form does, so the new session cookie is sent. */
      window.location.href = nextPath;
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="local-test-login-title"
      className="mb-5 rounded-md border border-dashed border-hairline bg-paper-2 p-3"
      data-local-test-login
    >
      <h2 id="local-test-login-title" className="mb-1 text-xs font-semibold text-ink">
        Local test login
      </h2>
      <p className="mb-2 text-xs text-ink-3">Seeded test accounts. Localhost only.</p>
      <div className="grid grid-cols-2 gap-2">
        {TEST_LOGIN_ROLES.map((role) => (
          <Button
            key={role}
            type="button"
            size="sm"
            className="justify-center"
            loading={busy === role}
            disabled={busy !== null}
            onClick={() => void signIn(role)}
          >
            {LABEL[role]}
          </Button>
        ))}
      </div>
    </section>
  );
}
