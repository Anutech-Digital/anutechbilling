/**
 * The AI sales agent's reasoning layer — prompt in, validated decision out.
 *
 * Everything here is PURE. No Gemini call, no database, no clock: the prompt is built from
 * arguments and the model's answer is validated against a schema. `sales-agent.server.ts`
 * does the fetching and the calling. That split is not tidiness — it is the only way the
 * decisions below (what the agent is allowed to say, when it must fetch a human) can be
 * tested without a network, and they are the decisions that reach a customer.
 *
 * ─── PRICES ARE PASSED IN, NEVER WRITTEN DOWN HERE ──────────────────────────
 * The obvious shape for a sales agent is a product table at the top of the file. It was
 * deliberately not built that way, and this is the most important line in the module.
 *
 * `items.msrp` in the tenant's own catalog is the single source of truth for what a customer
 * pays (lib/pricing/workspace.ts says so, and the public checkout and the auto-quote both
 * read it so "Buy now" and "Get a quote" cannot disagree). A price constant in this file
 * would be a SECOND source, and a second source of a rupee figure does not stay equal to the
 * first — it goes stale silently and the agent quotes yesterday's price with today's
 * confidence.
 *
 * That is not hypothetical. The spec this was built from named Workspace Standard at ₹750;
 * the live catalog says **₹864 per seat per MONTH** (wholesale ₹620/month), measured 24 Aug
 * 2026. A hardcoded ₹750 would have under-quoted every Standard deal with nothing to catch it
 * — .github/workflows/money-check.yml exists because four products once shipped with defaults
 * BELOW their own vendor cost. So the catalog is read at call time and handed in as
 * `catalog`, and `allowedMoney` carries exactly those figures to the money guard.
 *
 * ─── AND READING IT AT CALL TIME WAS NOT ENOUGH ─────────────────────────────
 * This header used to describe ₹864 as a per-YEAR figure, and `loadSalesCatalog` copied the
 * column across on that belief. Reading the live value protects you from a stale number; it
 * does nothing about a wrong UNIT. Twelve times wrong, on every price, below our own cost —
 * see MONTHS_PER_YEAR for what it looked like in a real draft. The lesson the first half of
 * this comment was missing: name the unit next to the number, every time.
 *
 * ─── WHAT THE MODEL IS AND IS NOT TRUSTED WITH ──────────────────────────────
 * Trusted: reading intent, reading sentiment, choosing words, deciding that a quote is what
 * this customer now wants.
 * Not trusted: arithmetic, document numbers, and its own confidence. Quote totals come from
 * the catalog and lib/pricing; the quote number comes from the `next_document_number` RPC;
 * and `applyHandoverRules` can overrule the model's chosen action but can never relax it —
 * see the function.
 */
import { z } from "zod";
import { verifyDraftMoney } from "./money-guard";
import { findPromises } from "./promise-check";
import { unbackedQuoteClaim } from "./quote-claim";
import { findDisparagement } from "./disparagement";
import { CUSTOM_PRICING_ABOVE, authorisedRatesForItem, discountedRate, slabFor, slabLines } from "@/lib/pricing/volume-slabs";
import { authorisedNetCostFigures, computeNetCost, netCostLines } from "@/lib/pricing/net-cost";
import { authorisedOfferFigures, offerCandidates, offerLines } from "@/lib/pricing/cross-sell";
import { battlecardLines } from "./battlecards";
import { detectTone, toneLines } from "./tone";
import { MIGRATION_CLAIMS_FORBIDDEN } from "@/lib/dns/domain-inspect";

/**
 * Deals above this many seats are not auto-quoted, whatever the model thinks.
 *
 * ─── MOVED FROM 50 TO 100 ON 25 AUG 2026, AND THE OLD REASON IS WHY ─────────
 * This used to be 50, and the comment said: "above it the discount conversation is the deal
 * and a machine that skips it loses money that was available." That was correct — while the
 * machine had no discount to give. It now has one: a published volume rate card
 * (lib/pricing/volume-slabs.ts) that says exactly what 21–50 and 51–100 seats earn. Applying
 * a published rate is not a negotiation, so the objection stops holding at 100, where the
 * card stops and the answer really does become "it depends on what the vendor will fund".
 *
 * The 50-seat line did not disappear, it changed job. It is now REVIEW_ABOVE_SEATS: 51–100
 * seats are priced and drafted in full, and held for a person rather than sent. So the band
 * that used to produce nothing now produces a finished quote, and still nobody's money moves
 * without a human seeing it.
 */
export const HANDOVER_SEAT_CEILING = CUSTOM_PRICING_ABOVE;

/**
 * Below this, the agent does not speak to the customer unattended.
 *
 * The model reports its own confidence, which is worth exactly as much as self-reported
 * confidence usually is — so this is a floor on a soft number, not a guarantee. It earns its
 * place anyway: the failure it catches is the enquiry the model half-understood and answered
 * fluently, which is the one a person cannot spot by skimming.
 */
export const MIN_AUTONOMOUS_CONFIDENCE = 0.7;

/** How many past turns go into the prompt. Enough to stop re-asking; short enough to stay cheap. */
export const MAX_CONTEXT_TURNS = 12;

export type SalesChannel = "email" | "whatsapp";
export type SalesTurnRole = "user" | "agent" | "system";

export type SalesAgentAction =
  | "REPLY"
  | "GENERATE_QUOTE_AND_SEND"
  | "HANDOVER_TO_HUMAN";

/**
 * `items.msrp` and `items.wholesale` are ₹ per seat per **MONTH**.
 *
 * ─── THIS CONSTANT EXISTS BECAUSE THE UNIT WAS GOT WRONG HERE, LIVE ─────────
 * AGENTS.md §1 states it plainly (`Business Starter → msrp = 270` is ₹270 per seat per
 * month) and `lib/quotes/quote-from-enquiry.ts` has always honoured it: its annual line rate
 * is `msrp × 12`.
 *
 * `loadSalesCatalog` did NOT. It copied `items.msrp` straight into a field named
 * `msrpPerSeatPerYear`, so the prompt told the model "customer pays Rs 864 per seat per
 * year" for a product that costs us ₹620 per seat per MONTH — ₹7,440 a year. Every price the
 * agent stated was a twelfth of the real one, which is to say far below our own cost.
 *
 * Measured 24 Aug 2026 on a demo run: the agent's covering email said "12 seats of Google
 * Workspace Standard at Rs 864 per seat per year" while the quote it referenced by number
 * said ₹1,500/seat/year and the truth was ₹10,368. One deal, three numbers, two of them
 * below cost — and `verifyDraftMoney` APPROVED it, because its allow-list was built from the
 * same wrong figures. A money guard checking against the wrong source is not a guard.
 *
 * The conversion is a named function rather than a bare `* 12` so a test can pin it against
 * the quote path's rate for the same item. Two places computing one figure is what this
 * module's header warns about; this is that warning coming true inside the module itself.
 */
export const MONTHS_PER_YEAR = 12;

/** ₹/seat/month → ₹/seat/year. Rounded once, at the end. */
export function perSeatPerYear(perSeatPerMonth: number): number {
  return Math.round(perSeatPerMonth * MONTHS_PER_YEAR);
}

/**
 * A SKU the agent must not be shown, because quoting it would sell below cost.
 *
 * `money-check.yml` exists because four products once shipped with defaults BELOW their own
 * vendor cost — but that check runs over committed defaults, not over what the agent is
 * handed at call time. This is the same question asked at the point of use.
 *
 * A wholesale of 0 means "not recorded", not "free": it passes, because a missing cost must
 * not remove a real product from the catalogue. That is the same call `loadSalesCatalog`
 * already made about margin being context-only.
 */
export function isBelowCost(entry: { msrpPerSeatPerYear: number; wholesalePerSeatPerYear: number }): boolean {
  if (entry.wholesalePerSeatPerYear <= 0) return false;
  return entry.msrpPerSeatPerYear < entry.wholesalePerSeatPerYear;
}

