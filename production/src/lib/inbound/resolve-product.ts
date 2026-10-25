/**
 * Work out WHICH catalogue product a mail is asking about — exact match first, model second.
 *
 * ─── THE MAIL THAT MADE THIS A SHARED FUNCTION ──────────────────────────────
 * 31 Aug 2026, a real reply into `sales@anutech.in`:
 *
 *     "mujhe 48 email id google workspace starter ke liye qutoe chahiye monthly par"
 *
 * Seats, product and term — all three, in one sentence. The app filed the lead, wrote back a
 * priced answer naming "Google Workspace Business Starter" at Rs 325/seat/month, told the
 * customer *"I will prepare the quotation and share it with you"* — and drafted nothing. The
 * timeline says why:
 *
 *     "No new quote from this reply — the reply does not give both a seat count and a
 *      catalogue product, so there is nothing to price"
 *
 * The catalogue row is "Google Workspace Business Starter"; the customer wrote
 * "google workspace starter". `findProduct` wants the whole name, so it missed — which is
 * EXACTLY the case the AI fallback was added for on 30 Aug.
 *
 * That fallback was wired into the branch that CREATES a lead and not into the branch that
 * appends a REPLY. Same shape as the 23 Aug bug, where the entire quote block lived on the
 * create branch alone: a reply from somebody already in conversation, naming seats and a
 * plan, is the most quote-worthy mail this app receives, and it is the branch that kept
 * being forgotten.
 *
 * So the capability is a function now, and `auto-quote-wiring.test.ts` counts both call
 * sites. A branch is a place to forget something; a function is not.
 *
 * ─── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * The model CHOOSES from the catalogue, it does not describe. Its answer is accepted only
 * when it matches a row's name exactly, and the price always comes from that row — see
 * `lib/quotes/product-match-ai.ts`. A miss returns null, which is what the caller did before
 * this existed, so nothing gets worse when the model is unavailable or unsure.
 */
import { matchProductWithAi } from "@/lib/quotes/product-match-ai";
import type { CatalogueEntry } from "./extract";

export interface ResolveProductArgs {
  /** What the deterministic matcher already found. Non-null short-circuits everything. */
  exact: CatalogueEntry | null;
  /** The mail as every other reader sees it — subject included, via `withSubject`. */
  text: string;
  catalogue: CatalogueEntry[];
  gemini: { apiKey: string | null; model: string; tenantId: string | null };
}

export interface ResolvedProduct {
  entry: CatalogueEntry;
  /** How it was resolved, for the lead's timeline. A person must be able to see the guess. */
  source: string;
}

/**
 * Injectable so the tests never have to mock the module.
 *
 * They did at first, and vitest failed the "model threw" case even though the catch below
 * had plainly run — its stderr line was in the output. An async mock that throws leaves
 * vitest's own result-tracking promise unhandled, and it reports that as the test's error.
 * The code was right and the harness was lying; passing the function in removes the lie.
 */
export type ProductMatcher = typeof matchProductWithAi;

export async function resolveProduct(
  args: ResolveProductArgs,
  match: ProductMatcher = matchProductWithAi,
): Promise<ResolvedProduct | null> {
  /* Free, instant and certain. Only what this could not answer reaches the model. */
  if (args.exact) return { entry: args.exact, source: args.exact.name };

  if (args.catalogue.length === 0 || !args.gemini.apiKey) return null;
  if (!args.text.trim()) return null;

  try {
    const picked = await match({
      apiKey: args.gemini.apiKey,
      model: args.gemini.model,
      tenantId: args.gemini.tenantId,
      text: args.text,
      catalogue: args.catalogue,
    });
    if (!picked) return null;
    /* `matchProductWithAi` already refuses anything not in the list, but the caller's own
       catalogue array is the one the price will come from — so resolve against THAT. */
    const entry = args.catalogue.find((c) => c.id === picked.id);
    if (!entry) return null;
    return { entry, source: `${entry.name} (matched by AI from the customer's wording)` };
  } catch (e) {
    /* An unmatched product meant "no quote" before this function existed and still does.
       The enquiry is already filed; this call must never be in its way. */
    console.error("[resolve-product] AI product match failed:", (e as Error).message);
    return null;
  }
}
