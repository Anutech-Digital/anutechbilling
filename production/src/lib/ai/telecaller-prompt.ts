/**
 * What the voice agent is, what it may say, and what it is handed before it dials.
 *
 * Pure — no env, no database, no clock. Everything the persona needs arrives as arguments so
 * the prompt can be asserted in a test, which is the only way to notice that a rule quietly
 * stopped being in it.
 *
 * ─── THE PRICES ARE NOT IN THIS FILE, AND THAT IS THE POINT ─────────────────
 * The brief listed them: "Google Workspace (Starter Rs 270/mo, Standard Rs 750/mo)". Two of
 * those three numbers are a problem, and both were measured against the live catalogue on
 * 25 Aug 2026 rather than argued about:
 *
 *   · Starter is Rs 270/seat/month — correct, today.
 *   · Standard is Rs 864 per seat per month, not Rs 750. Quoting 750 undersells it by Rs 114 a
 *     seat a month: on a 12-seat deal that is Rs 16,416 a year given away, spoken aloud, by a
 *     machine, with nobody in the room.
 *   · And the deeper failure is not the wrong figure — it is that a figure lives in a source
 *     file at all. `GW-STD-fbb` was Rs 750 at some point and is Rs 864 now. Whichever number
 *     were pasted here would be right on the day it was written and silently wrong afterwards,
 *     and no test can catch that because the file would agree with itself.
 *
 * This is not a new lesson in this codebase, it is the same one twice. On 24 Aug 2026 the
 * sales agent quoted a TWELFTH of every price because `loadSalesCatalog` copied a monthly
 * figure into a field named per-year — and `verifyDraftMoney` approved it, because its
 * allow-list came from the same wrong source. See sales-agent.ts's MONTHS_PER_YEAR comment.
 * `quote-builder.tsx` still holds a hardcoded plan→price map that disagrees with the
 * catalogue on 8 of 8 lines; it survives only because it is an unreachable fallback, and
 * TASKS.md lists removing it as outstanding work.
 *
 * So the catalogue is READ at call time and rendered into the prompt as an authorised fact.
 * The persona below describes the SHAPE of what may be said about price; the numbers come
 * from `items`, the same row the quote is built from.
 *
 * ─── AND IT MAY NOT DO ARITHMETIC ───────────────────────────────────────────
 * The agent states a per-seat rate. It never states a total. That rule was learned on the
 * email side (`authorisedTotalsFor` — the app computes the total and hands it over as a fact)
 * and it binds harder here: an email total can be corrected in the next email, and a total
 * said on the phone is the number the customer writes down.
 */
import type { SalesCatalogEntry } from "./sales-agent";
import type { TelecallType } from "./telecall";

/** Rs, whole rupees, Indian digit grouping. Paise are not stored anywhere in this app. */
function rupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

/**
 * The agent's name, and why it is a constant rather than a literal in the prompt string.
 *
 * The customer will use it — "Priya said we get a GST invoice". It has to be the same name on
 * the call, in the follow-up WhatsApp, and on whatever the desk sees, so it is defined once
 * and the routes pass it into the follow-up message too.
 */
export const TELECALLER_NAME = "Priya";

/**
 * What the agent may claim about the business.
 *
 * These are the three the brief asked for, and each is a fact about how this reseller
 * operates rather than a promise about an outcome — that distinction is what keeps them
 * sayable. "You get a GST invoice" is a thing we do; "you will save money" is a thing we would
 * be committing to. The sales agent's `findPromises` draws the same line on email, and its
 * `maskAuthorisedSellingPoints` exists because the guard once refused the company's own
 * selling points.
 */
export const AUTHORISED_SELLING_POINTS: readonly string[] = [
  "a proper GST invoice from an Indian company, so the input tax credit can be claimed",
  "support from a local team in India, in the same time zone and in Hindi or English",
  "billing in rupees, so there is no foreign-exchange mark-up on the card statement",
];

/**
 * The dynamic variables handed to the voice provider.
 *
 * Named exactly as the brief specified — Retell and Vapi both interpolate `{{name}}` from a
 * flat string map, so these become the literal keys in the agent's script.
 *
 * All strings, including `pending_amount`. The provider renders whatever it is given into
 * speech, and a raw number gets read out as digits — "one zero three six eight". The app
 * formats it, once, here, so the money is spoken the way an Indian customer expects to hear it
 * and so there is only one place where that formatting could be wrong.
 */