/** One catalogue line, in WHOLE RUPEES, as read from `items` at call time. */
export interface SalesCatalogEntry {
  /** `items.id` — carried through so the quote line references the real SKU. */
  sku: string;
  name: string;
  vendor: string;
  /** ₹/seat/YEAR the customer pays — `items.msrp × 12`. See MONTHS_PER_YEAR. */
  msrpPerSeatPerYear: number;
  /** ₹/seat/YEAR we pay the vendor — `items.wholesale × 12`. Never shown to the customer. */
  wholesalePerSeatPerYear: number;
  /**
   * The monthly-flex tier's ₹/seat/**MONTH**, or null when the catalogue has none.
   *
   * PER MONTH while its two neighbours are per YEAR, and that asymmetry is the domain's, not a
   * slip: a `monthly` commitment line carries one month's rate (commitment-rate.ts). Naming the
   * unit in the field is the only defence — the 24 Aug under-quote was exactly a per-month
   * figure read as per-year.
   *
   * Null means the agent must not name a monthly price. It then says a colleague will confirm
   * one, which is what it did for every monthly request before this field existed — only now
   * it says so on purpose rather than by handing over with no reason.
   */
  monthlyFlexPerSeatPerMonth: number | null;
}

export interface SalesAgentTurn {
  role: SalesTurnRole;
  content: string;
  channel: SalesChannel;
}

export interface SalesAgentLeadFacts {
  leadId: string;
  company: string;
  contactName: string;
  /** Whole rupees. Null when the customer has not said a number yet. */
  seats: number | null;
  plan: string | null;
  /** Where a reply would go — an email address or an E.164 phone number. */
  customerContact: string;
  channel: SalesChannel;
  /** Quote id already on this lead, if any. Stops the agent quoting twice. */
  existingQuoteId: string | null;
  /**
   * The newest quote the customer has ACTUALLY RECEIVED, or null.
   *
   * Separate from `existingQuoteId` because the two license different sentences: a draft is
   * enough to stop a second quotation being raised, and not nearly enough to tell somebody a
   * reference number. On 31 Aug 2026 one field did both jobs and a customer was given the id
   * of a document that had never left the building.
   */
  deliveredQuoteId: string | null;
  /**
   * `leads.gstin`. Decides whether the input-tax-credit line may be stated AT ALL.
   *
   * Measured on production 25 Aug 2026: 16 of 28 leads have none. ITC is worth nothing to an
   * unregistered business, so this is not a nicety — see lib/pricing/net-cost.ts.
   */
  gstin?: string | null;
}

/**
 * Rupee totals the APP computed, which the agent is therefore allowed to state.
 *
 * ─── WHY THIS EXISTS, MEASURED 24 Aug 2026 ──────────────────────────────────
 * The model is not trusted with arithmetic — `sales-agent.ts`'s header says so and
 * `verifyDraftMoney` enforces it by authorising only the per-seat catalogue figures. Correct,
 * and it had a consequence nobody had hit until the unit bug was fixed: the moment the agent
 * started computing the RIGHT annual total it began handing over on every quote email.
 *
 *   "The draft's email names a price we did not authorise (Rs 1,24,416)"
 *
 * ₹1,24,416 is 12 × ₹10,368 — exactly right, and refused, because a total is arithmetic. So a
 * covering email for a quote could never be sent: the one thing it must say is the amount.
 *
 * The fix is not to let the model do arithmetic. It is for the APP to compute the totals and
 * hand them over as authorised facts — same shape as the catalogue itself. `authorisedTotalsFor`
 * derives the seats × price figure, and the caller adds a real quote's own subtotal and amount
 * when one exists. Anything the model invents beyond that list still hands over.
 */
export interface BuildPromptArgs {
  lead: SalesAgentLeadFacts;
  /** See the interface comment. Empty means the agent may state no total at all. */
  authorisedTotals?: readonly number[];
  /** Oldest first. Trimmed to MAX_CONTEXT_TURNS by this function. */
  history: readonly SalesAgentTurn[];
  /** The newest customer message, not yet in `history`. */
  incoming: string;
  catalog: readonly SalesCatalogEntry[];
  /** The reseller's trading name, for the signature. */
  sellerName: string;
  /** The address the agent signs as, e.g. "sales@anutech.in". */
  sellerEmail: string;
  /**
   * Finished sentences about the customer's OWN domain, from lib/dns/domain-inspect.
   *
   * Observations, never prescriptions: what their MX says today, which the customer can verify
   * in thirty seconds. The module refuses to name a target record, and the block below repeats
   * the migration claims the model must not attach to them.
   */
  domainFacts?: readonly string[];
  /**
   * Stage 1's binding briefing, from `qualifierBriefing` in lib/ai/pipeline.ts.
   *
   * Rendered FIRST, ahead of the catalogue, because it is an instruction rather than context:
   * a line saying no quotation goes out on this message has to be read before ten prices are,
   * not after. Empty or absent when the qualifier found nothing worth constraining — which is
   * the ordinary case, and leaves this prompt exactly as it was.
   *
   * "Binding" is not only a word in the prompt. `narrowByQualification` applies the same
   * verdict to the ACTION after the model answers, so ignoring this block cannot produce a
   * quotation — it produces a handover.
   */
  qualifierBrief?: readonly string[];
  /**
   * The switch conversation, from lib/ai/trade-in.ts.
   *
   * Rendered next to the domain observation it was derived from, because the two are one
   * thought: "their mail is on GoDaddy today" and "so lead with migration being included".
   * Empty when we could not identify a provider — an unrecognised MX is not a switch we can
   * describe, for the same reason identifyProvider refuses to guess one.
   */
  tradeInFacts?: readonly string[];
  /**
   * What we may bring up from an earlier PHONE CALL, from lib/ai/unified-memory.ts.
   *
   * Rendered near the top, with the qualifier's briefing, because it changes how the reply
   * OPENS — a recall placed after the catalogue is a fact the model reads once it has already
   * decided what to say. Empty when there has been no call, which is the ordinary case.
   */
  recallFacts?: readonly string[];
  /**
   * R-2460: the lead's draft quotation is HELD by the customer-copy gate — no place of supply
   * (lead / company state missing) or it needs approval. Its figures are a price nobody has
   * approved to send, so: no total is authorised (`authorisedTotals` and the net-cost block are
   * dropped), every held figure is struck from `allowedMoney` (a reply stating one is handed to
   * a person by applyHandoverRules), and the model is told what to say instead — ask for the
   * state, or say the quotation will follow. Per-seat catalogue prices stay allowed.
   */
  heldQuote?: HeldQuoteBrief | null;
}

/** R-2460: what the prompt needs to know about a held draft — structurally a SendAutoQuoteHeld. */
export interface HeldQuoteBrief {
  kind: "approval" | "company_state" | "customer_state";
  /** The held draft's figures (rounded rupees) — never to be stated while it is held. */
  totals: readonly number[];
}

/**
 * R-2460: the binding lines for a held draft, rendered at the very top of the prompt (an
 * instruction, read before any price). Only the customer's own state is something the customer
 * can supply; the company's state and an approval are ours to sort out, so then the reply only
 * says the quotation will follow — no internal reason.
 */
export function heldQuoteLines(h: HeldQuoteBrief): string[] {
  return [
    "QUOTATION ON HOLD — READ THIS FIRST",
    "- A quotation has been drafted for this lead but it is HELD and has NOT been sent.",
    "- Do NOT state any total, subtotal, GST amount or payable amount for this deal — not one",
    "  from earlier in the conversation, and not one you work out. Per-seat list prices from the",
    "  catalogue are still allowed. Do not give a quotation number.",
    h.kind === "customer_state"
      ? "- Ask the customer which state their business is registered in (or their GST billing " +
        "address), because the GST on the quotation depends on it, and say the quotation will " +
        "follow as soon as we have it."
      : "- Tell the customer their quotation is being prepared and will follow shortly. Do not " +
        "give an internal reason.",
  ];
}

/**
 * R-2460: the held figures a reply names — empty when it names none. Used by the dispatcher on
 * the agent's own quote path, where the reply was written BEFORE the draft was held.
 */
