/**
 * One cold-calling campaign — /marketing/cold-calling/[id] (R-1663)
 *
 * Live status (who is on the line, how far, why it is waiting), the three steps, the numbers with
 * their results, and the call log by day.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { useColdCampaigns } from "@/lib/queries/cold-calling";
import { CampaignPanel } from "@/components/features/coldcall/cold-call-ui";

export default function ColdCallCampaignPage() {
  const { id } = useParams<{ id: string }>();
  const campaigns = useColdCampaigns();
  const campaign = (campaigns.data ?? []).find((c) => c.id === id) ?? null;

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-4">
      <Link href="/marketing/cold-calling" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <Icon name="arrow_left" size={14} /> All campaigns
      </Link>
      {campaigns.isLoading ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : !campaign ? (
        <Card className="p-6">
          <EmptyState
            icon="phone"
            title="This campaign is not here"
            body="It may have been removed, or the link is wrong."
            action={<Button asChild variant="primary"><Link href="/marketing/cold-calling">See all campaigns</Link></Button>}
          />
        </Card>
      ) : (
        <CampaignPanel key={campaign.id} campaign={campaign} />
      )}
    </div>
  );
}