export interface TelecallDynamicVariables {
  customer_name: string;
  subscription_expiry_date: string;
  pending_amount: string;
  /** Empty string when unknown — never the word "null", which providers happily read aloud. */
  current_plan: string;
  seat_count: string;
  agent_name: string;
  company_name: string;
  [key: string]: string;
}

export interface BuildTelecallPromptArgs {
  callType: TelecallType;
  sellerName: string;
  /** The person being rung. Blank falls back to a neutral address rather than "null". */
  customerName: string | null;
  /** What they are on today, if anything. */
  currentPlan: string | null;
  seats: number | null;
  /** Renewal calls only. ISO date; rendered for speech. */
  renewalDate: string | null;
  /** Renewal calls only. Whole rupees, computed by the app — never by the agent. */
  pendingAmount: number | null;
  /** Read from `items` at call time. See the header for why it is not in this file. */
  catalogue: readonly SalesCatalogEntry[];
  /**
   * R-1663: a cold call — the person never enquired. `product` is what the campaign is for
   * (null = let them say what they need).
   */
  coldCall?: { product: string | null; callback?: boolean } | null;
}

export interface BuiltTelecallPrompt {
  systemPrompt: string;
  dynamicVariables: TelecallDynamicVariables;
  /**
   * Every rupee figure the agent was authorised to say, for the post-call transcript check.
   * Built from the SAME catalogue array the prompt was rendered from, so the guard and the
   * agent cannot disagree — that disagreement is exactly what let a below-cost price through
   * on 24 Aug.
   */
  authorisedFigures: number[];
}

/** "2026-09-14" → "14 September 2026". Spoken dates must not be read out as digits. */
export function spokenDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ── The persona ─────────────────────────────────────────────────────────── */

function personaBlock(sellerName: string): string {
  return [
    `You are ${TELECALLER_NAME}, calling on behalf of ${sellerName}, an Indian IT reseller.`,
    "You are a real member of the sales desk, not a recording and not a menu.",
    "",
    "HOW YOU SPEAK",
    "- Conversational Indian English, and natural Hinglish when the customer switches to it.",
    "  Match them; do not start in Hindi with somebody who opened in English.",
    "- Short sentences. This is a phone call, not a brochure. One question at a time, then stop",
    "  and let them answer.",
    "- Say who you are and which company you are from in your first sentence, before anything",
    "  else. A caller who takes thirty seconds to identify themselves sounds like a scam, and",
    "  in India that call gets cut.",
    "- If they ask whether you are a human or an AI, tell them plainly that you are an AI",
    "  assistant from the sales desk and offer to have a colleague ring them. Never deny it.",
    "  A denial that is later discovered costs the whole relationship, and it is also simply a",
    "  lie told in the company's name.",
    "- If they say it is a bad time, ask when to call back, thank them, and end the call.",
    "  If they ask not to be called again, confirm that you will record it and end the call.",
    "",
    /* Abhishek, 20 Oct 2026: real calls sounded robotic — this block is the conversation craft. */
    "SOUND LIKE A PERSON, NOT A SCRIPT",
    "- One or two short sentences per turn — about one breath each. Then stop and listen.",
    "- Begin most replies with a small acknowledgement of what they just said — 'Achha',",
    "  'Ji', 'Theek hai', 'Samajh gayi', 'Bilkul' — and vary it; never the same one twice in a row.",
    "- Answer their question first, in one line, and only then ask yours.",
    "- If they start talking while you are speaking, stop and listen. Do not repeat yourself",
    "  from the start; pick up from what they said.",
    "- Say numbers the way people say them: 'bees users', 'paanch log' — not digit by digit.",
    "- Use their name at most once or twice in the whole call, not in every line.",
    "- Never read out lists or options ('option one, option two'). Ask one simple question.",
    "- No long apologies, no 'as an AI', no 'I understand your concern'. Warm, brief, done.",
    "- If they ask where we got their number: say it is from a business listing, and offer to",
    "  take them off our list if they prefer. If they say yes, confirm it and end the call.",
    "- If they ask what this is about: one line on what we do for businesses like theirs, then",
    "  one question. Do not pitch features.",
    "- Close in one line: repeat the next step ('quote WhatsApp par bhej rahi hoon'), thank",
    "  them, and say goodbye. Do not keep talking after they have said bye.",
  ].join("\n");
}