export function heldTotalsNamed(text: string, totals: readonly number[]): number[] {
  if (totals.length === 0) return [];
  const held = new Set(totals.map((t) => Math.round(t)));
  return verifyDraftMoney(text, []).found.map((n) => Math.round(n)).filter((n) => held.has(n));
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /**
   * Every rupee figure the agent was authorised to use, for verifyDraftMoney. Retail only —
   * a draft that quotes our wholesale cost back to the customer is a violation, not a
   * rounding error, so the wholesale numbers are deliberately absent from this list even
   * though they are in the prompt.
   */
  allowedMoney: number[];
  /** The app-computed totals that went into allowedMoney, for the log. */
  authorisedTotals: number[];
}

export interface SalesAgentResponse {
  email_subject: string;
  body_text: string;
  whatsapp_summary: string;
}

export interface SalesAgentFollowUp {
  /** Whole hours from now. Bounded by the schema — see SALES_AGENT_SCHEMA. */
  in_hours: number;
  /** Why, in the agent's own words, so the follow-up can refer to what it follows up on. */
  trigger_condition: string;
}

export interface SalesAgentDecision {
  customer_intent: string;
  perceived_sentiment: string;
  confidence_score: number;
  action_required: SalesAgentAction;
  /** WHY it chose HANDOVER_TO_HUMAN, in its own words. Null otherwise — see SALES_AGENT_SCHEMA. */
  handover_reason: string | null;
  generated_response: SalesAgentResponse;
  /** Null when the agent does not want to be reminded — a closed thread, or a handover. */
  next_followup_loop: SalesAgentFollowUp | null;
  /** Seats the model read out of the conversation. Null when the customer has not said. */
  seats_discussed: number | null;
  /**
   * Term jaisa POORI baat-cheet se samajh aata hai — teen alag cheezein, do nahi
   * (1 Sep 2026: customer ne "yearly" tay kiya tha, phir sirf BHUGTAN monthly
   * maanga; agent ne commitment hi palat kar Rs 325 flex bol diya):
   *   annual                = saal ka vaada, saal me ek invoice
   *   annual_billed_monthly = saal ka vaada, bhugtan har mahine (12 invoices)
   *   monthly_flex          = koi vaada nahi, mahina-dar-mahina (mehenga tier)
   * Null = kaha hi nahi. Dispatcher isse pehle padhta hai, keyword-search baad me.
   */
  term_discussed: "annual" | "annual_billed_monthly" | "monthly_flex" | null;
}

/* ── The master system prompt ─────────────────────────────────────────────── */

/**
 * Written as a list of refusals as much as instructions, because the failure mode of a sales
 * agent is not silence — it is confident invention. Every "never" below is a thing a fluent
 * model does by default when it does not know: quote a number, promise a date, claim a
 * capability, or answer a question it did not understand.
 */
export const SALES_AGENT_SYSTEM_PROMPT = [
  "You are AnuSales AI, the inside-sales assistant for an Indian cloud-solutions reseller.",
  "You answer prospective business customers who have enquired about Google Workspace,",
  "Microsoft 365 or Zoho. You write as a colleague at the company, in plain professional",
  "Indian business English. Never mention that you are an AI.",
  "",
  "MONEY — the rules you must not bend:",
  "- Use ONLY the per-seat prices given to you in CATALOGUE below. They are in whole rupees.",
  "- ALWAYS write the unit next to the figure: 'Rs 10,368 per seat per year', never 'Rs 10,368'.",
  "  A bare number is how a twelve-times error hid in this system for a whole day. If you are",
  "  about to write a price without a unit, you are about to write a number nobody can check.",
  "- NEVER multiply, add or total anything yourself. If a total is needed, use one of the",
  "  figures in AUTHORISED TOTALS exactly as given. If the total you want is not there, give",
  "  the per-seat price and the seat count and let the customer see the arithmetic — do not do",
  "  it for them.",
  "- Never invent, estimate, round, discount or 'approximately' a price. If the price for",
  "  what they asked is not in CATALOGUE, do not name a price at all — say you are checking",
  "  and set action_required to HANDOVER_TO_HUMAN.",
  "- Prices are always EXCLUDING GST. Say 'plus 18% GST' when you name one. Never state a",
  "  GST-inclusive total unless that exact figure is in AUTHORISED TOTALS.",
  "- The wholesale figures are OUR cost. They are shown to you so you understand the margin.",
  "  Never state, hint at, or compute from a wholesale figure in anything the customer reads.",
  "- Never promise a discount. Discounts are a human decision at this company.",
  "",
  "THE ONE FACT YOU MUST CHASE: MONTHLY OR ANNUAL",
  "A quotation cannot go out until the customer has said which billing term they want, because",
  "monthly and annual differ by 12x and a term we assumed is a price they can hold us to. So:",
  "- If they have named a product and a seat count but NOT the term, your reply asks for the",
  "  term and nothing else. That one question is worth more than anything else you could write.",
  "- If they have already said monthly or annual anywhere in the conversation, never ask again.",
  "",
  "WHAT TO ASK FOR, IN THIS ORDER — one thing at a time",
  "Ask for the FIRST of these that is missing, and only that one. A reply asking three",
  "questions gets one answer, usually the least useful.",
  "  1. which product",
  "  2. how many seats",
  "  3. monthly or annual",
  "",
  "WHAT YOU MAY PROMISE, because it is true of every deal here:",
  "- A proper GST tax invoice, so the customer claims 100% input tax credit.",
  /* The percentage used to be on this line, and it CONTRADICTED the net-cost block further
     down the same prompt, which says "do NOT state what a card or bank charges". Both were
     present on every message that had a product and a seat count, and which one won was up to
     the model. lib/pricing/net-cost.ts:21 has the reason the second one is right: a
     foreign-currency markup is a fact about the customer's own bank, issuers charge roughly
     1.75% to 3.5%, and naming one number is false precision about somebody else's contract.
     What is left is what our own invoice actually says. */
  "- Billing in rupees, by an Indian company, so there is no foreign-currency card charge.",
  "- Free migration of existing mail and data.",
  "- 24/7 support from a named local team.",
  "Use AT MOST TWO of these, and only ones that answer what they actually asked. Reciting all",
  "four in every mail is what makes a real person sound like a brochure — and the customer sees",
  "the same four lines the second time you write, which is worse than saying nothing.",
  "Do not extend the list. No uptime figures, no delivery dates, no contractual terms.",
  "",
  "NEVER CLAIM SOMETHING HAPPENED THAT YOU CANNOT SEE",
  "- You cannot log into their account, change their DNS, or start a migration. Never write as",
  "  if you have.",
  "- Never say a document was 'sent' or 'attached'. You do not control the envelope.",
  /* ── ONLY WITH A REFERENCE NUMBER (30 Aug 2026) ────────────────────────────
     This line used to read: "Say the quotation has been prepared, and give its reference
     number if you were given one." So the claim was unconditional and the reference was
     optional — and a live reply said "The quotation for 40 seats ... has been prepared at
     Rs 325 per seat per month" when no quotation existed at all. The auto-quote had
     correctly refused (the product name did not match the catalogue), and nothing told the
     agent. The facts block above already said "No quotation has been sent yet"; this line
     talked over it.

     The reference is now what LICENSES the claim, not a decoration on it. */
  "- Say a quotation HAS BEEN PREPARED only if you were given its reference number, and then",
  "  give that number. Were you given none, no quotation exists: say what you will do — 'I",
  "  will prepare the quotation' — and never that one is ready, attached or enclosed.",
  "- Never invent a reference number, a date, or a person's name.",
  "",
  "END EVERY REPLY WITH THE ONE THING YOU NEED",
  "The last line says what happens next and who does it — 'Send me the seat count and I will",
  "prepare the quotation' — never a bare 'let me know'. A message that does not say what to do",
  "next is a message somebody has to think about before answering, and they will not.",
  "The next step must carry NO DATE and NO DEADLINE of any kind — no day name, no calendar",
  "date, no hour count, no 'end of' anything. A timing word there is a promise: it is refused",
  "before it can be sent, and the whole reply is held over that one word. Say WHAT you will do",
  "and never WHEN.",
  "",
  /* ── NEVER ASK FOR A GSTIN ────────────────────────────────────────────────
     Pardeep read a live reply on 30 Aug 2026 that ended:

       "Share your company's GSTIN and billing address and I will issue the formal invoice."

     Nothing in this prompt asked for that — the model reached for it because it sounds
     like Indian B2B procedure. It is wrong twice.

     A quotation needs no GSTIN at all; it is not a tax document. And on the invoice it is
     not compulsory either: CGST Rule 46(b) asks for the recipient's GSTIN **where the
     recipient is registered**, and a supply to an unregistered person is a valid B2C tax
     invoice without one. Plenty of real buyers have no GST number.

     So the sentence turns a "yes, send the quote" into a form to fill in, and quietly tells
     a customer without a GSTIN that they may not be able to buy. The reminder belongs at the
     moment of ISSUE and to the operator, not to the customer at quotation time — it now
     lives in the issue-invoice dialog (lib/invoices/issue-consequences.ts). */
  "NEVER ASK FOR A GSTIN OR A BILLING ADDRESS",
  "A quotation is not a tax document and needs neither. Asking turns a 'yes' into paperwork,",
  "and a buyer who has no GST number — many do not — reads it as being told they cannot buy.",
  "GST registration is optional for the buyer and the seller collects those details at",
  "invoicing, not here. Ask only for what decides the QUOTE: product, seat count, term.",
  "",
  "SIGNING OFF",
  "Sign with the SELLER'S COMPANY NAME as given to you, and a first name if you were given one.",
  "The address you are signing as may contain software or sender names — those are plumbing.",
  "Never sign as, or mention, any product or platform name that is not the seller's own company.",
  "",
  "CHOOSING action_required:",
  "- REPLY — they asked something; answer it. The default.",
  "- GENERATE_QUOTE_AND_SEND — they have told you the product, the seat count AND the term, and",
  "  a formal quotation is the natural next step. If any of the three is missing, choose REPLY",
  "  and ask for the first missing one instead.",
  "- HANDOVER_TO_HUMAN — anything you are not sure of: a price not in CATALOGUE, a legal or",
  "  contractual question, an angry customer, a request for a discount, a question about",
  "  someone else's account, or a message you do not properly understand. Choosing this is a",
  "  correct answer, not a failure.",
  "",
  /* "0 to 1", not "0-1": the hyphenated form is date-shaped and findPromises reads it as one.
     Nothing in this prompt may contain a token the guard would refuse, because anything here
     can end up echoed in a reply — see the test that scans this whole string. */
  /* Asked for in words as well as in the JSON shape, because this is the field an operator
     reads at 11pm to decide whether to take the lead over. 26 Aug 2026: without it a handover
     the model chose at 0.95 confidence was logged as "not confident enough" — the one thing it
     was not. Name the missing FACT, not a feeling. */
  "handover_reason — when action_required is HANDOVER_TO_HUMAN, one sentence on WHY, naming the",
  "fact you lacked or the decision that is not yours: 'no monthly rate in the catalogue',",
  "'asked for a discount beyond the rate card', 'contract wording'. Null for any other action.",
  "",
  "confidence_score is YOUR honest 0 to 1 read of how well you understood this message and how",
  "safe your reply is to send with nobody checking it. Be harsh. A low score costs the",
  "company one salesperson-minute; a confident wrong answer costs a customer.",
  "",
  "You will be told the conversation so far. Do not re-ask anything the customer has already",
  "answered in it — that is the single fastest way to lose this deal.",
  "",
  "next_followup_loop — when to come back if they go quiet. trigger_condition is written for",
  "the colleague who reads it later, and names the fact you are waiting on: 'no seat count yet',",
  "not 'follow up'. Null when the thread is finished or a person is taking over.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"customer_intent":string,"perceived_sentiment":string,"confidence_score":number,',
  '"action_required":"REPLY"|"GENERATE_QUOTE_AND_SEND"|"HANDOVER_TO_HUMAN",',
  /* Asked for explicitly, because the fallback that stood in for it reported the wrong
     reason for an hour — see SALES_AGENT_SCHEMA's handover_reason. */
  '"handover_reason":string|null,',
  '"generated_response":{"email_subject":string,"body_text":string,"whatsapp_summary":string},',
  '"next_followup_loop":{"in_hours":number,"trigger_condition":string}|null,',
  '"seats_discussed":number|null,',
  '"term_discussed":"annual"|"annual_billed_monthly"|"monthly_flex"|null}',
  "",
  "term_discussed — read the WHOLE conversation, not the last message alone:",
  "- annual: yearly/annual commitment, billed once a year.",
  "- annual_billed_monthly: the customer has (or had) a YEARLY commitment and asks to PAY",
  "  monthly — monthly billing/payments/instalments of the annual plan. If yearly was already",
  "  agreed earlier in the thread and they now say just Rs-per-month or ask about monthly",
  "  billing, this is the one — do NOT flip them to the flex tier.",
  "- monthly_flex: they explicitly want no commitment / month-to-month (the flex tier, higher",
  "  per-seat rate).",
  "- null: the term never came up.",
  "",
  "body_text is the email body, plain text. whatsapp_summary is the SAME message in at most 600",
  "characters, no salutation block — keep the price, the unit and the next step; drop the rest.",
].join("\n");

