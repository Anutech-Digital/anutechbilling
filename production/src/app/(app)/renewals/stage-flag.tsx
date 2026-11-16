/**
 * R-2758 (R-2738): a fact on the row's stage chip (at risk, vendor hold, previous term unpaid, promise
 * broken, follow-up due, renewal held) — after the chip, never a second chip.
 * R-2823 (Renewals audit 14 Nov): the vendor hold is not only a lock — it reads "Hold at Google — unpaid"
 * next to the icon (flag.words).
 * R-2854 (Chrome human test 16 Nov: "an icon-only warning pill sits between two status chips with no words"):
 * EVERY flag reads in words (flagWords) — no icon-only pill — and a row shows ONE flag line under its chip
 * (StageFlagLine): the first flag in words, "+N more" when there are more (each reason is in the tooltip
 * and the accessible name).
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { FlagKey, StageFlag } from "@/lib/renewals/stage";

const FLAG_ICON: Record<FlagKey, React.ComponentProps<typeof Icon>["name"]> = {
  atRisk: "alert", vendorHold: "lock", priorTermUnpaid: "rupee", promiseBroken: "x_circle", followUpDue: "phone",
  renewalHeld: "clock",
};

/** R-2854: what each flag warns about, in two or three plain words (the full reason stays the tooltip). */
const FLAG_WORDS: Record<FlagKey, string> = {
  atRisk: "At risk", vendorHold: "On hold — unpaid", priorTermUnpaid: "Previous term unpaid", promiseBroken: "Promise broken",
  followUpDue: "Follow-up due", renewalHeld: "Renewal on hold",
};

export function flagWords(flag: StageFlag): string {
  return flag.words ?? FLAG_WORDS[flag.key];
}

const named = (f: StageFlag) => (f.reason.startsWith(flagWords(f)) ? f.reason : `${flagWords(f)}: ${f.reason}`);

/** One flag in plain words after its icon — coloured text, no pill (the rose-ink / amber-ink tokens on the row's own
    background: small text needs 4.5:1, in both themes). Inline, so it wraps like a sentence inside a narrow Status column. */
export function StageFlagIcon({ flag }: { flag: StageFlag }) {
  return (
    <span role="img" aria-label={named(flag)} title={flag.reason} data-flag={flag.key}
      className={cn("text-2xs font-medium", flag.key === "followUpDue" ? "text-amber-ink" : "text-rose-ink")}>
      <Icon name={FLAG_ICON[flag.key]} size={11} className="mr-1 inline-block align-[-1px]" aria-hidden />
      {flagWords(flag)}
    </span>
  );
}

/** Which flag the row names first: what stops the renewal (a hold), then money, then the softer signals. */
const FLAG_ORDER: readonly FlagKey[] = ["renewalHeld", "vendorHold", "priorTermUnpaid", "promiseBroken", "followUpDue", "atRisk"];

/** R-2854: the row's ONE flag line — the most pressing flag in words; the others as "+N" (their words + reasons: tooltip + name).
    `all` (the card layout — room, and no hover on a phone): every flag in words, no "+N". */
export function StageFlagLine({ flags: given, all = false }: { flags: readonly StageFlag[]; all?: boolean }) {
  if (!given.length) return null;
  const flags = [...given].sort((a, b) => FLAG_ORDER.indexOf(a.key) - FLAG_ORDER.indexOf(b.key));
  if (all) {
    return (
      <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-2xs leading-4" data-testid="stage-flags">
        {flags.map((f) => <StageFlagIcon key={f.key} flag={f} />)}
      </p>
    );
  }
  const rest = flags.slice(1);
  const restWords = rest.map(named).join("; ");
  return (
    <p className="min-w-0 break-words text-2xs leading-4" data-testid="stage-flags">
      <StageFlagIcon flag={flags[0]} />
      {rest.length > 0 && (
        <>
          {" "}
          <span role="img" aria-label={`${rest.length} more: ${restWords}`} title={restWords} className="whitespace-nowrap text-2xs text-ink-2" data-testid="stage-flags-more">
            +{rest.length}
          </span>
        </>
      )}
    </p>
  );
}
