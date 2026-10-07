/**
 * Channel efficiency, CAC and ROAS — computed only as far as the data allows.
 *
 * ─── THE NUMBER THIS MODULE REFUSES TO PRINT ─────────────────────────────────
 * Measured against production 13 Aug 2026, tenant fbb976f1:
 *
 *     total recorded marketing spend  ₹4,000   (one Facebook expense, 9 Aug)
 *     won lead value                  ₹66,64,199
 *
 * Naively that is a ROAS of about 1,650×. That figure is not impressive, it is
 * meaningless: it says nothing about the ads and everything about the fact that
 * spend is not being recorded. A dashboard that renders it invites a real
 * decision — "pour money into Facebook" — on the back of one ₹4,000 row.
 *
 * So CAC and ROAS come back as **null with a stated reason** whenever the spend
 * behind them is absent or too small to support the conclusion. A blank with an
 * explanation is a usable answer. A confident wrong multiple is not.
 *
 * ─── WHY SOME "SOURCES" ARE NOT CHANNELS ─────────────────────────────────────
 * `leads.source` mixes marketing channels with data-entry provenance:
 *
 *     whatsapp · referral · tele-calling · email-inbound ·
 *     buy-workspace-v2 · enquiry-form        ← channels a lead ARRIVED through
 *     manual · csv · import                  ← how a human typed it in
 *
 * 16 of 61 leads are `manual` or `csv`. Ranking those alongside real channels
 * would put "manual" second by won value and imply it as a channel to invest in.
 * They are reported separately as unattributed instead of being dropped, because
 * the SIZE of the unattributed bucket is itself the most useful number here — it
 * is the share of the pipeline whose origin nobody knows.
 */

/** Sources that describe data entry, not a marketing channel. */
const NON_CHANNEL_SOURCES: ReadonlySet<string> = new Set([
  "manual", "csv", "import", "seed", "migration", "unknown", "",
]);

/** Minimum won deals before a per-channel win rate is worth quoting. */
export const MIN_SAMPLE_FOR_RATE = 5;

/**
 * Spend must cover at least this share of a channel's won value before ROAS is
 * reported. At 1% coverage the multiple is arithmetic, not evidence.
 */
export const MIN_SPEND_COVERAGE = 0.02;

export interface ChannelLeadInput {
  source: string | null | undefined;
  /** `leads.stage` — 'won' and 'lost' are terminal; anything else is open. */
  stage: string | null | undefined;
  /** Deal value in rupees. */
  value: number | null | undefined;
  /**
   * R-375: a payment is recorded against this lead (lib/payments/won-paid.ts). accept_quote sets
   * stage 'won' on acceptance, before any money — so a won lead's value is won REVENUE (and
   * feeds ROAS) only when this is true. Absent / false = accepted, not paid: still a won deal
   * for the win rate, but ₹0 of won value.
   */
  paid?: boolean;
}

export interface ChannelSpendInput {
  /** Channel key, matched case-insensitively against normalised lead sources. */
  channel: string;
  rupees: number;
}

export type Confidence = "no_spend_data" | "spend_too_small" | "usable";

export interface ChannelStat {
  channel: string;
  /** false for `manual`/`csv` and friends — reported, never ranked. */
  attributable: boolean;
  leads: number;
  won: number;
  lost: number;
  open: number;
  /** 0…1, or null when the sample is too small to quote. */
  winRate: number | null;
  wonValue: number;
  /** Rupees per won deal, or null when nothing has been won. */
  avgDealSize: number | null;
  /** Rupees of recorded spend, or null when none is attributed to this channel. */
  spend: number | null;
  /** Spend per won deal. Null unless spend is known AND something was won. */
  cac: number | null;
  /** wonValue / spend. Null unless the spend behind it can support the claim. */
  roas: number | null;
  /** LTV:CAC, when both an LTV estimate and a CAC are available. */
  ltvToCac: number | null;
  confidence: Confidence;
  /**
   * Every reason a metric on this row is missing or unsafe — ALL of them.
   *
   * This was a single string first, and the first test to exercise a channel
   * with two problems at once (no spend AND too few closed deals) caught it:
   * only one reason survived, so the screen would have explained the missing
   * ROAS while silently hiding that the win rate was unquotable too. Half an
   * explanation is worse than none, because the reader thinks they have it all.
   */
  notes: string[];
}