/* ── Prompt assembly ─────────────────────────────────────────────────────── */

function rupees(n: number): string {
  return `Rs ${n.toLocaleString("en-IN")}`;
}

/**
 * Build the user half of the prompt: who this is, what they said, what we sell.
 *
 * The catalogue is rendered per-seat-per-YEAR because that is the unit the annual commitment
 * is sold in and the unit `items.msrp` holds. Handing the model a monthly figure and asking
 * it to multiply would be handing it arithmetic, which it is explicitly not trusted with.
 */
export function buildSalesAgentPrompt(args: BuildPromptArgs): BuiltPrompt {
  const { lead, catalog, incoming, sellerName, sellerEmail, domainFacts } = args;
  const tradeIn = args.tradeInFacts ?? [];

  const history = args.history.slice(-MAX_CONTEXT_TURNS);

  /* Computed once and used twice — the sentences go in the prompt, the figures go in
     allowedMoney. Null when there is nothing to price yet (no product or no seat count), in
     which case the block is omitted entirely rather than rendered empty. */
  /* R-2460: a HELD draft — no net cost (it is the held price, worked out again) and no totals.
     See BuildPromptArgs.heldQuote. */
  const held = args.heldQuote ?? null;
  const heldFigures = new Set((held?.totals ?? []).map((t) => Math.round(t)));
  const netCost = held ? null : netCostFactsFor(catalog, lead, sellerName);
  const netCostBlock = netCost?.lines ?? null;

  /* Objection handling, and ONLY when the incoming message actually raised one. Loading every
     battlecard into every prompt would teach the agent to argue with customers who were not
     arguing — and the cards are constraints as much as scripts, so the ones that do not apply
     are noise the model has to read past. */
  const battlecards = battlecardLines({ message: incoming, catalogue: catalog });

  /* What else this customer could be offered — from the catalogue and nowhere else. Null when
     we do not yet know what they are buying, because "you could also add X" to somebody who has
     not chosen a product is a pitch before a conversation. See lib/pricing/cross-sell.ts. */
  const currentItem = lead.plan ? catalog.find((c) => c.name === lead.plan) : undefined;
  const offers = currentItem
    ? offerCandidates(catalog, {
        name: currentItem.name,
        vendor: currentItem.vendor,
        pricePerSeatPerYear: currentItem.msrpPerSeatPerYear,
      })
    : [];

  const catalogueLines = catalog.map(
    (c) =>
      `- ${c.name} (${c.vendor}) — customer pays ${rupees(c.msrpPerSeatPerYear)} per seat per year` +
      /* The flex tier, when there is one. Stated as per-MONTH in the same breath as the
         per-year figure, because the model has to keep the two apart and the unit is the only
         thing that tells them apart. Absent when the catalogue has none — and then the line
         below tells the model plainly that it may not name one. */
      (c.monthlyFlexPerSeatPerMonth !== null
        ? `, or ${rupees(c.monthlyFlexPerSeatPerMonth)} per seat per MONTH on monthly billing (no commitment)`
        : `, and NO monthly price is on file — if they want monthly billing, say a colleague will confirm the rate`) +
      ` [our cost ${rupees(c.wholesalePerSeatPerYear)} — INTERNAL, never state]`,
  );

  /* ── THIS deal's volume rate, worked out HERE ───────────────────────────────
     The model is told the finished figures instead of the table plus a lookup. Why, in full,
     at the prompt line that renders this. Short version: the instruction-shaped version of
     this shipped, was verified live, and the very next quotation omitted the discount again —
     three model steps (find the band, do the arithmetic, remember to say it) where the app
     already knows the answer exactly.

     Requires BOTH a seat count and the product, because without either there is no single
     rate to name; the rate-card table above still covers that case. */
  const dealItem =
    lead.plan !== null ? catalog.find((c) => c.name === lead.plan) ?? null : null;
  const dealSlab = lead.seats !== null ? slabFor(lead.seats) : null;
  const dealSlabLines: string[] =
    dealItem && dealSlab && dealSlab.kind === "slab" && dealSlab.slab.percent > 0
      ? (() => {
          const priced = discountedRate(
            dealItem.msrpPerSeatPerYear,
            dealSlab.slab.percent,
            dealItem.wholesalePerSeatPerYear,
          );
          /* `appliedPercent` 0 means discountedRate REFUSED the slab — it lands at or below our
             cost (see its own comment). Naming a discount the quote will not apply would put a
             figure in the words that the document contradicts, which is the whole bug this
             block exists to fix, in mirror image. */
          return priced.appliedPercent === 0
            ? []
            : [
                `THIS DEAL'S VOLUME RATE (already applied to the quotation — you MUST state it)`,
                `- ${lead.seats} seats falls in the ${dealSlab.slab.label} band`,
                `- list ${rupees(dealItem.msrpPerSeatPerYear)} per seat per year,` +
                  ` less ${priced.appliedPercent}% = ${rupees(priced.rate)} per seat per year`,
                `Say the ${priced.appliedPercent}% and both figures, so the customer can check the`,
                `total by hand. Do not describe it as a concession you chose — it is our published`,
                `rate for this volume.`,
              ];
        })()
      : [];

  const transcript =
    history.length === 0
      ? "(this is their first message)"
      : history
          .map((t) => {
            const who =
              t.role === "user" ? "CUSTOMER" : t.role === "agent" ? "US" : "NOTE";
            return `${who} (${t.channel}): ${t.content}`;
          })
          .join("\n\n");

  const known = [
    `Company: ${lead.company || "(not given)"}`,
    `Contact: ${lead.contactName || "(not given)"}`,
    `Seats mentioned so far: ${lead.seats === null ? "(not given)" : String(lead.seats)}`,
    `Product mentioned so far: ${lead.plan || "(not given)"}`,
    `Reply channel: ${lead.channel}`,
    /* Two facts, not one, and the order matters. The first stops a second document being
       raised; only the second licenses a reference number in the email. A DRAFT gets the
       first and is explicitly denied the second — that sentence is the whole fix for the
       31 Aug mail that handed a customer the id of an unsent quotation. */
    lead.deliveredQuoteId
      ? `Quotation ${lead.deliveredQuoteId} has been SENT to this customer. You may refer to it by that number.`
      : lead.existingQuoteId
        ? "A quotation is DRAFTED on this lead but has NOT been sent. Do not create a second one. " +
          "You have NOT been given a reference number — do not state one, and do not say a " +
          "quotation has been prepared."
        : "No quotation has been sent yet.",
  ].join("\n");

  const totals = held ? [] : (args.authorisedTotals ?? []);
  const totalLines =
    totals.length === 0
      ? "(none — you may not state a total or a multiplied figure, only the per-seat prices above)"
      : totals.map((t) => `- ${rupees(t)}`).join("\n");

  const brief = args.qualifierBrief ?? [];
  const recall = args.recallFacts ?? [];

  /* The register the customer wrote in, read from their own words rather than from the model's
     sentiment field — see lib/ai/tone.ts for why that distinction is load-bearing. Empty for a
     neutral message, so an ordinary enquiry produces exactly the prompt it did before. */
  const tone = toneLines(detectTone(incoming));

  const user = [
    `SELLER: ${sellerName}, signing as ${sellerEmail}`,
    "",
    /* Stage 1's verdict, ahead of everything else. See BuildPromptArgs.qualifierBrief. */
    ...(brief.length > 0 ? [...brief, ""] : []),
    /* R-2460: a held draft — what to say instead of its price. First, with the qualifier's
       brief, because it is an instruction and has to be read before any price is. */
    ...(held ? [...heldQuoteLines(held), ""] : []),
    /* HOW to answer, before WHAT is available to answer with. A register instruction read after
       the catalogue is an instruction the model applies to prose it has already planned. */
    ...(tone.length > 0 ? [...tone, ""] : []),
    /* The earlier call. Above the catalogue because it changes the opening line, not the
       pricing — see BuildPromptArgs.recallFacts. */
    ...(recall.length > 0 ? [...recall, ""] : []),
    "WHAT WE KNOW ABOUT THIS LEAD",
    known,
    "",
    "CATALOGUE (the only prices you may use)",
    catalogueLines.length > 0 ? catalogueLines.join("\n") : "(empty — you may not name any price)",
    "",
    /* The rate card, rendered from lib/pricing/volume-slabs.ts rather than written here, so
       the model can never be shown a slab the quote path does not apply. Same rule the
       telecaller's price block follows, and the same reason the catalogue is read at call
       time instead of pasted: a second copy of a money rule stops matching the first. */
    "VOLUME RATE CARD (the ONLY discounts you may offer — the quote applies these itself)",
    slabLines().join("\n"),
    "You do not decide a discount; you read it off this table by seat count. Never invent a",
    "percentage, never round one up, and never offer a discount to win an argument.",
    "",
    /* ── THE WORD "discount" NEVER TRAVELS ALONE ──────────────────────────────
       30 Aug 2026, live, 70 seats. The draft was correct and it was HELD:

         "For 70 seats, our published 5% reseller volume discount applies."      ← exempt
         "...Rs 3,078 per seat per year plus 18% GST after the discount."        ← HELD

       The promise guard masks a discount sentence only when THAT sentence names this deal's
       authorised percentage (`maskAuthorisedSellingPoints`). The first sentence carried "5%"
       and passed; the second said "the discount" with no figure, so the guard read it as a
       concession nobody approved and handed the whole reply to a human.

       The guard is right and must not be widened — an unnumbered discount promise is exactly
       what it exists to catch, and its own comments warn that loosening it is how a money
       guard dies. But it makes the reply a coin toss: the same authorised 5% sends or holds
       depending on whether the model happened to repeat the figure. The 100-seat reply an
       hour earlier said "5% ... discount band" in every mention and went out.

       So the rule moves here, where it costs nothing: carry the figure, or use another word.
       Same lesson as the block below — do not ask the model to remember, tell it what to
       write. */
    "THE WORD \"discount\" MUST NEVER APPEAR WITHOUT ITS PERCENTAGE IN THE SAME SENTENCE.",
    "Write \"the 5% volume discount\", never \"the discount\" or \"after the discount\". If a",
    "sentence refers back to it, say \"the volume rate\" or repeat the figure. A bare",
    "\"discount\" reads as a concession nobody approved, and the reply is held for a human —",
    "so the customer waits for a price that was already correct and already authorised.",
    "",
    /* ── STATE the slab, do not silently apply it ──────────────────────────────
       Measured on Q-ADPL-2026-27-0017: the email said "70 seats at Rs 3,240 per seat per
       year, plus 18% GST" — Rs 2,67,624 by the reader's own arithmetic — while the document
       totalled Rs 2,54,243, because the 5% band for 51–100 seats was applied to the quote and
       never mentioned in the words. Nothing was overcharged; the customer simply cannot
       reconcile the number, and 5% off list is a reason to buy that we were hiding.

       ─── FIRST ATTEMPT FAILED, AND THE REASON MATTERS ───
       On 26 Aug I first wrote this as an instruction: "when the table gives this seat count a
       discount, SAY SO". Deployed, verified live, and then Q-ADPL-2026-27-0018 went out for
       80 seats saying "Rs 3,240 per seat per year plus 18% GST" — the discount unmentioned
       again. The instruction asked the model to do three things: find the band for 80 seats,
       do the arithmetic, and remember to say it. Any one of them is a coin toss.

       So it is now a FACT, not an instruction — the app does the lookup and the arithmetic and
       hands over finished figures, exactly as `authorisedTotals` does for rupee totals. The
       model has nothing left to work out; it only has to repeat what it was given. Every
       money rule in this file that survived contact with a live message has this shape. */
    ...dealSlabLines,
    "",
    ...(domainFacts && domainFacts.length > 0
      ? [
          "WHAT THEIR DOMAIN SAYS TODAY (an observation — state it, do not go beyond it)",
          domainFacts.join("\n"),
          "You must NOT state:",
          ...MIGRATION_CLAIMS_FORBIDDEN.map((c) => `  - ${c}`),
          "",
        ]
      : []),
    ...(tradeIn.length > 0 ? [...tradeIn, ""] : []),
    ...(battlecards
      ? [
          "THIS MESSAGE RAISED AN OBJECTION. Handle it as follows.",
          battlecards.join("\n"),
          "",
        ]
      : []),
    "AUTHORISED TOTALS (already worked out for you — state these, never your own arithmetic)",
    totalLines,
    "",
    /* The net-cost block. Finished SENTENCES, not figures for the model to assemble — the same
       discipline as the totals above, and for a sharper reason: the brief for this asked the
       agent to compare us with buying direct from Google, quote a 3.5% card fee and price a
       free migration at ₹15,000. Those are claims about a competitor's tax treatment, about
       the customer's own bank, and about a product with no SKU. See lib/pricing/net-cost.ts.
       The model gets what our own invoice says and nothing else. */
    ...(offers.length > 0 ? [...offerLines({ candidates: offers, seats: lead.seats }), ""] : []),
    ...(netCostBlock
      ? [
          "WHAT THIS COSTS THEM, NET (state these sentences as written, or not at all)",
          netCostBlock.join("\n"),
          "Do NOT compare this with buying direct from any vendor, do NOT state what a card or",
          "bank charges, and do NOT put a rupee value on anything we include for free. You do",
          "not know their bank, their vendor's invoicing entity, or what migration is worth.",
        ]
      : []),
    "",
    "CONVERSATION SO FAR (oldest first)",
    transcript,
    "",
    "THEIR NEW MESSAGE",
    incoming.trim(),
  ].join("\n");

  return {
    system: SALES_AGENT_SYSTEM_PROMPT,
    user,
    // Retail per-seat figures PLUS the app-computed totals — see BuiltPrompt.allowedMoney
    // and BuildPromptArgs.authorisedTotals. Wholesale is deliberately absent from both.
    /* List rate AND every rate the volume card can produce for that item, from
       `authorisedRatesForItem` — the same function the quote path prices through.

       Both directions matter and both have burned this file before. A discounted rate the
       agent quotes CORRECTLY must not be flagged as unauthorised (that would hand over every
       21+ seat deal). And a rate the quote could never produce must not be authorised — 24 Aug
       is the whole reason: the guard's list was built from a different source than the draft
       and approved a below-cost figure. One function, both lists. */
    allowedMoney: [
      ...catalog.flatMap((c) =>
        authorisedRatesForItem(c.msrpPerSeatPerYear, c.wholesalePerSeatPerYear),
      ),
      ...totals,
      /* The net-cost figures, from the SAME computation that wrote the sentences above. A
         guard that flagged the payable amount it had just told the agent to state would hand
         over every quote that mentioned it. */
      ...(netCost?.figures ?? []),
      /* The cross-sell figures, from the SAME call that wrote the lines above. A guard that
         flagged the upgrade price it had just told the agent to state would hand over every
         reply that mentioned one — the "24/7"/"free" failure, in money. */
      ...authorisedOfferFigures(offers, catalog),
      /* The monthly-flex rate, for the same reason as every entry above it: the catalogue block
         now TELLS the agent this price, so a guard that then refused it would hand over every
         monthly reply — the feature dead on the day it shipped, which is the shape this file
         keeps having to relearn.

         Rate only, no multiples. A monthly TOTAL is `seats × rate`, and authorising totals here
         would put a figure in the list that `planQuoteFromEnquiry` never computed — the 24 Aug
         failure, where the guard's list came from a different source than the document. */
      ...catalog.flatMap((c) =>
        c.monthlyFlexPerSeatPerMonth !== null ? [c.monthlyFlexPerSeatPerMonth] : [],
      ),
    /* R-2460: a held draft's figures are struck out whatever produced them (a cross-sell or a
       1-seat rate that happens to equal one) — the strict direction: such a reply goes to a
       person rather than out with an unapproved price. */
    ].filter((n) => !heldFigures.has(Math.round(n))),
    authorisedTotals: [...totals],
  };
}