function moneyRules(catalogue: readonly SalesCatalogEntry[]): string {
  if (catalogue.length === 0) {
    /* An empty catalogue is a real state — a fresh tenant, or a failed read. The agent must
       then be unable to discuss price at all, rather than fall back on anything it happens to
       know about Google Workspace pricing from training. */
    return [
      "MONEY",
      "- You have NO price list on this call. You may not state, estimate, confirm or agree to",
      "  any price, discount or total, even if the customer says a number and asks you to",
      "  confirm it. Say that you will have the exact pricing sent across in writing.",
    ].join("\n");
  }

  const lines = catalogue.map(
    (c) => `  - ${c.name} (${c.vendor}): ${rupees(c.msrpPerSeatPerYear)} per seat per year`,
  );

  return [
    "MONEY — READ THIS TWICE",
    "These are the ONLY prices you may say out loud, and you must say them exactly as written,",
    "including the words 'per seat per year':",
    ...lines,
    "",
    "- Do NOT multiply. Do NOT add. Do NOT give a total, an annual bill, a monthly equivalent",
    "  or an 'approximately'. If they ask what it comes to for their team, say: 'I will have",
    "  the exact total sent to you in writing along with the GST' — and then do that.",
    "- Do NOT offer a discount, a free month, a price match or a trial extension. You have no",
    "  authority over price. If they push, say a colleague will call about pricing.",
    "- If a number is not on the list above, you do not know it. Saying it on a call cannot be",
    "  taken back.",
  ].join("\n");
}

function objectiveBlock(callType: TelecallType): string {
  if (callType === "renewal_reminder") {
    return [
      "WHY YOU ARE CALLING",
      "{{customer_name}}'s subscription is due to renew on {{subscription_expiry_date}}.",
      "You are calling so it does not lapse by accident — a lapsed workspace means mail stops.",
      "",
      "WHAT YOU NEED TO COME AWAY WITH, in this order:",
      "1. Do they want to continue? Yes, no, or thinking about it.",
      "2. Are they keeping the same number of seats, or has the team grown or shrunk?",
      "3. May we send the renewal quotation on WhatsApp to this number, or would they prefer",
      "   email?",
      "",
      "If there is an outstanding amount, it is {{pending_amount}}. You may state that figure",
      "because the office calculated it — but you may not recalculate it, add GST to it, or",
      "quote a new total on top of it.",
      "",
      "If they say they are cancelling, do not argue and do not counter-offer. Ask, once, what",
      "prompted it, thank them, and say a colleague will call.",
    ].join("\n");
  }

  return [
    "WHY YOU ARE CALLING",
    "{{customer_name}} enquired with us about business email or a cloud workspace.",
    "You are calling to understand what they need so the right quotation can be sent.",
    "",
    "WHAT YOU NEED TO COME AWAY WITH, in this order:",
    "1. HOW MANY SEATS — how many people need an account. This is the one that matters most;",
    "   without it nothing can be quoted, and asking them again later wastes their time.",
    "2. Which product family — Google Workspace, Microsoft 365, or Zoho — and whether they",
    "   already use something today that would need migrating.",
    "3. Roughly when they want it live.",
    "4. May we send the quotation on WhatsApp to this number, or would they prefer email?",
    "",
    "Ask for the seat count plainly: 'How many people would need an email account?'",
    "If they genuinely do not know, ask for their best estimate and say the quotation can be",
    "adjusted. Do not invent a number, and do not read their silence as a number.",
  ].join("\n");
}

function boundaryBlock(): string {
  return [
    "WHAT YOU MAY CLAIM ABOUT US",
    ...AUTHORISED_SELLING_POINTS.map((p) => `- ${p}`),
    "",
    "WHAT YOU MAY NEVER DO",
    "- Never promise a date for anything — delivery, migration, activation, a callback time.",
    "  You do not control any of those calendars.",
    "- Never read out, spell out or confirm a technical record value: no MX host, no SPF",
    "  include, no DKIM key, no port, no nameserver. A wrong record read over the phone takes",
    "  a customer's mail down, and they will follow it exactly because we said it. If they ask,",
    "  say the exact values will come in writing from their own admin console.",
    "- Never ask for a password, an OTP, a card number, a UPI PIN or any bank detail, and never",
    "  accept one if the customer starts to read it out. Stop them and say the office will send",
    "  a proper payment link. Nothing on this call is a payment.",
    "- Never claim to be from Google, Microsoft or Zoho. You are from the reseller.",
    "- Never agree that something is 'included' or 'free' unless it is on the list above.",
    "",
    "ENDING THE CALL",
    "Say back what you understood — the seat count, the product, and how the quotation is",
    "coming — and confirm it before you hang up. If you did not get the seat count, say so",
    "rather than papering over it; a colleague will call back.",
  ].join("\n");
}

