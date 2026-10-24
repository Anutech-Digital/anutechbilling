// Not wired yet — R-1608 (built, kept for later)
/**
 * Filling a lawyer's agreement template with facts — and never writing a clause.
 *
 * ─── WHAT THIS MODULE WILL NOT DO, AND WHY IT IS NOT SQUEAMISHNESS ──────────
 * The brief asks the AI to "automatically Service Level Agreement (SLA) & Master Services
 * Agreement (MSA) PDF generate kare". Generating the DOCUMENT is built here. Generating its
 * CLAUSES is not, and the reason is arithmetic rather than caution.
 *
 * An MSA fixes liability, indemnity, termination, IP ownership, data-protection duties and
 * jurisdiction. An SLA fixes availability and what it costs us when availability is missed.
 * Those are not descriptions of a deal, they are the deal's downside — and a model-written
 * clause is a binding obligation nobody read.
 *
 * MEASURED, on this tenant's real catalogue and a 30-seat Business Starter deal:
 *
 *   customer pays ......................... Rs 8,100 / month  (30 x Rs 270)
 *   our margin ............................ Rs 4,800 / month  (30 x Rs 160)
 *   a 99.0-99.9% month at 15% credit ...... Rs 1,215  =  25% of that margin
 *   a 95-99% month at 25% credit .......... Rs 2,025  =  42% of that margin
 *   a sub-95% month at 50% credit ......... Rs 4,050  =  84% of that margin
 *
 * That is Google's own service-credit schedule, applied to OUR invoice. One bad month upstream
 * takes most of a month's margin — for downtime we neither cause nor control. And there is no
 * recourse behind it: TASKS.md:1564 records the Google reseller agreement as NOT APPROVED, so
 * today we could owe credits with nothing to claim back. An uptime commitment is a promise about
 * somebody else's datacentre, underwritten by a reseller's margin.
 *
 * So: the legal text is a FILE A LAWYER SUPPLIES. This module fills the blanks in it with facts
 * the application already holds, refuses to render when any fact is missing, and proves it added
 * nothing — see `verifyOnlySlotsChanged`. That is the same discipline every money path in this
 * repo follows: figures come from the catalogue, prose comes from a human, and the app does the
 * joining.
 *
 * ─── AND A HALF-FILLED CONTRACT IS WORSE THAN NO CONTRACT ───────────────────
 * A signed agreement still reading "{{CUSTOMER_GSTIN}}" is a document whose terms are arguable
 * and whose party is unidentified. `fillTemplate` fails closed on any unresolved slot rather
 * than shipping a blank, because a quotation with a gap gets corrected and a contract with a gap
 * gets litigated.
 */

/* ── Slots ────────────────────────────────────────────────────────────────── */

/**
 * Every blank an agreement template may contain. Facts only — no clause text, ever.
 *
 * Deliberately a closed list. An open `Record<string, string>` would let a caller invent a slot
 * called `LIABILITY_CAP` and fill it from anywhere, which is exactly the door this module exists
 * to shut.
 */
export const AGREEMENT_SLOTS = [
  "SELLER_LEGAL_NAME",
  "SELLER_GSTIN",
  "SELLER_ADDRESS",
  "CUSTOMER_LEGAL_NAME",
  "CUSTOMER_GSTIN",
  "CUSTOMER_ADDRESS",
  "PRODUCT_NAME",
  "SEAT_COUNT",
  "RATE_PER_SEAT_PER_YEAR",
  "BILLING_TERM",
  "QUOTE_REFERENCE",
  "AGREEMENT_DATE",
  "TERM_MONTHS",
] as const;

export type AgreementSlot = (typeof AGREEMENT_SLOTS)[number];

/** `{{SLOT_NAME}}`. Double braces so a stray single brace in legal prose is not a slot. */
const SLOT_RE = /\{\{([A-Z_]+)\}\}/g;

export type SlotValues = Partial<Record<AgreementSlot, string>>;

/* ── Filling ──────────────────────────────────────────────────────────────── */

export type FillResult =
  | { ok: true; text: string; filled: readonly AgreementSlot[] }
  | { ok: false; reason: string; missing: readonly string[] };