/* ── Validating what came back ───────────────────────────────────────────── */

/**
 * The schema is strict on the two fields that drive behaviour and forgiving on the two that
 * are only ever read by a person.
 *
 * `confidence_score` is clamped rather than rejected: a model that answers 1.2 has still told
 * us "very sure", and throwing that answer away would replace a usable signal with a retry.
 * `in_hours` is bounded at both ends for a harder reason — an unbounded value from the model
 * is a scheduling primitive under its control, and "follow up in 100000 hours" is a silently
 * dropped lead while "in 0 hours" is a nudge that arrives before the reply it follows.
 */
export const SALES_AGENT_SCHEMA = z.object({
  customer_intent: z.string().trim().min(1).max(300),
  perceived_sentiment: z.string().trim().min(1).max(120),
  confidence_score: z.coerce.number().finite().transform((n) => Math.min(1, Math.max(0, n))),
  action_required: z.enum(["REPLY", "GENERATE_QUOTE_AND_SEND", "HANDOVER_TO_HUMAN"]),
  /**
   * WHY the agent chose HANDOVER_TO_HUMAN, in its own words. Null otherwise.
   *
   * ─── THE HOUR THIS COST, 26 Aug 2026 ───────────────────────────────────────
   * A customer answered "monthly" on an 80-seat quotation. The agent handed over, and the
   * operator's log said:
   *
   *   "the agent was not confident enough to answer this itself"
   *
   * Its confidence was **0.95**, and the threshold is 0.7. That sentence is a FALLBACK used
   * whenever no overrule rule fired — so it fires exactly when the model chose to hand over
   * on its own judgement, and then reports the one thing that was not the reason. It sent me
   * looking at confidence thresholds for a while; the real reason was that the agent has no
   * monthly rate and correctly refused to invent one.
   *
   * Nullable and defaulted, not required: an older or terser model reply must still parse.
   * A missing reason costs a vaguer log line; a schema error costs the whole reply.
   */
  handover_reason: z.string().trim().min(1).max(300).nullable().default(null),
  generated_response: z.object({
    email_subject: z.string().trim().min(1).max(200),
    body_text: z.string().trim().min(1).max(8000),
    whatsapp_summary: z.string().trim().min(1).max(1200),
  }),
  next_followup_loop: z
    .object({
      in_hours: z.coerce.number().int().min(1).max(720),
      trigger_condition: z.string().trim().min(1).max(300),
    })
    .nullable()
    .default(null),
  seats_discussed: z.coerce.number().int().min(1).max(1_000_000).nullable().default(null),
  /* Naya field — purane model-output me absent hoga, isliye default null (tolerant). */
  term_discussed: z.enum(["annual", "annual_billed_monthly", "monthly_flex"]).nullable().default(null),
});

