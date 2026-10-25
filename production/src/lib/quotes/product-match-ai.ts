/**
 * Which catalogue item did the customer mean — asked of the model, answered from the list.
 *
 * ─── WHY THE EXACT MATCHER WAS NOT ENOUGH ───────────────────────────────────
 * 30 Aug 2026, live. Pardeep wrote "mujhe 40 email ke liye quote chahiye **google workspace
 * starter**". The catalogue's own name is "Google Workspace **Business** Starter", so
 * `findProduct` — which requires the full catalogue name as a whole-word substring — matched
 * nothing, and the lead recorded:
 *
 *   "No quote drafted automatically — the mail did not name a product from this tenant's
 *    catalogue"
 *
 * One missing word. The tenant sells exactly one Google Workspace plan, so what the customer
 * meant was not in doubt to any human reading it. Pardeep's own question was the right one:
 * *"isme ai ka use kyo nahi karte, ye understanding to ai khud kar lega"*.
 *
 * ─── AND THE THING THAT SCARED US OFF WAS NOT THE MODEL ─────────────────────
 * The rule is strict because of a real quote that went out wrong: a customer wrote "Google
 * Workspace BUSINESS Standard", the longest-first substring loop fell through to an
 * eight-character hosting SKU literally called "Standard" (Rs 125/month), and the quotation
 * priced their Workspace seats at Rs 1,500/seat/year.
 *
 * That was a STRING-MATCHING accident, not a judgement error. Handing the same question to
 * something that can read is not a loosening of that guard; it is the part of the job the
 * guard was standing in for.
 *
 * ─── THE SHAPE THAT MAKES THIS SAFE ─────────────────────────────────────────
 * The model **chooses**, it never **describes**:
 *
 *   · it is shown the catalogue and may answer with one of those names, or null
 *   · anything that is not EXACTLY a catalogue name is thrown away and becomes null
 *   · the returned value is a catalogue ROW, and every rupee comes from that row
 *
 * So the worst a wrong answer can do is quote the wrong PRODUCT at that product's correct
 * price — which is the same failure a human typing the wrong line into the builder makes,
 * and it is visible on the document. It cannot invent a price, and it cannot invent a plan
 * that is not sold. This is the same pattern `read-bill.ts` uses for `expense_category`:
 * constrain the answer to a list, then trust only the list.
 *
 * ─── AND IT ONLY RUNS WHEN THE CHEAP PATH FAILED ────────────────────────────
 * `findProduct` still goes first: it is free, instant and certain. This is the fallback for
 * the case that used to end in silence, so the extra call is paid only where the alternative
 * was giving up.
 */
import "server-only";
import { geminiJson } from "@/lib/ai/gemini";

export interface CatalogueChoice {
  id: string;
  name: string;
}

/**
 * The question, with the catalogue in it.
 *
 * Exported so a test can read what the model is actually asked — a prompt that drifts from
 * the validation below is how a "safe" constrained choice quietly stops being one.
 */
export function buildProductMatchPrompt(text: string, catalogue: readonly CatalogueChoice[]): string {
  return [
    "A customer emailed a software reseller. Decide WHICH product from the reseller's own",
    "catalogue they are asking about.",
    "",
    "CATALOGUE (the only permitted answers):",
    ...catalogue.map((c) => `- ${c.name}`),
    "",
    "RULES:",
    "- Answer with a name from the list above, copied EXACTLY, or null.",
    "- Match on meaning, not spelling. A customer who drops or adds a word — \"google workspace",
    "  starter\" for \"Google Workspace Business Starter\" — means that product.",
    "- If TWO catalogue entries could both fit what they wrote, answer null. A guess between",
    "  two real products is a wrong price on a real quotation.",
    "- If they named something this reseller does not sell, answer null.",
    "- Never answer with a name that is not on the list, and never invent one.",
    "",
    "Return ONLY JSON: {\"product\": string|null}",
    "",
    "THE CUSTOMER'S MESSAGE:",
    text.slice(0, 3000),
  ].join("\n");
}

/**
 * Turn whatever came back into a catalogue row, or null.
 *
 * ─── THE VALIDATION IS THE GUARD, NOT THE PROMPT ────────────────────────────
 * A prompt is a request; this is the enforcement. Case and surrounding whitespace are
 * forgiven because they change nothing about WHICH row was chosen. Everything else is
 * refused: a near-miss, a paraphrase, an invented plan, an empty string.
 */
export function validateProductPick(
  raw: unknown,
  catalogue: readonly CatalogueChoice[],
): CatalogueChoice | null {
  const picked = (raw as { product?: unknown } | null)?.product;
  if (typeof picked !== "string") return null;
  const want = picked.trim().toLowerCase();
  if (!want) return null;
  return catalogue.find((c) => c.name.trim().toLowerCase() === want) ?? null;
}

/**
 * Ask. Returns null on any doubt, any failure, and any answer off the list.
 *
 * Never throws: this sits on the inbound path, where one unanswerable email must not stop
 * the enquiry being recorded. Null here means exactly what it meant before this file
 * existed — no product identified, so no quote — and the lead is still saved.
 */
export async function matchProductWithAi(args: {
  apiKey: string;
  model: string;
  tenantId: string | null;
  text: string;
  catalogue: readonly CatalogueChoice[];
}): Promise<CatalogueChoice | null> {
  /* Nothing to choose between. With one entry the model still earns its place — it has to
     decide whether the mail is about that product AT ALL — but with zero there is no
     question to ask. */
  if (args.catalogue.length === 0 || !args.text.trim()) return null;

  const raw = await geminiJson<{ product?: string | null }>({
    apiKey: args.apiKey,
    tenantId: args.tenantId,
    model: args.model,
    user: buildProductMatchPrompt(args.text, args.catalogue),
    /* Zero, because this is a lookup and not a piece of writing. The same answer to the
       same mail every time is worth more here than variety. */
    temperature: 0,
    label: "product-match",
  });

  return validateProductPick(raw, args.catalogue);
}
