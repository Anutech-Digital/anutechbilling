/**
 * Read one inbound mail into the facts a quote needs: catalogue, seats, product, term.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT TWO COPIES ──────────────────────────────
 * Because it was two copies, and both of this week's quote failures lived in the gap
 * between them.
 *
 * The webhook has two branches — a mail from a stranger CREATES a lead, a mail from somebody
 * already in conversation APPENDS to theirs — and each one read the mail its own way. Every
 * new capability then had to be connected twice, by hand, and the reply branch is the one
 * that kept being missed:
 *
 *   23 Aug 2026  the entire auto-quote block existed on the create branch alone. A reply
 *                naming "50 Google Workspace Business Starter users on annual billing"
 *                corrected the lead and priced nothing.
 *   31 Aug 2026  the AI product matcher — added the day before, for exactly the wording
 *                "google workspace starter" — was on the create branch alone. A reply
 *                asking for 48 of them got a priced answer, a promise of a quotation, and
 *                no quotation.
 *
 * Neither was a wrong decision. Both were a step wired to one door out of two. So the
 * reading happens here, once, and `auto-quote-wiring.test.ts` counts the call sites.
 *
 * ─── WHAT STAYS WITH THE CALLER ─────────────────────────────────────────────
 * `stripQuoted`, deliberately. A reply carries our own previous message underneath it,
 * containing the very numbers being corrected — so the reply branch must read the stripped
 * text and NOTHING else, while the create branch falls back to the raw body when stripping
 * leaves nothing (a forwarded enquiry is often entirely quoted). Those two answers are
 * genuinely different and a boolean here would only hide that. The caller strips; this
 * function is told what to read.
 */
import { extractEntities, type ExtractedEntities, type CatalogueEntry } from "./extract";
import { resolveProduct } from "./resolve-product";
import type { CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

export interface ReadEnquiryArgs {
  tenantId: string;
  /** Sender identity — the extractor uses both to fill name/email. */
  fromName: string;
  fromEmail: string;
  subject: string;
  /** The body to read, ALREADY stripped of the quoted thread by the caller. */
  body: string;
  /** `body` with the subject prefixed — what the model is shown. See `withSubject`. */
  bodyWithSubject: string;
  gemini: { apiKey: string | null; model: string; tenantId: string | null };
}

export interface EnquiryFacts {
  /** Every active product, with prices — the same rows the quote will be built from. */
  catalogue: CatalogueItemPrice[];
  /**
   * Seats, term and product as read from the mail.
   *
   * `product` carries the AI's pick when the deterministic matcher missed, so a caller that
   * writes this onto the lead writes the CATALOGUE's own name — which is what every later
   * comparison (`samePlan`, `shouldRequoteOnReply`) is looking for.
   */
  facts: ExtractedEntities;
  /** The catalogue row itself, ready to price. Null when nothing matched. */
  item: CatalogueItemPrice | null;
}

export async function readEnquiryFacts(admin: Admin, args: ReadEnquiryArgs): Promise<EnquiryFacts> {
  /* msrp, wholesale and prices, not just id+name: this feeds the quote as well as the
     correction. The append branch selected only id+name until 23 Aug, when correcting was
     all it did. */
  const { data } = await admin
    .from("items")
    .select("id, name, msrp, wholesale, prices")
    .eq("tenant_id", args.tenantId)
    .eq("is_active", true);

  const catalogue = (data ?? []) as unknown as CatalogueItemPrice[];
  const entries: CatalogueEntry[] = catalogue.map((c) => ({ id: c.id, name: c.name }));

  /* Extracted ONCE and handed to both the correction and the quote. Extracting twice is how
     the two would come to disagree — the correction saying 50 seats while the quote priced
     20 — from a single mail. */
  const raw = extractEntities({
    fromName: args.fromName,
    fromEmail: args.fromEmail,
    subject: args.subject,
    body: args.body,
    catalogue: entries,
  });

  const resolved = await resolveProduct({
    exact: raw.product.value,
    text: args.bodyWithSubject,
    catalogue: entries,
    gemini: args.gemini,
  });

  /* Only fills a GAP. A deterministic match already in `raw` is never overwritten by the
     model — the regex read the customer's own words, and that outranks a guess. */
  const facts: ExtractedEntities = resolved && !raw.product.value
    ? { ...raw, product: { value: resolved.entry, source: resolved.source } }
    : raw;

  const item = facts.product.value
    ? catalogue.find((c) => c.id === facts.product.value?.id) ?? null
    : null;

  return { catalogue, facts, item };
}