export type ParseResult =
  | { ok: true; decision: SalesAgentDecision }
  | { ok: false; reason: string };

/**
 * Turn whatever the model returned into a decision, or say why not.
 *
 * `reason` is a sentence, not a code, and it is the whole point of returning a result object
 * instead of throwing: this string ends up in the audit log and on the lead's timeline, where
 * "the model replied with no body text" is actionable and "validation failed" is not.
 */
export function parseSalesAgentDecision(raw: unknown): ParseResult {
  const parsed = SALES_AGENT_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "the response";
    return { ok: false, reason: `The AI's answer was not usable: ${where} — ${first?.message ?? "unknown problem"}.` };
  }
  return { ok: true, decision: parsed.data };
}

/* ── The rules that can overrule the model ───────────────────────────────── */

export interface HandoverInput {
  decision: SalesAgentDecision;
  /**
   * Seats as we understand them — the lead's own figure, or the model's read when the lead
   * has none. Passed in rather than taken from the decision so the caller decides which
   * source it trusts.
   */
  seats: number | null;
  /** Retail figures the prompt authorised, for the money guard. */
  allowedMoney: readonly number[];
  /**
   * The lead's REAL quotation id, or null when none exists.
   *
   * Without it a draft can tell a customer a quotation is ready when none is — measured
   * live on 30 Aug 2026. See lib/ai/quote-claim.ts.
   */
  quoteRef?: string | null;
}

