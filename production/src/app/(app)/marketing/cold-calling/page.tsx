/**
 * Cold Calling — /marketing/cold-calling (R-1663)
 *
 * The campaigns, one card each with how far it got; clicking a card opens the campaign page
 * (/marketing/cold-calling/[id]) with live status, results and the call log. The AI voice agent
 * (Bolna) rings each list on a schedule; a person moves the interested ones into Sales & Pipeline
 * with a button — nothing enters the pipeline on its own (Abhishek, 19 Oct 2026).
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ColdCallError, useBolnaAgents, useColdCampaigns } from "@/lib/queries/cold-calling";
import { CampaignCard, NewCampaignForm } from "@/components/features/coldcall/cold-call-ui";

export default function ColdCallingPage() {
  const router = useRouter();
  const agents = useBolnaAgents();
  const campaigns = useColdCampaigns();
  const [creating, setCreating] = React.useState(false);

  const list = campaigns.data ?? [];
  const notConnected = agents.error instanceof ColdCallError && agents.error.status === 409 ? agents.error : null;

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing Hub</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Cold Calling</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Your AI agent calls a list of numbers for you. Open a campaign to see who is being called, the results and every call.
          </p>
        </div>
        {!notConnected && !creating && (
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New campaign</Button>
        )}
      </header>

      {notConnected && (
        <Card className="p-6">
          <EmptyState icon="phone" title={notConnected.message} body={notConnected.detail ?? undefined} />
        </Card>
      )}

      {creating && !notConnected && (
        <NewCampaignForm
          onDone={(id) => {
            setCreating(false);
            if (id) router.push(`/marketing/cold-calling/${id}` as Route);
          }}
          agents={agents.data?.agents ?? []}
          defaultAgentId={agents.data?.defaultAgentId ?? ""}
          loadingAgents={agents.isLoading}
        />
      )}

      {campaigns.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 rounded-lg" />)}
        </div>
      ) : list.length === 0 ? (
        !creating && !notConnected && (
          <Card className="p-6">
            <EmptyState
              icon="phone"
              title="No calling campaigns yet"
              body="A campaign is one list of numbers and one AI agent. Create one, add your numbers, and press Start."
              action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create your first campaign</Button>}
            />
          </Card>
        )
      ) : (
        <section aria-label="Campaigns" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => <CampaignCard key={c.id} campaign={c} />)}
        </section>
      )}
    </div>
  );
}
