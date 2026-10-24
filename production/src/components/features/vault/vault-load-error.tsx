/**
 * What the private vault shows when its data will not load.
 *
 * ─── WHY THIS EXISTS: THE ERROR MESSAGE MISLED ITS OWN AUTHOR ───────────────
 * All four vault screens had the same hand-rolled branch:
 *
 *     {error instanceof Error ? error.message : "Unknown error."}
 *
 * A Supabase `PostgrestError` is a plain object, not an `Error`, so that test is
 * **always false** and the real message was always thrown away. The index screen then
 * added a guess underneath — "if it says the table is missing, the migration is not
 * applied" — and when the vault was opened for the first time in a browser, it rendered:
 *
 *     Vault load nahi hua
 *     Unknown error.
 *     Agar likha hai ki table nahi mila, to migration ... abhi lagi nahi hai.
 *
 * The actual cause was a 401: an expired session. The screen sent the person reading it
 * off to check a migration that was fine. That is worse than saying nothing — a wrong
 * next step costs more than a missing one, which is the whole point of CLAUDE.md §24.
 *
 * ─── SO IT USES THE SHARED HELPER ───────────────────────────────────────────
 * `lib/errors/toast-error.ts` already knows how to read a PostgrestError and already
 * recognises expired sessions, RLS refusals, missing relations and network failures —
 * with tests. The UX audit's G1 finding is precisely this: 452 sites hand-rolling error
 * text instead of using it. Four fewer now.
 */
"use client";

import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { describeError } from "@/lib/errors/toast-error";

export function VaultLoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const d = describeError(error);

  /* ─── WHY AN RLS REFUSAL COUNTS AS "SIGN IN AGAIN" *ON THIS SCREEN* ────────
     Everything else is "try again"; an expired session cannot be retried into working.

     The subtle one is a permission / row-level-security refusal. The shared helper maps
     that to "It belongs to another workspace, or your role doesn't allow it. Ask the
     owner to give you access." — correct almost everywhere, and wrong here, because the
     person reading it IS the owner: the layout already refused every non-owner before
     this component could render.

     On these four tables the policy is `owner_user_id = auth.uid()`. You cannot be
     refused your OWN rows by a role — only by having no `auth.uid()` at all. So a
     refusal here means the session is gone, and it was: observed live on 19 Aug 2026 as
     a wall of 401s after the dev server moved to a different port (Supabase keeps its
     session in localStorage, which is per-origin, port included).

     Telling an owner to "ask the owner for access" is exactly the wrong-next-step this
     component was written to stop. */
  const sessionGone =
    /session expired/i.test(d.message) || /don't have access|permission denied|row-level security/i.test(d.message + " " + d.raw);

  return (
    <Card className="p-6">
      <EmptyState
        icon="alert"
        title={sessionGone ? "Your session has expired" : d.message}
        body={
          sessionGone
            ? "The vault opens only with your own login. Sign in again — nothing has been lost."
            : d.description
        }
        action={
          sessionGone ? (
            <Button asChild variant="primary" icon="logout">
              <Link href="/login">Sign in again</Link>
            </Button>
          ) : onRetry ? (
            <Button variant="primary" icon="refresh" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}
