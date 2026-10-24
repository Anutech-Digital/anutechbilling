"use client";

/**
 * R-1796 — "Payment due — vendor renewal on hold" badge + the owner/manager "Renew anyway"
 * button. One component for the Renewals list and the subscription drawer, so the two never
 * say different things. The rule is lib/renewals/vendor-hold.ts (derived, nothing stored).
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAskText } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import {
  VENDOR_HOLD_LABEL,
  VENDOR_HOLD_OVERRIDDEN,
  VENDOR_HOLD_TITLE,
  canRenewAnyway,
  renewAnywayPrompt,
  renewedAnywayToast,
  vendorHoldState,
  type VendorHoldInput,
} from "@/lib/renewals/vendor-hold";

/* renew_anyway is newer than the generated types (database.types.ts is shared). */
type RenewAnywayRpc = (
  fn: "renew_anyway",
  args: { p_subscription_id: string; p_reason: string },
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface VendorHoldSub extends VendorHoldInput {
  id:            string;
  customer_name: string;
  plan:          string | null;
}

export function VendorHoldBadge({ sub, size = "sm" }: { sub: VendorHoldSub; size?: "sm" | "md" }) {
  const state = vendorHoldState(sub);
  const { data: me } = useCurrentUser();
  const askText = useAskText();
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);

  if (state === "none") return null;
  if (state === "overridden") {
    return (
      <p className="text-2xs text-ink-3" data-testid="vendor-hold-overridden">
        {VENDOR_HOLD_OVERRIDDEN}
      </p>
    );
  }

  const allowed = canRenewAnyway(me?.role);

  async function onRenewAnyway() {
    const p = renewAnywayPrompt(sub);
    const reason = await askText({ title: p.title, body: p.body, label: p.label, placeholder: p.placeholder, confirmLabel: "Renew anyway", icon: "refresh" });
    if (!reason) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as RenewAnywayRpc;
      const { error } = await rpc.call(supabase, "renew_anyway", { p_subscription_id: sub.id, p_reason: reason });
      if (error) throw error;
      const t = renewedAnywayToast(sub);
      toast.success(t.title, { description: t.description });
      await qc.invalidateQueries({ queryKey: ["subscriptions"] });
    } catch (err) {
      toastError(err, {
        fallback: "Could not remove the hold.",
        description: "Refresh the page and try again. If it says only the owner or a manager can do this, ask one of them.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="vendor-hold">
      <Badge kind="warning" size={size} dot title={VENDOR_HOLD_TITLE}>
        {VENDOR_HOLD_LABEL}
      </Badge>
      {allowed ? (
        <Button variant="ghost" size="sm" loading={busy} onClick={onRenewAnyway}
          title="Owner / manager: remove the hold for this term (reason goes to the activity log)">
          Renew anyway
        </Button>
      ) : (
        <span className="text-2xs text-ink-3">Owner or manager can renew before payment</span>
      )}
    </div>
  );
}