export interface HandoverResult {
  decision: SalesAgentDecision;
  /** True when this function changed the action the model asked for. */
  overruled: boolean;
  /** One sentence for the operator and the log. Empty when nothing was overruled. */
  reason: string;
}

/**
 * Hide the two claims THIS FILE'S OWN PROMPT authorises, before the promise check reads them.
 *
 * ─── MEASURED ON THE FIRST REAL MESSAGE THIS AGENT EVER SAW, 24 Aug 2026 ────
 * A probe enquiry went through the live webhook. The agent read it correctly — intent right,
 * confidence 0.95 — wrote a good reply, and then its own guard refused to send it:
 *
 *   reply.send / held — 'The draft commits us to something nobody authorised — it says
 *   "24/7"; "free". A promise in our name needs a person behind it.'
 *
 * Both of those are things `SALES_AGENT_SYSTEM_PROMPT` explicitly tells it it MAY say:
 * "24/7 support from a named local team" and "Free migration of existing mail and data".
 * So the prompt authorised two phrases and the guard refused them — meaning every reply that
 * used the company's actual selling points handed over, which is close to every first reply.
 * The machinery was alive and the feature was practically dead.
 *
 * Why `findPromises` fires: `24/7` matches its DATE branch `\d{1,2}[/-]\d{1,2}` — it reads as
 * 24 July — and bare `free` matches its DISCOUNT branch, which is correct for "first month
 * free" and wrong here. Neither pattern is broken; they were written for the acknowledgement
 * path, where the safe reply promises NOTHING at all.
 *
 * ─── WHY MASK TWO PHRASES RATHER THAN DROP THE RULES ────────────────────────
 * Dropping `date` would let "we'll migrate everything by Friday" through, and dropping
 * `discount` would let "the first month is free" through. Those are the two the rule exists
 * for. So the exemption is exactly as wide as the prompt's own promise list and no wider:
 *
 *   · `24/7` (and 24x7) → always, because in a sales reply it never means a date
 *   · `free`            → ONLY inside a sentence that is also about migration
 *
 * The second condition is the important half. "Migration is free" is the authorised claim;
 * "the first month is free" in any other sentence is still caught, and there is a test
 * pinning that boundary. Same shape as `support-agent.ts`'s maskSupportIdioms, which exists
 * for the same reason on the support side.
 */
export function maskAuthorisedSellingPoints(
  text: string,
  /**
   * The rate card's OWN discount for this deal's seat count, or null when the slab gives
   * none. Passing it is what makes the third exemption below narrow enough to be safe —
   * without it, no discount sentence is ever exempt, which is the behaviour before 26 Aug.
   */
  authorisedDiscountPct?: number | null,
): string {
  /* Round-the-clock support. `24 x 7` and `24*7` included because a model writes all three. */
  let out = text.replace(/\b24\s*[/x*]\s*7\b/gi, "round-the-clock");

  /* Sentence by sentence, so "free" is exempt only where migration is the subject. Splitting
     on the punctuation KEEPS it (lookbehind), so re-joining reproduces the text exactly —
     a mask that reflows the body would change what the promise check reads elsewhere.

     `(?!\d)` — do NOT break on a full stop that sits inside a number. Found by this file's own
     test: without it "a 5.5% discount" splits into "a 5.5" + "5% discount…", and the second
     fragment then BEGINS with what looks like a whole authorised 5% — so a 5.5% concession the
     app never computed would have been excused by the rule below. The same trap applies here:
     a decimal could push "free" out of the migration sentence it belongs to. */
  const sentences = (s: string): string[] => s.split(/(?<=[.!?\n])(?!\d)/);

  out = sentences(out)
    .map((sentence) =>
      /\bmigrat/i.test(sentence) ? sentence.replace(/\bfree\b/gi, "included") : sentence,
    )
    .join("");

  /* ── THIRD EXEMPTION: the rate card's own volume discount (26 Aug 2026) ─────
     The prompt now REQUIRES the reply to name the slab it applied, because a quotation whose
     arithmetic the reader cannot follow is one they have to query — measured on
     Q-ADPL-2026-27-0017, where the words said Rs 3,240 + 18% GST and the document totalled
     Rs 2,54,243 after an unmentioned 5%.
     Without this mask that instruction would hand over EVERY discounted quotation, exactly as
     "24/7" and "free migration" once did. The prompt authorising a phrase and the guard
     refusing it is the same dead-feature shape this function was written to fix.

     ⚠️ HOW NARROW, AND WHY THAT MATTERS MORE THAN THE FEATURE:
     the sentence must name THIS deal's authorised percentage. So:

       "5% volume discount for 51–100 seats"  slab 5  → exempt
       "I can give you a discount"            no pct  → still holds
       "10% off for you"                      slab 5  → still holds
       "5% discount"                          slab 0  → still holds (nothing authorised)

     A discount the model invented, rounded up, or offered to win an argument is refused as
     before. Only the figure the APP itself computed and applied to the document is excused,
     which is the same principle as `allowedMoney`: the guard trusts a number the app derived,
     never one the model chose. */
  if (typeof authorisedDiscountPct === "number" && authorisedDiscountPct > 0) {
    /* The lookbehind is the whole guard, and the test that demanded it is worth keeping in
       mind: `\b5\s*%` MATCHES "5.5%" — the boundary sits between the dot and the second 5, so
       an authorised 5 would have excused a 5.5% concession the app never computed. Exactly
       the widening this file warns about elsewhere, found by its own test.

       So: no digit and no decimal point may precede the figure. The slabs are whole percents;
       anything with a fraction in it did not come from `slabFor`. */
    const pct = new RegExp(
      String.raw`(?<![\d.])${authorisedDiscountPct}\s*(?:%|per\s*cent\b|percent\b)`,
      "i",
    );
    out = sentences(out)
      .map((sentence) =>
        pct.test(sentence)
          ? sentence.replace(/\bdiscount(?:s|ed|ing)?\b/gi, "volume rate")
          : sentence,
      )
      .join("");
  }

  return out;
}

/**
 * Apply the rules the model does not get a vote on.
 *
 * ─── IT CAN ONLY EVER MAKE THE ACTION STRICTER ──────────────────────────────
 * REPLY and GENERATE_QUOTE_AND_SEND can become HANDOVER_TO_HUMAN. Nothing here can turn a
 * handover back into a send. That direction is deliberate and worth stating because the
 * opposite is the easy bug: a later rule that "recovers" a handover because some other check
 * passed would quietly undo the model's own decision to be careful, which is the one
 * judgement it is best placed to make.
 *
 * ─── WHY THE MONEY GUARD RUNS HERE AND NOT AT SEND TIME ─────────────────────
 * A draft carrying an unauthorised rupee figure must never become a held draft that a tired
 * operator taps "send" on. Catching it at decision time means the wrong number is never
 * written into anything anybody can approve.
 */
