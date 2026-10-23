/**
 * One cold-calling campaign — /marketing/cold-calling/[id] (R-1663)
 *
 * Live status (who is on the line, how far, why it is waiting), the three steps, the numbers with
 * their results, and the call log by day.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useColdCampaigns, useDeleteCampaign } from "@/lib/queries/cold-calling";
import { CampaignPanel, failToast, total } from "@/components/features/coldcall/cold-call-ui";

export default function ColdCallCampaignPage() {
  const { id } = useParams<{ id: string }>();
  const campaigns = useColdCampaigns();
  const campaign = (campaigns.data ?? []).find((c) => c.id === id) ?? null;
  const router = useRouter();
  const del = useDeleteCampaign();
  const [asking, setAsking] = React.useState(false);

  const doDelete = async () => {
    if (!campaign) return;
    try {
      await del.mutateAsync(campaign.id);
      toast.success("Campaign deleted", { description: "Leads it already sent to Sales & Pipeline stay there." });
      router.push("/marketing/cold-calling");
    } catch (err) {
      failToast(err, "Could not delete the campaign.");
      setAsking(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link href="/marketing/cold-calling" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
          <Icon name="arrow_left" size={14} /> All campaigns
        </Link>
        {campaign && (
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setAsking(true)}>Delete campaign</Button>
        )}
      </div>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{campaign?.name}”?</DialogTitle>
            <DialogDescription>
              Its list of {campaign ? total(campaign) : 0} numbers and their call results are removed for good.
              Leads it already sent to Sales &amp; Pipeline stay there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>Keep it</Button>
            <Button variant="danger" icon="trash" onClick={doDelete} loading={del.isPending}>Delete campaign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
