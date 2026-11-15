/**
 * R-2758 (R-2738): a fact on the row's stage chip (at risk, vendor hold, previous term unpaid, promise
 * broken, follow-up due, renewal held) — a small icon after the chip, never a second chip.
 * R-2823 (Renewals audit 14 Nov): the vendor hold is not only a lock — it reads "Hold at Google — unpaid"
 * next to the icon (flag.words); the others stay icons with their reason as name + title.
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { FlagKey, StageFlag } from "@/lib/renewals/stage";

const FLAG_ICON: Record<FlagKey, React.ComponentProps<typeof Icon>["name"]> = {
  atRisk: "alert", vendorHold: "lock", priorTermUnpaid: "rupee", promiseBroken: "x_circle", followUpDue: "phone",
  renewalHeld: "clock",
};

export function StageFlagIcon({ flag }: { flag: StageFlag }) {
  if (flag.words) {
    /* words: rose-700 on rose-50 (small text needs 4.5:1; rose-600 is ~4.2). Wraps inside the narrow Status
       column at 1280 (nowrap ran over the Last invoice column). */
    return (
      <span role="img" aria-label={`${flag.words}: ${flag.reason}`} title={flag.reason} data-flag={flag.key}
        className="inline-flex min-h-5 max-w-full items-start gap-1 rounded-xl bg-rose-50 px-1.5 py-0.5 text-left text-2xs font-medium leading-tight text-rose-700">
        <Icon name={FLAG_ICON[flag.key]} size={11} className="mt-px shrink-0" aria-hidden />
        {flag.words}
      </span>
    );
  }
  return (
    <span role="img" aria-label={flag.reason} title={flag.reason} data-flag={flag.key}
      className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full", flag.key === "followUpDue" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-600")}>
      <Icon name={FLAG_ICON[flag.key]} size={11} />
    </span>
  );
}
