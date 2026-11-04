/**
 * Hosting & Domains — the way into the DMS engine.
 *
 * Hosting and domains are run by a separate application (DMS, app.anutech.in):
 * it holds the ResellerClub and DirectAdmin credentials, registers the domains,
 * creates the hosting accounts, and has its own admin panel and customer portal.
 * None of that is moving here. This page is the door.
 *
 * ─── WHY A PAGE AND NOT JUST A SIDEBAR LINK ──────────────────────────────────
 * `NavItem.external` would have given us a one-line link straight to DMS. It was
 * not enough: a bare link tells you nothing until you have already clicked it
 * and waited. When somebody opens this because a customer's hosting is broken,
 * the first question is whether the engine is even up — so the page answers that
 * before offering the link, and distinguishes the three failures that otherwise
 * look identical from here: not configured, wrong key, unreachable.
 *
 * The link is still offered when the engine is down, deliberately: someone
 * investigating a broken app should not be stopped by the page that reports it
 * as broken.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelAccountsCard } from "@/components/features/panel-accounts/panel-accounts-card";

interface DmsStatus {
  configured: boolean;
  reachable: boolean;
  reason?: "not_configured" | "unauthorized" | "unreachable" | "bad_response";
  contractVersion?: number;
  database?: boolean;
  capabilities?: { resellerclub: boolean; directadmin: boolean };
  panelUrls: { admin: string | null; customer: string | null };
}

function useDmsStatus() {
  return useQuery<DmsStatus>({
    queryKey: ["dms", "status"],
    queryFn: async () => {
      const res = await fetch("/api/dms/status");
      if (!res.ok) throw new Error(`Status check failed (HTTP ${res.status})`);
      return res.json();
    },
    // The engine's reachability is exactly the kind of thing that changes while
    // you are looking at it, and this page is opened BECAUSE something might be
    // wrong. A stale "reachable" here sends someone down the wrong path.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** Plain-language explanation of each failure, and what to do about it. */
function explainFailure(reason: DmsStatus["reason"]): { title: string; detail: string } {
  switch (reason) {
    case "not_configured":
      return {
        title: "Not connected yet",
        detail:
          "DMS_ENGINE_URL and DMS_ENGINE_READ_KEY are not set on this server, so nothing has been contacted. This is the expected state on a fresh checkout.",
      };
    case "unauthorized":
      return {
        title: "The engine rejected our key",
        detail:
          "DMS answered, so the address is right, but it did not accept DMS_ENGINE_READ_KEY. The key here and ENGINE_READ_API_KEY there have to match exactly.",
      };
    case "unreachable":
      return {
        title: "Could not reach the engine",
        detail:
          "No answer within 8 seconds. Either DMS is down, or DMS_ENGINE_URL points somewhere it is not listening.",
      };
    default:
      return {
        title: "The engine answered, but not with what we expected",
        detail:
          "DMS responded with an error status. Its own logs will say more than we can from here.",
      };
  }
}

export default function HostingDomainsPage() {
  const { data, isLoading, error, refetch, isFetching } = useDmsStatus();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-ink">Hosting &amp; Domains</h1>
        <p className="text-sm text-ink-3">
          Domains and hosting are run by the DMS engine, which has its own admin panel and
          customer portal. This page checks that it is up and takes you there.
        </p>
      </header>

      <Card title="Engine status" sub="app.anutech.in">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : error ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge kind="danger">Status unknown</Badge>
            </div>
            <p className="text-sm text-ink-3">
              This page could not complete its own status check — that is a fault here, not
              necessarily in DMS. {error instanceof Error ? error.message : null}
            </p>
          </div>
        ) : data?.reachable ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge kind="success">Reachable</Badge>
              {data.database === false && (
                <Badge kind="warning">Engine up, database down</Badge>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-ink-3">Domain registrar (ResellerClub)</dt>
                <dd className="text-ink">
                  {data.capabilities?.resellerclub ? "Configured" : "Not configured"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-ink-3">Hosting server (DirectAdmin)</dt>
                <dd className="text-ink">
                  {data.capabilities?.directadmin ? "Configured" : "Not configured"}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-ink-3">
              &ldquo;Configured&rdquo; means DMS holds the credentials to try. It is not proof
              that the upstream itself is answering — checking that costs a real API call
              against a third party that rate-limits us, so it is left to DMS&rsquo;s own
              integration-health screen, where a human has asked for it.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <Badge kind={data?.configured ? "danger" : "muted"}>
              {explainFailure(data?.reason).title}
            </Badge>
            <p className="text-sm text-ink-3">{explainFailure(data?.reason).detail}</p>
          </div>
        )}

        <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3">
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <Icon name="refresh" size={14} className="mr-1.5" />
            {isFetching ? "Checking…" : "Check again"}
          </Button>
        </div>
      </Card>

      <Card title="Open the engine" sub="These open in a new tab">
        <p className="mb-4 text-sm text-ink-3">
          You are signed in automatically, using the same email address you use here. If DMS
          has no account for that address it will ask you to sign in — it never creates one
          for you.
        </p>
        {/* Both go through /api/dms/sso rather than straight to DMS. That route
            reads the signed-in address from the session and mints a 60-second,
            single-use hand-off token, so the person arrives already signed in.
            It deliberately takes no email parameter — see the route's header.
            With no SSO secret configured it simply redirects to DMS's login
            page, so these buttons work either way. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="primary"
            disabled={!data?.panelUrls?.admin}
            onClick={() => {
              window.open("/api/dms/sso?next=admin", "_blank", "noopener,noreferrer");
            }}
          >
            <Icon name="settings" size={14} className="mr-1.5" />
            DMS admin panel
            <Icon name="external" size={12} className="ml-1.5 opacity-70" />
          </Button>
          <Button
            variant="outline"
            disabled={!data?.panelUrls?.customer}
            onClick={() => {
              window.open("/api/dms/sso?next=dashboard", "_blank", "noopener,noreferrer");
            }}
          >
            <Icon name="users" size={14} className="mr-1.5" />
            Customer portal
            <Icon name="external" size={12} className="ml-1.5 opacity-70" />
          </Button>
        </div>
        {!data?.panelUrls?.admin && !isLoading && (
          <p className="mt-3 text-xs text-ink-3">
            No address configured, so there is nowhere to send you. Set DMS_ENGINE_URL.
          </p>
        )}
      </Card>

      {/* R-2103: who has a customer panel login, who is stuck, and the go-live backfill. */}
      <PanelAccountsCard />
    </div>
  );
}
