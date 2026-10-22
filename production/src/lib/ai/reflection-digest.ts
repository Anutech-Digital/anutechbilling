/**
 * Turning a night's reflection into a mail somebody will actually read — or into nothing.
 *
 * ─── WHY IT IS NOT PART OF THE HEALTH DIGEST ────────────────────────────────
 * That was the obvious place, and it is the wrong one. `api/cron/health-digest` returns
 * early on `digest.clean` and sends NO mail when nothing is broken — deliberately, so that
 * an arriving mail always means something needs attention. Bolting a daily learning note
 * onto it would either break that contract or deliver the note only on bad days, which are
 * exactly the days nobody wants to also read a summary.
 *
 * So the reflection speaks for itself, under the same rule: silence means nothing to say.
 *
 * ─── AND SILENCE IS THE COMMON CASE, ON PURPOSE ─────────────────────────────
 * `reflect()` withholds any ranking below 25 leads, because a "top objection" drawn from
 * three people is three people. Measured 30 Aug 2026 on live data: ANUTECH had 3 leads with
 * a customer message in 24 hours. So for now this returns null most mornings, and that is
 * the module working, not failing.
 *
 * ─── BUT `topBlock` SPEAKS BELOW THE FLOOR, AND THAT IS THE POINT ───────────
 * A ranking needs a sample. "What stopped the agent most often last night" does not — it is
 * a count of the app's own refusals, not an inference about customers. On 30 Aug the answer
 * would have been the promise guard holding a correct reply over the word "discount", and
 * that took three deploys and a hand-written SQL query to find. It should have arrived by
 * email the next morning.
 */

export interface ReflectionReport {
  tenantId: string;
  tenantName?: string | null;
  leadsSeen: number;
  /** Worst objection, or null when the sample floor withheld the ranking. */
  topStall: string | null;
  stalledCount?: number | null;
  /** The commonest thing that stopped the agent. Speaks below the sample floor. */
  topBlock?: { reason: string; count: number } | null;
  /** Seat bands that accepted, if any. */
  acceptedByBand?: readonly { band: string; accepted: number }[];
  /** Why a ranking is withheld. Empty when there is one. */
  withheld: string;
}

export interface ReflectionEmail {
  subject: string;
  text: string;
}

/** Does this tenant have anything worth an email? */
function worthSending(r: ReflectionReport): boolean {
  return Boolean(r.topStall) || Boolean(r.topBlock) || (r.acceptedByBand?.length ?? 0) > 0;
}

const who = (r: ReflectionReport): string => r.tenantName?.trim() || r.tenantId.slice(0, 8);

/**
 * The morning note, or null when there is nothing to say.
 *
 * `null` is not a failure path and callers must not turn it into an empty mail. A summary
 * that arrives every day whether or not it found anything becomes wallpaper within a week,
 * and then the morning it matters it is deleted with the rest.
 */
export function reflectionEmail(
  reports: readonly ReflectionReport[],
  windowHours = 24,
): ReflectionEmail | null {
  const speaking = reports.filter(worthSending);
  if (speaking.length === 0) return null;

  const lines: string[] = [
    `What the app learned in the last ${windowHours} hours.`,
    "",
  ];

  for (const r of speaking) {
    lines.push(`── ${who(r)} ──`);
    lines.push(`${r.leadsSeen} leads got a message from the customer.`);

    if (r.topStall) {
      lines.push(
        `Biggest blocker: ${r.topStall}` +
          (r.stalledCount ? ` — ${r.stalledCount} leads stuck on it.` : "."),
      );
    } else if (r.withheld) {
      /* The floor's own sentence, not a paraphrase — it explains itself better than a
         summary of it would, and a reader who sees it twice learns the rule. */
      lines.push(`Ranking withheld: ${r.withheld}`);
    }

    if (r.topBlock) {
      lines.push(
        `What blocked the AI most often (${r.topBlock.count} times):`,
        `  ${r.topBlock.reason}`,
      );
    }

    const accepted = r.acceptedByBand ?? [];
    if (accepted.length > 0) {
      lines.push(
        "Seat bands where customers said yes: " +
          accepted.map((a) => `${a.band} (${a.accepted})`).join(", "),
      );
    }
    lines.push("");
  }

  lines.push(
    "This note is only a count — no model ran, and it is not written into any prompt.",
    "On a day with nothing worth saying, this mail is not sent.",
  );

  /* The subject carries the finding, because a subject that says "Daily reflection" makes
     the reader open the mail to learn whether it was worth opening. */
  const first = speaking[0];
  const headline = first.topStall
    ? `biggest blocker: ${first.topStall}`
    : first.topBlock
      ? `AI was blocked: ${first.topBlock.reason}`
      : "customers said yes in some seat bands";

  return {
    subject: `ResellerOS — ${headline.slice(0, 70)}`,
    text: lines.join("\n"),
  };
}