/**
 * Build the whole call: the script, the variables, and the figures the agent is allowed to
 * say. One function so the three cannot drift apart — the authorised list is derived from the
 * same catalogue array that produced the price lines in the prompt.
 */
/** R-1663: the person did NOT enquire — say who we are and why, once, then qualify or leave. */
function coldCallBlock(product: string | null, callback = false): string {
  const what = product?.trim() || "business email and cloud workspace (Google Workspace, Microsoft 365 or Zoho)";
  if (callback) {
    return [
      "WHY YOU ARE CALLING",
      `This is a CALL BACK. On an earlier call about ${what}, {{customer_name}} asked us to call`,
      "again later. Say so in one sentence and ask if now is a good time.",
      "If it is still not a good time, ask once when would suit, thank them and end the call.",
      "",
      "IF THEY ARE OPEN TO IT, COME AWAY WITH, in this order:",
      "1. HOW MANY people would need an account.",
      "2. What they use today, if anything.",
      "3. Their city or state.",
      "4. May we send a quotation on WhatsApp to this number, or would they prefer email?",
      "",
      "If they are not interested, do not push: thank them and end the call.",
    ].join("\n");
  }
  return [
    "WHY YOU ARE CALLING",
    "This is a COLD CALL. {{customer_name}} has NOT enquired with us — never say they did.",
    `In one sentence, say who you are and that you are calling about ${what} for their business.`,
    "Then ask whether it is a good moment and whether they handle this for their company.",
    "If they say it is the wrong person, ask once who handles it; if they do not want to say,",
    "thank them and end the call.",
    "",
    "IF THEY ARE OPEN TO IT, COME AWAY WITH, in this order:",
    "1. HOW MANY people would need an account.",
    "2. What they use today, if anything.",
    "3. Their city or state.",
    "4. May we send a quotation on WhatsApp to this number, or would they prefer email?",
    "",
    "If they are not interested, do not push: thank them and end the call.",
  ].join("\n");
}

export function buildTelecallPrompt(args: BuildTelecallPromptArgs): BuiltTelecallPrompt {
  const { callType, sellerName, catalogue } = args;

  const systemPrompt = [
    personaBlock(sellerName),
    "",
    args.coldCall ? coldCallBlock(args.coldCall.product, args.coldCall.callback) : objectiveBlock(callType),
    "",
    moneyRules(catalogue),
    "",
    boundaryBlock(),
  ].join("\n");

  const pendingAmount = args.pendingAmount;

  const dynamicVariables: TelecallDynamicVariables = {
    /* "there" rather than an empty string: the script says "Am I speaking with
       {{customer_name}}?", and an empty variable makes the agent's first sentence
       ungrammatical on exactly the calls where we know least about the customer. */
    customer_name: args.customerName?.trim() || "there",
    subscription_expiry_date: spokenDate(args.renewalDate),
    pending_amount:
      pendingAmount !== null && Number.isFinite(pendingAmount) && pendingAmount > 0
        ? rupees(pendingAmount)
        : "",
    current_plan: args.currentPlan?.trim() || "",
    seat_count: args.seats !== null && args.seats > 0 ? String(args.seats) : "",
    agent_name: TELECALLER_NAME,
    company_name: sellerName,
  };

  const authorisedFigures = catalogue.map((c) => Math.round(c.msrpPerSeatPerYear));
  /* The outstanding amount is a figure the APP computed and explicitly handed to the agent, so
     it is authorised to be said — and the post-call check must know that, or it would flag the
     one number on the call that is certainly right. */
  if (pendingAmount !== null && Number.isFinite(pendingAmount) && pendingAmount > 0) {
    authorisedFigures.push(Math.round(pendingAmount));
  }

  return { systemPrompt, dynamicVariables, authorisedFigures };
}