export interface ChannelReport {
  /** Real channels, best first. */
  channels: ChannelStat[];
  /** `manual`, `csv` and friends — shown separately, never ranked. */
  unattributed: ChannelStat[];
  totals: {
    leads: number;
    won: number;
    wonValue: number;
    spend: number;
    /** Share of leads whose origin is data entry rather than a channel. */
    unattributedShare: number;
  };
  /** Portfolio-level ROAS, or null with a reason. */
  blendedRoas: number | null;
  /** Why a portfolio figure is missing or unsafe. */
  blendedNote: string | null;
}

function normalise(source: string | null | undefined): string {
  return (source ?? "").toString().trim().toLowerCase();
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Build the channel report.
 *
 * @param leads Lead rows for the period.
 * @param spend Recorded marketing spend, already attributed to channels.
 * @param ltvPerCustomer Optional LTV estimate (the /accounting/saas-metrics page
 *        already computes one as ARPC ÷ monthly churn). Omit and `ltvToCac`
 *        stays null rather than being invented.
 */
export function channelReport(
  leads: ChannelLeadInput[],
  spend: ChannelSpendInput[] = [],
  ltvPerCustomer?: number | null,
): ChannelReport {
  const spendByChannel = new Map<string, number>();
  for (const s of spend) {
    const k = normalise(s.channel);
    if (!k) continue;
    const r = num(s.rupees);
    if (r <= 0) continue;                    // a refund or a zero is not spend
    spendByChannel.set(k, (spendByChannel.get(k) ?? 0) + r);
  }

  interface Bucket { leads: number; won: number; lost: number; wonValue: number }
  const buckets = new Map<string, Bucket>();

  for (const l of leads) {
    const key = normalise(l.source) || "unknown";
    const b = buckets.get(key) ?? { leads: 0, won: 0, lost: 0, wonValue: 0 };
    b.leads++;
    const stage = normalise(l.stage);
    if (stage === "won") { b.won++; if (l.paid === true) b.wonValue += Math.max(0, num(l.value)); }
    else if (stage === "lost") { b.lost++; }
    buckets.set(key, b);
  }

  const build = (channel: string, b: Bucket): ChannelStat => {
    const attributable = !NON_CHANNEL_SOURCES.has(channel);
    const open = b.leads - b.won - b.lost;
    const closed = b.won + b.lost;
    const spendR = spendByChannel.has(channel) ? spendByChannel.get(channel)! : null;

    // Win rate needs a denominator of CLOSED deals — dividing by all leads
    // punishes a channel simply for having a full pipeline.
    const winRate = closed >= MIN_SAMPLE_FOR_RATE ? b.won / closed : null;
    const avgDealSize = b.won > 0 ? Math.round(b.wonValue / b.won) : null;

    let confidence: Confidence = "usable";
    const notes: string[] = [];
    let cac: number | null = null;
    let roas: number | null = null;

    if (spendR === null) {
      confidence = "no_spend_data";
      notes.push("No marketing spend is recorded against this channel, so CAC and ROAS cannot be computed.");
    } else if (b.wonValue > 0 && spendR / b.wonValue < MIN_SPEND_COVERAGE) {
      // The 1,650× case. Arithmetic, not evidence.
      confidence = "spend_too_small";
      notes.push(
        `Recorded spend (₹${spendR.toLocaleString("en-IN")}) is under ` +
        `${Math.round(MIN_SPEND_COVERAGE * 100)}% of won value, so a ROAS figure would ` +
        `reflect missing spend data rather than performance.`
      );
      cac = b.won > 0 ? Math.round(spendR / b.won) : null;
    } else {
      cac = b.won > 0 ? Math.round(spendR / b.won) : null;
      roas = spendR > 0 ? b.wonValue / spendR : null;
      if (b.won === 0) {
        notes.push("Spend recorded but nothing won yet — CAC is undefined until a deal closes.");
      }
    }

    const ltvToCac =
      cac !== null && cac > 0 && typeof ltvPerCustomer === "number" && Number.isFinite(ltvPerCustomer)
        ? ltvPerCustomer / cac
        : null;

    // Appended unconditionally, NOT only when there is no other note — a
    // channel can be short of both spend data and closed deals at the same time,
    // and the reader needs to know about both.
    if (winRate === null) {
      notes.push(`Only ${closed} closed ${closed === 1 ? "deal" : "deals"} — too few to quote a win rate.`);
    }

    return {
      channel, attributable,
      leads: b.leads, won: b.won, lost: b.lost, open,
      winRate, wonValue: b.wonValue, avgDealSize,
      spend: spendR, cac, roas, ltvToCac, confidence, notes,
    };
  };

  const all = [...buckets.entries()].map(([k, b]) => build(k, b));

  // Rank by won value, then by won count, then name — a stable order, because a
  // leaderboard that reshuffles between renders reads as broken.
  const rank = (a: ChannelStat, b: ChannelStat) =>
    b.wonValue - a.wonValue || b.won - a.won || a.channel.localeCompare(b.channel);

  const channels = all.filter((c) => c.attributable).sort(rank);
  const unattributed = all.filter((c) => !c.attributable).sort(rank);

  const totalLeads = all.reduce((s, c) => s + c.leads, 0);
  const totalWon = all.reduce((s, c) => s + c.won, 0);
  const totalWonValue = all.reduce((s, c) => s + c.wonValue, 0);
  const totalSpend = [...spendByChannel.values()].reduce((s, r) => s + r, 0);
  const unattributedLeads = unattributed.reduce((s, c) => s + c.leads, 0);

  let blendedRoas: number | null = null;
  let blendedNote: string | null = null;

  if (totalSpend <= 0) {
    blendedNote = "No marketing spend recorded, so return on ad spend cannot be computed.";
  } else if (totalWonValue > 0 && totalSpend / totalWonValue < MIN_SPEND_COVERAGE) {
    blendedNote =
      `Recorded spend (₹${totalSpend.toLocaleString("en-IN")}) covers under ` +
      `${Math.round(MIN_SPEND_COVERAGE * 100)}% of won value (₹${totalWonValue.toLocaleString("en-IN")}). ` +
      `A blended ROAS here would measure the gap in the records, not the marketing.`;
  } else {
    blendedRoas = totalWonValue / totalSpend;
  }

  return {
    channels,
    unattributed,
    totals: {
      leads: totalLeads,
      won: totalWon,
      wonValue: totalWonValue,
      spend: totalSpend,
      unattributedShare: totalLeads > 0 ? unattributedLeads / totalLeads : 0,
    },
    blendedRoas,
    blendedNote,
  };
}

// ─── Action recommendations ─────────────────────────────────────────────────

export type Action =
  | "scale"          // ROAS is strong and measured — put more in
  | "optimise"       // returns positive but unremarkable
  | "cut"            // spending more than it returns
  | "review"         // spending with nothing to show yet
  | "track_spend"    // cannot advise: spend is not recorded
  | "not_a_channel"; // data-entry provenance, not marketing

export interface Recommendation {
  action: Action;
  label: string;
  /** Why, in one sentence, for the cell's tooltip. */
  reason: string;
}

/** ROAS at or above this is worth scaling. */
export const SCALE_ROAS = 4;

/**
 * What to do about a channel.
 *
 * THE SAFETY PROPERTY, and it has a test: this never returns `scale` or `cut`
 * unless `roas` is non-null — that is, unless the spend behind it was large
 * enough for `channelReport` to consider the figure trustworthy. "Cut spend" on
 * an unmeasured channel would kill the best-performing one in this workspace
 * (WhatsApp: 18 wins, ₹29L, no spend recorded), and "Scale budget" on a ₹4,000
 * row would move real money on arithmetic rather than evidence.
 */
export function recommendationFor(c: Pick<ChannelStat, "attributable" | "roas" | "spend" | "won" | "wonValue">): Recommendation {
  if (!c.attributable) {
    return {
      action: "not_a_channel",
      label: "Not a channel",
      reason: "This is how the lead was entered, not where it came from — there is no budget to change.",
    };
  }

  if (c.roas === null) {
    return {
      action: "track_spend",
      label: "Track spend",
      reason: c.spend === null
        ? "No spend is recorded against this channel, so no budget advice is possible — tag its marketing expenses first."
        : "Recorded spend is too small a share of won value to support a recommendation.",
    };
  }

  if (c.won === 0) {
    return {
      action: "review",
      label: "Review targeting",
      reason: "Spend is recorded but nothing has closed yet — look at targeting and follow-up before changing budget.",
    };
  }

  if (c.roas < 1) {
    return {
      action: "cut",
      label: "Cut spend",
      reason: `Returning ₹${c.roas.toFixed(2)} for every ₹1 spent — it is losing money at this level.`,
    };
  }

  if (c.roas >= SCALE_ROAS) {
    return {
      action: "scale",
      label: "Scale budget",
      reason: `Returning ₹${c.roas.toFixed(2)} per ₹1 spent on measured spend — the strongest case for more budget.`,
    };
  }

  return {
    action: "optimise",
    label: "Optimise",
    reason: `Returning ₹${c.roas.toFixed(2)} per ₹1 — positive, but below the ${SCALE_ROAS}× bar for scaling.`,
  };
}
