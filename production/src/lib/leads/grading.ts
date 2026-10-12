/**
 * Grading an incoming lead, and deciding what happens to it next.
 *
 * ─── THE BRIEF HAS ONE GRADE BACKWARDS, AND IT IS THE COMMERCIALLY EXPENSIVE ONE ──
 * It asks for "Grade D: single personal Gmail ID, vague inquiry" — nurture loop, lowest
 * priority. Two independent signals are bundled into one grade there, and separating them
 * reverses half of it.
 *
 * WE SELL BUSINESS EMAIL. A company writing from `traders.test@gmail.com` has not bought what
 * we sell — the entire need is unmet, and there is no incumbent, no migration, and nobody else's
 * contract in the way. A company writing from `rahul@sharmatraders.in` ALREADY has business
 * email, from a competitor, and winning them means a switch: moving live mailboxes, unpicking a
 * renewal, and beating a supplier they have not left yet.
 *
 * CLAUDE.md §1 says who this platform is for — Indian cloud resellers selling to SMEs. The SME
 * whose owner runs the business off a free mailbox is the textbook prospect for a first
 * Workspace purchase. Grading them D and dropping them into a nurture loop deprioritises the
 * easiest sale in the pipeline.
 *
 * So a free mailbox is NOT a negative signal here. It is a DEAL-SHAPE signal: new purchase
 * rather than switch. What the brief was actually reaching for is the other half of its own
 * sentence — "vague inquiry" — and vagueness is a real negative signal on its own, whatever the
 * address it arrives from. The two are scored separately below.
 *
 * The address does say something about SIZE: a company large enough to have bought its own
 * domain is usually a bigger deal than one that has not. That is why `hasBusinessDomain` still
 * scores, just far less than the brief implied, and never below zero.
 *
 * ─── WHAT THE GRADE IS ALLOWED TO TOUCH ─────────────────────────────────────
 * ROUTING ONLY. NEVER THE PROMPT.
 *
 * A grade is our private opinion of how much a stranger is worth. It decides who gets a call and
 * who gets an email, and it never reaches `buildSalesAgentPrompt`, because a model told "this is
 * a Grade D lead" will write to them like one — and the customer will feel it. There is no
 * version of that leak that is recoverable, so the boundary is structural: this module exports a
 * route, not prompt lines, and nothing here is imported by sales-agent.ts.
 *
 * ─── AND THE A+ ACTIONS COLLIDE WITH RULES THAT ALREADY EXIST ───────────────
 * The brief pairs Grade A+ with "instant WhatsApp quote + AI telecalling within 10 seconds".
 * Measured against what is already built:
 *
 *   · A QUOTE NEEDS A TERM. Monthly and annual differ by twelve times. "25+ seats and high
 *     intent" says nothing about which, and `mergeQualification` will not price without it. So
 *     the A+ route is "quote if it is quotable, otherwise ask the one missing question" — which
 *     for a hot lead is the faster path anyway, because a wrong-term quote costs a re-quote.
 *
 *   · 51+ SEATS IS HELD FOR A PERSON. `REVIEW_ABOVE_SEATS` is 50: 51–100 seats are priced and
 *     drafted in full and then held. So a 60-seat A+ lead gets the REVIEW path, not the instant
 *     one — the highest grade legitimately gets the slowest route, because that is the band
 *     where the discount conversation is the deal.
 *
 *   · "WITHIN 10 SECONDS" CANNOT BE PROMISED OR DONE. `decideTelecall` obeys
 *     `quietHoursDecision`, `MIN_HOURS_BETWEEN_CALLS` (24) and `MAX_CALL_ATTEMPTS` (3), because
 *     TRAI's TCCCPR governs when a business may ring a stranger. An enquiry at 22:45 does not
 *     get a call at 22:45. This module marks a lead CALL-ELIGIBLE and lets `decideTelecall`
 *     choose the moment; it never carries a delay of its own.
 *
 *     Separately: the phrase itself is now refused in a draft. `findPromises` catches "10
 *     seconds" and "10 second" as of the duration fix earlier today, so an agent that offered it
 *     would have its reply held.
 */
import { isValidGstin } from "@/lib/utils";
import { REVIEW_ABOVE_SEATS } from "@/lib/pricing/volume-slabs";

/* ── The mailbox question ─────────────────────────────────────────────────── */

/**
 * Mailbox providers where the domain belongs to the provider, not to the customer.
 *
 * The list matters twice over. It is the difference between a business domain and a free
 * mailbox for grading — and it is what stops `businessDomainFromEmail` handing "gmail.com" to
 * the MX lookup, which would produce the observation "gmail.com's mail is handled by Google
 * Workspace" and read as a machine stating the obvious back to a customer.
 */
const FREE_MAILBOX_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.in",
  "yahoo.co.in",
  "ymail.com",
  "rediffmail.com",
  "rediff.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "proton.me",
  "zohomail.com",
];