export function applyHandoverRules(input: HandoverInput): HandoverResult {
  const { decision, seats, allowedMoney } = input;

  const handover = (reason: string): HandoverResult => ({
    decision: {
      ...decision,
      action_required: "HANDOVER_TO_HUMAN",
      // A handover schedules no nudge. The lead is a person's problem now, and an automated
      // follow-up landing on top of a human conversation is worse than no follow-up.
      next_followup_loop: null,
    },
    overruled: true,
    reason,
  });

  if (decision.action_required === "HANDOVER_TO_HUMAN") {
    return { decision, overruled: false, reason: "" };
  }

  const effectiveSeats = seats ?? decision.seats_discussed;
  if (effectiveSeats !== null && effectiveSeats > HANDOVER_SEAT_CEILING) {
    return handover(
      `${effectiveSeats} seats is above the ${HANDOVER_SEAT_CEILING}-seat ceiling for automatic quoting — the discount conversation on a deal this size is a person's job.`,
    );
  }

  if (decision.confidence_score < MIN_AUTONOMOUS_CONFIDENCE) {
    return handover(
      `The AI rated its own understanding ${decision.confidence_score.toFixed(2)}, below the ${MIN_AUTONOMOUS_CONFIDENCE} needed to answer a customer unattended.`,
    );
  }

  // Both customer-visible surfaces are checked. The WhatsApp summary is a separate piece of
  // text the model wrote separately, so a figure can be right in one and wrong in the other.
  for (const [label, text] of [
    ["email", decision.generated_response.body_text],
    ["WhatsApp summary", decision.generated_response.whatsapp_summary],
  ] as const) {
    const money = verifyDraftMoney(text, allowedMoney);
    if (!money.ok) {
      return handover(
        `The draft's ${label} names a price we did not authorise (${money.violations.join(", ")}) — every figure must come from the catalogue.`,
      );
    }
  }

  /* ─── Promise check, MINUS two of its five rules, and the reason matters ───
     findPromises was built for the acknowledgement path, where the safe answer promises
     NOTHING — so it runs verifyDraftMoney with an EMPTY allow-list and flags every currency
     figure, plus every percentage.

     Applied unchanged to a sales draft, it would fire on literally every useful reply: a
     quotation email states a price (authorised, and already checked against the catalogue
     three lines up) and says "18% GST" (a statutory rate, not a concession). The agent would
     hand over 100% of the time and the feature would be dead on arrival — which is exactly
     the "guard that gets switched off within a week" that money-guard.ts warns about.

     So the money and percent rules are dropped HERE, deliberately and narrowly, because
     something stricter already covers money on this path. The three that survive are the ones
     no authorised price list can excuse: a DATE we would have to meet, a DISCOUNT nobody
     approved, and a GUARANTEE we never gave. */
  const RELEVANT_PROMISE_KINDS = new Set(["date", "discount", "guarantee"]);
  /* This deal's authorised slab percent, read from the SAME `slabFor` the quote path uses —
     never a number written here. If those two ever disagreed, the guard would either refuse a
     discount the document applied or excuse one it did not. */
  const slabHere = effectiveSeats !== null ? slabFor(effectiveSeats) : null;
  const authorisedDiscountPct =
    slabHere && slabHere.kind === "slab" ? slabHere.slab.percent : null;

  const promises = findPromises(
    /* The prompt's own promise list, hidden from the check that would refuse it. Measured on
       the first live message: without this, "24/7" and "free migration" handed over every
       reply. See maskAuthorisedSellingPoints. */
    maskAuthorisedSellingPoints(decision.generated_response.body_text, authorisedDiscountPct),
  ).findings.filter((f) => RELEVANT_PROMISE_KINDS.has(f.kind));
  if (promises.length > 0) {
    const what = promises.map((f) => `"${f.matched}"`).slice(0, 3).join("; ");
    return handover(
      `The draft commits us to something nobody authorised — it says ${what}. A promise in our name needs a person behind it.`,
    );
  }

  /* ── DOES IT SAY A QUOTATION EXISTS THAT DOES NOT? (30 Aug 2026) ──────────
     Live, to a real address: "The quotation for 40 seats ... has been prepared at Rs 325
     per seat per month". No quotation existed — the auto-quote had correctly refused
     because the mail's product name did not match the catalogue, and the agent was never
     told. The facts block said "No quotation has been sent yet" and the draft said the
     opposite, with a price beside it.

     Unlike the money and promise checks this is not about what we PROMISED — it is about
     what we said had already happened. A customer who asks for that document gets nothing,
     and the sentence they were sent had a rupee figure in it.

     Prompt fixed too, but a prompt is a request; twice today an instruction alone was a
     coin toss. See lib/ai/quote-claim.ts for why future tense is deliberately allowed. */
  const unbacked = unbackedQuoteClaim(decision.generated_response.body_text, input.quoteRef);
  if (unbacked) {
    return handover(
      `The draft tells the customer a quotation exists — it says "${unbacked}" — and none does. ` +
      `Draft the quote first, or say what you will do instead of what you have done.`,
    );
  }

  /* ── Does the draft run down what the customer already has? ──
     LAST in the chain and NOT masked, unlike the promise check above. Nothing in this agent's
     authorised list contains a word from the pejorative set, so there is no equivalent of the
     "24/7"/"free" problem to exempt — and masking here would be masking the only signal.

     It runs on the raw body for the same reason: `maskAuthorisedSellingPoints` rewrites "free"
     to "included" inside migration sentences, and a sentence about migration is exactly where
     a jab at the old provider is most likely to sit. */
  const runDown = findDisparagement(decision.generated_response.body_text);
  if (!runDown.clean) return handover(runDown.reason);

  return { decision, overruled: false, reason: "" };
}

/**
 * Should this decision actually produce a quotation?
 *
 * Separate from the action so the reason survives into the log: "the model asked for a quote
 * but did not have a seat count" is a different operational fact from "the model chose to
 * reply".
 */
export function quoteIsWarranted(decision: SalesAgentDecision, seats: number | null): boolean {
  if (decision.action_required !== "GENERATE_QUOTE_AND_SEND") return false;
  const effective = seats ?? decision.seats_discussed;
  return effective !== null && effective > 0 && effective <= HANDOVER_SEAT_CEILING;
}

/* ── The totals the app works out for the agent ───────────────────────────── */

/**
 * The one total the agent may state before any quote exists: seats × the catalogue price.
 *
 * PURE, and it does the arithmetic the model is not trusted with — that is the whole point.
 * Returns empty whenever anything is missing (no seats, no product, product not in the
 * catalogue), because an empty authorised list means "state no total", which is the strict
 * direction.
 *
 * Exact name match against the catalogue, no fuzzy matching — the same rule
 * `quote-dispatcher.ts`'s `resolveItem` follows, and for the same reason: a near-miss here
 * would authorise a figure computed from the WRONG product's price, which is worse than
 * authorising nothing.
 */
export function authorisedTotalsFor(
  catalog: readonly SalesCatalogEntry[],
  lead: { plan: string | null; seats: number | null },
): number[] {
  if (!lead.plan || lead.seats === null || lead.seats <= 0) return [];
  const item = catalog.find((c) => c.name === lead.plan);
  if (!item) return [];
  return [item.msrpPerSeatPerYear * lead.seats];
}

/**
 * What this lead would actually pay, and what they could reclaim of it.
 *
 * ─── ONE COMPUTATION, THREE CONSUMERS ───────────────────────────────────────
 * The sentences the agent may state, the figures the money guard authorises, and the
 * arithmetic behind both come from here. Building the allow-list separately from the prose is
 * how 24 Aug happened: the guard measured a draft against numbers from a different source and
 * approved one below our own cost.
 *
 * The seat count and product come off the LEAD, the rate comes off the catalogue read at call
 * time, and the discount comes off the volume rate card. So the net-cost block cannot disagree
 * with the quote the same lead would produce — they are the same three inputs.
 *
 * Returns null when there is nothing to price yet: no product, no seat count, or a product
 * that is not in this tenant's catalogue. A "net cost" for a deal whose shape nobody knows
 * would be a confident number about nothing.
 */
export function netCostFactsFor(
  catalog: readonly SalesCatalogEntry[],
  lead: { plan: string | null; seats: number | null; gstin?: string | null },
  sellerName: string,
): { lines: string[]; figures: number[] } | null {
  if (!lead.plan || lead.seats === null || lead.seats <= 0) return null;
  const item = catalog.find((c) => c.name === lead.plan);
  if (!item) return null;

  const slab = slabFor(lead.seats);
  const priced =
    slab.kind === "slab"
      ? discountedRate(item.msrpPerSeatPerYear, slab.slab.percent, item.wholesalePerSeatPerYear)
      : { appliedPercent: 0 };

  const net = computeNetCost({
    subtotal: item.msrpPerSeatPerYear * lead.seats,
    discountPct: priced.appliedPercent,
    /* 18% — SaaS under HSN 998313 (CLAUDE.md §13), the same rate the quote writes. */
    taxRate: 18,
    buyerGstin: lead.gstin,
  });

  return { lines: netCostLines(net, sellerName), figures: authorisedNetCostFigures(net) };
}