/**
 * Substitute every slot in a template, or refuse.
 *
 * ─── FAILS CLOSED, IN BOTH DIRECTIONS ───────────────────────────────────────
 * A slot the template needs and the caller did not supply is a refusal, not a blank. A slot the
 * CALLER supplied that the template does not contain is also a refusal — it means the two are
 * out of step, and silently ignoring a value somebody thought they were putting into a contract
 * is how the wrong seat count ends up unnoticed.
 *
 * An unknown slot name in the template is a refusal too. `{{LIABILITY_CAP}}` in a file means
 * somebody expects this module to fill in a legal term, and the honest answer is that it will
 * not.
 */
export function fillTemplate(template: string, values: SlotValues): FillResult {
  const found: string[] = [];
  for (const m of template.matchAll(SLOT_RE)) found.push(m[1]);
  const inTemplate = [...new Set(found)];

  const unknown = inTemplate.filter((s) => !(AGREEMENT_SLOTS as readonly string[]).includes(s));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `This template asks for ${unknown.join(", ")}, which is not a fact this application ` +
        "holds. If it is a legal term it belongs in the lawyer's text, not in a blank for " +
        "software to fill.",
      missing: unknown,
    };
  }

  const missing = inTemplate.filter((s) => {
    const v = values[s as AgreementSlot];
    return v === undefined || v.trim() === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `Cannot prepare the agreement — ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        "missing. A signed contract with a blank in it has an arguable term and possibly an " +
        "unidentified party, so nothing is rendered until every field is known.",
      missing,
    };
  }

  const supplied = Object.entries(values)
    .filter(([, v]) => typeof v === "string" && v.trim() !== "")
    .map(([k]) => k);
  const unused = supplied.filter((s) => !inTemplate.includes(s));
  if (unused.length > 0) {
    return {
      ok: false,
      reason:
        `The template has no place for ${unused.join(", ")}, so ${unused.length === 1 ? "it would" : "they would"} ` +
        "be silently dropped. On a contract that is not a tidiness problem — a seat count nobody " +
        "notices is missing is the one that ends up disputed.",
      missing: unused,
    };
  }

  const text = template.replace(SLOT_RE, (_, name: string) => values[name as AgreementSlot] as string);
  return { ok: true, text, filled: inTemplate as AgreementSlot[] };
}

/* ── Proving nothing else changed ─────────────────────────────────────────── */

export interface ClauseCheck {
  clean: boolean;
  /** One sentence for the operator. Empty when clean. */
  reason: string;
}

/**
 * Prove the rendered agreement is the lawyer's text plus facts, and nothing else.
 *
 * ─── THIS IS THE WHOLE SAFETY ARGUMENT, AND IT IS CHECKABLE ─────────────────
 * "The AI did not invent a clause" is a hope when the document is generated and a FACT when it
 * is a substitution. Re-deriving the template from the rendered text — replacing each filled
 * value with its slot again — must reproduce the original byte for byte. Any other difference is
 * a sentence somebody added between the lawyer and the signature.
 *
 * It is deliberately strict about whitespace. A reflowed paragraph is almost certainly harmless
 * and it is still a difference this check cannot tell apart from an inserted clause, so it
 * refuses and lets a person look.
 */
export function verifyOnlySlotsChanged(input: {
  template: string;
  rendered: string;
  values: SlotValues;
}): ClauseCheck {
  /* Longest values first: replacing "30" before "300" would corrupt the reversal. */
  const pairs = Object.entries(input.values)
    .filter(([, v]) => typeof v === "string" && v.trim() !== "")
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);

  let reversed = input.rendered;
  for (const [slot, value] of pairs) {
    reversed = reversed.split(value as string).join(`{{${slot}}}`);
  }

  if (reversed === input.template) return { clean: true, reason: "" };

  return {
    clean: false,
    reason:
      "The prepared agreement does not match the approved template once the filled-in facts are " +
      "put back. Something other than a fact has changed — a clause, a heading or a paragraph — " +
      "and a contract is not a document to send on trust. Compare it with the template before " +
      "anybody signs.",
  };
}

/* ── What may never be generated ──────────────────────────────────────────── */

/**
 * The clauses this application refuses to write, with the reason attached to each.
 *
 * Kept as data rather than prose so it can be rendered into the UI beside the template upload,
 * where the person choosing a template is the person who needs to read it.
 */
export const CLAUSES_WE_DO_NOT_WRITE: readonly string[] = [
  "An uptime or availability commitment, with or without service credits. We resell somebody " +
    "else's platform and control none of its availability — and on a 30-seat Starter deal a " +
    "single sub-95% month at Google's own 50% credit rate is Rs 4,050 against a margin of " +
    "Rs 4,800. There is no recourse behind it either: the Google reseller agreement is not " +
    "approved, so the credit would be owed with nothing to claim back.",
  "A limitation of liability, an indemnity, or a cap. These decide what a bad day costs this " +
    "company, and the number is not a software default.",
  "A termination, notice or renewal clause. When a customer may leave and what they owe on the " +
    "way out is a commercial position, not a template variable.",
  "Anything about data protection, processing or breach notification. The DPDP Act 2023 puts " +
    "duties on a data fiduciary that depend on what this business actually does, which a " +
    "document generator cannot know.",
  "A governing-law or jurisdiction clause. Where a dispute is heard is chosen once, by a person, " +
    "with advice.",
  "Any warranty about the vendor's product beyond what the vendor itself publishes.",
];

/* ── The signature request ────────────────────────────────────────────────── */

export type ESignProvider = "digio" | "docusign" | "aadhaar_esign";

export interface SignatureRequestDecision {
  send: boolean;
  /** One sentence for the operator and the log. */
  reason: string;
}

/**
 * May we ask this customer to sign, unattended? The answer is currently always no.
 *
 * ─── THREE SEPARATE REASONS, AND EACH IS ENOUGH ─────────────────────────────
 * 1. THE DIAL. `agreement.esign.send` is `off`, like `provisioning.activate` — and for the same
 *    kind of reason rather than out of caution: there is no ESP integration to switch on.
 *
 * 2. NO LICENSED PROVIDER IS CONFIGURED. Aadhaar eSign is not a link you can mint. Under the IT
 *    Act 2000 s.3A and its Second Schedule it runs through an eSign Service Provider licensed by
 *    the CCA, against a contract, with UIDAI authentication of the signer. Digio is such a
 *    provider; having heard of it is not the same as having an agreement with it.
 *
 * 3. A SIGNATURE IS IRREVERSIBLE AND OUTWARD-FACING. Once a customer has signed, the obligations
 *    exist. Every other irreversible thing in this app — a payment link, a provisioning
 *    activation — waits for a person, and this is the most binding of the three.
 *
 * Kept as a function returning a reason rather than a thrown error so the UI can explain the
 * block where the operator is standing (CLAUDE.md §24), instead of a disabled button.
 */
export function decideSignatureRequest(input: {
  /** From `resolveAutonomy("agreement.esign.send")`. */
  mode: "off" | "hold" | "auto";
  /** True only when a licensed ESP is actually configured for this tenant. */
  providerConfigured: boolean;
  provider: ESignProvider | null;
  /** True when a person has read this specific rendered agreement and said to send it. */
  reviewedByPerson: boolean;
  /** From verifyOnlySlotsChanged. */
  matchesTemplate: boolean;
}): SignatureRequestDecision {
  if (!input.matchesTemplate) {
    return {
      send: false,
      reason:
        "The agreement does not match the approved template once the facts are put back, so it " +
        "is not the document anybody approved. Nothing is sent for signature.",
    };
  }

  if (!input.providerConfigured || !input.provider) {
    return {
      send: false,
      reason:
        "No e-signature provider is set up. Aadhaar eSign runs through a provider licensed by " +
        "the CCA under the IT Act — it is a contract to sign, not a setting to switch on. Add " +
        "one under Settings, or send the PDF and collect a signature the usual way.",
    };
  }

  if (input.mode === "off") {
    return {
      send: false,
      reason:
        "Sending agreements for signature is switched off for this workspace. A signature " +
        "creates obligations the moment it lands, so this dial starts off and a person turns it " +
        "on deliberately.",
    };
  }

  if (!input.reviewedByPerson) {
    return {
      send: false,
      reason:
        "This agreement has not been read by anybody here. A contract is the one document this " +
        "application will not send unread at any dial setting — the terms bind us as much as " +
        "them, and nobody can un-sign it.",
    };
  }

  /* Reached only with a configured provider, the dial open, a template match and a person who
     has read this exact document. `auto` and `hold` both land here: a reviewed agreement is
     being sent BY a person, so the dial's remaining job is done. */
  return { send: true, reason: "reviewed by a person and matches the approved template" };
}