export function isFreeMailbox(domain: string | null | undefined): boolean {
  const d = domain?.trim().toLowerCase().replace(/\.$/, "");
  return !!d && FREE_MAILBOX_DOMAINS.includes(d);
}

/**
 * The customer's OWN domain, from the address they wrote from. Null for a free mailbox.
 *
 * ─── THIS LIGHTS UP TWO FEATURES THAT WERE DARK ─────────────────────────────
 * Measured 25 Aug 2026: all 28 leads in the live table have `domain` NULL. It is only ever
 * written by the trial and public-checkout routes, which ask for it on a form — and the AI sales
 * agent runs on leads created by the inbound EMAIL and WHATSAPP webhooks, which never set it.
 *
 * So `observeDomain(lead.domain)` has been receiving null on every real run, and the domain
 * inspection and switch/trade-in blocks built on 25 Aug have never once fired on the path they
 * were written for. The domain was sitting in the contact address the whole time.
 *
 * Free mailboxes return null rather than "gmail.com" deliberately: it is not their domain, we
 * cannot tell them anything about it they do not know, and no part of a switch conversation
 * applies to it.
 */
export function businessDomainFromEmail(email: string | null | undefined): string | null {
  const raw = email?.trim().toLowerCase();
  if (!raw) return null;

  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;

  const domain = raw.slice(at + 1).replace(/[>,;\s]+$/, "").replace(/\.$/, "");
  /* One dot minimum and no spaces. `normaliseDomain` in lib/dns does the strict validation
     before anything resolves; this only has to avoid handing it obvious rubbish. */
  if (!domain.includes(".") || /\s/.test(domain)) return null;
  if (isFreeMailbox(domain)) return null;

  return domain;
}

/* ── The grade ────────────────────────────────────────────────────────────── */

export type LeadGrade = "A+" | "A" | "B" | "C" | "D";

/** How the enquiry reads. Vagueness is the real negative signal the brief bundled with Gmail. */
export type EnquiryClarity = "specific" | "general" | "vague";

export interface LeadFactsForGrading {
  /** As recorded. Checked against the GST checksum, not merely for length. */
  gstin: string | null;
  /** The address they wrote from. The domain is derived, not asked for. */
  contactEmail: string | null;
  /** Seats we would actually price on — null when only inferred. See mergeQualification. */
  seatsWritten: number | null;
  /** monthly | annual, or null when they have not said. A quote cannot go out without it. */
  term: "monthly" | "annual" | null;
  clarity: EnquiryClarity;
  /** True when we hold a phone number that could actually be rung. */
  hasPhone: boolean;
}

export type LeadRoute =
  /** Everything needed to price, small enough to send: quote now. */
  | "quote_now"
  /** Priced and drafted in full, then held — the 51+ seat review band. */
  | "quote_for_review"
  /** Hot, but one fact short. Ask that one question and nothing else. */
  | "ask_the_one_question"
  /** Worth a person's attention rather than a machine's. */
  | "human_first"
  /** Answer properly, then follow the cadence. */
  | "reply_and_nurture";

export interface LeadGrading {
  grade: LeadGrade;
  /** 0–100. Shown to a person, never to the model. */
  score: number;
  route: LeadRoute;
  /**
   * Whether this lead may be RUNG at all — not when. `decideTelecall` owns the timing, and
   * obeys quiet hours, the 24-hour gap and the attempt ceiling.
   */
  callEligible: boolean;
  /** The domain we derived, so the caller can hand it to the MX lookup. */
  businessDomain: string | null;
  /** Plain sentences for the timeline and the queue. Written for a person, not a log parser. */
  reasons: readonly string[];
}

/* Weights. Chosen so no single signal can carry a lead to A+ alone, and so the absence of a
   business domain cannot push a lead DOWN — see the header. */
const W_GSTIN = 30;
const W_SEATS_WRITTEN = 25;
const W_TERM = 15;
const W_CLARITY_SPECIFIC = 20;
const W_CLARITY_GENERAL = 8;
const W_DOMAIN = 10;

/** Seats at or above this, with the rest in place, is the top band. The brief's own number. */
export const A_PLUS_SEATS = 25;

export function gradeLead(facts: LeadFactsForGrading): LeadGrading {
  const reasons: string[] = [];
  let score = 0;

  const gstinValid = isValidGstin((facts.gstin ?? "").trim());
  if (gstinValid) {
    score += W_GSTIN;
    reasons.push("GSTIN is on record and passes the checksum — a registered business.");
  } else if (facts.gstin?.trim()) {
    /* Named separately from "no GSTIN". A number that fails the checksum is a typo or a
       fabrication, and CLAUDE.md §7 records a fabricated GSTIN already living in this repo. */
    reasons.push("A GSTIN was given but does not pass the checksum — worth confirming.");
  }

  const businessDomain = businessDomainFromEmail(facts.contactEmail);
  if (businessDomain) {
    score += W_DOMAIN;
    reasons.push(
      `They write from their own domain (${businessDomain}), so they already have business ` +
        "email somewhere — this is a switch, not a first purchase.",
    );
  } else if (facts.contactEmail?.includes("@")) {
    /* NOT a deduction, and the sentence says why. See the header: the customer without business
       email is the one who has not bought what we sell. */
    reasons.push(
      "They write from a free mailbox, which usually means no business email yet — the need is " +
        "unmet and there is no incumbent to displace.",
    );
  }

  if (facts.seatsWritten !== null && facts.seatsWritten > 0) {
    score += W_SEATS_WRITTEN;
    reasons.push(`${facts.seatsWritten} seats, stated in writing.`);
  }

  if (facts.term) {
    score += W_TERM;
    reasons.push(`Billing term confirmed: ${facts.term}.`);
  }

  if (facts.clarity === "specific") {
    score += W_CLARITY_SPECIFIC;
    reasons.push("The enquiry names what they want.");
  } else if (facts.clarity === "general") {
    score += W_CLARITY_GENERAL;
  } else {
    reasons.push("The enquiry is vague — nothing specific has been asked for yet.");
  }

  score = Math.min(100, score);

  /* ── The grade ──
     A+ requires the three things a deal actually needs — a registered business, a seat count in
     writing at or above the band, and a stated term — plus an enquiry that is not vague. A
     business domain is deliberately NOT required: requiring it would have made A+ unreachable
     for every lead in the live table, all 28 of which have no domain, and would have excluded
     exactly the customers who have not bought business email yet. */
  const bigEnough = (facts.seatsWritten ?? 0) >= A_PLUS_SEATS;
  const quotable = facts.seatsWritten !== null && facts.seatsWritten > 0 && facts.term !== null;

  /* ─── AND THE `A` RULE HAD A BUG ITS OWN TEST CAUGHT ──────────────────────
     `A` used to require `quotable`, which needs a stated TERM. So a lead with a valid GSTIN,
     TWO HUNDRED seats in writing and a perfectly clear ask fell to Grade B and was routed to
     `reply_and_nurture` — nurtured, because one of four facts was missing. That is the single
     hottest shape a lead can arrive in, and `ask_the_one_question` exists for exactly it.

     So `A` now means "nearly ready": a registered business or a deal of size, asking something
     specific. Whether it can be PRICED is a separate question, answered by `quotable` below,
     and it decides the ROUTE rather than the grade. Keeping those two apart is what stops the
     grade and the action disagreeing. */
  const grade: LeadGrade =
    gstinValid && bigEnough && facts.term !== null && facts.clarity !== "vague"
      ? "A+"
      : (gstinValid || bigEnough) && facts.clarity !== "vague"
        ? "A"
        : score >= 45
          ? "B"
          : score >= 25
            ? "C"
            : "D";

  /* ── The route ──
     Derived from what is MISSING rather than from the letter, so the grade and the action cannot
     disagree. A lead is only ever quoted when it is genuinely quotable. */
  const overReviewBand = (facts.seatsWritten ?? 0) > REVIEW_ABOVE_SEATS;

  const route: LeadRoute = !quotable
    ? grade === "A+" || grade === "A"
      ? "ask_the_one_question"
      : grade === "D"
        ? "reply_and_nurture"
        : "reply_and_nurture"
    : overReviewBand
      ? "quote_for_review"
      : grade === "A+" || grade === "A"
        ? "quote_now"
        : "reply_and_nurture";

  if (overReviewBand) {
    reasons.push(
      `Above ${REVIEW_ABOVE_SEATS} seats, so the quotation is prepared in full and held for a ` +
        "person — that band is where the discount conversation is the deal.",
    );
  }

  /* Call eligibility, NOT call timing. A phone number and a lead worth a person's minute; when
     the phone actually rings is decideTelecall's decision, under quiet hours and TRAI. */
  const callEligible = facts.hasPhone && (grade === "A+" || grade === "A");

  return { grade, score, route, callEligible, businessDomain, reasons };
}

/**
 * One sentence for the lead timeline. Named so nothing renders a bare letter with no reason.
 *
 * A grade on a screen with no explanation is a number somebody either over-trusts or ignores,
 * and both are worse than the sentence that produced it (CLAUDE.md §24).
 */
export function gradeSummary(g: LeadGrading): string {
  const action =
    g.route === "quote_now"
      ? "quotation goes out"
      : g.route === "quote_for_review"
        ? "quotation prepared and held for a person"
        : g.route === "ask_the_one_question"
          ? "one question asked, then quote"
          : g.route === "human_first"
            ? "handed to a person"
            : "answered, then followed up";

  return `Grade ${g.grade} (${g.score}/100) — ${action}${g.callEligible ? ", may be called" : ""}.`;
}
