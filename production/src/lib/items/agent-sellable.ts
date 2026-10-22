/**
 * Ek item AI sales agent ko DIKHTA hai ya nahi — ek hi jagah, jaanchne layak.
 *
 * ─── YE FILE KYUN BANI ──────────────────────────────────────────────────────
 * 26 Aug 2026. Pardeep ne `sales@anutech.in` par email bheja aur reply nahi gaya. App ne
 * wajah `ai_action_log` me khud likh di thi:
 *
 *     reply.send → failed
 *     "No sellable products found in this workspace's catalogue, so the agent has no
 *      prices it is allowed to quote. Add products under Items first."
 *
 * Catalogue us waqt khaali tha (usi din reset hua tha), to wo wajah saaf thi. Par uske
 * peeche ek doosra roop khada tha jo bina rok ke agli baar zaroor kaatta:
 *
 *     `msrp` koi field NAHI hai jo user bharta ho. Wo sirf Annual/Monthly tier se banta
 *     hai. Item form USD tier bhi save karta hai — par headline sirf `annual ?? monthly`
 *     dekhta hai. To sirf USD bharne par item SAVE HO JATA THA, list me dikhta tha, aur
 *     `msrp` 0 reh jata tha. Agent `.gt("msrp", 0)` maangta hai, to wo item uske liye
 *     maujood hi nahi hota — bina kisi error ke.
 *
 * Screen par is haalat ka koi nishaan nahi milta. Pata karne ke liye DB me `msrp` dekhna
 * padta hai. Isliye ye faisla ab ek pure function hai jise test pakad sakta hai, form ke
 * andar dabi hui `if` nahi.
 *
 * ⚠️ SABSE ZAROORI SHART — rok sirf `main` par.
 * `msrp = 0` har item ke liye galat nahi hai. Kai support SKU jaan-boojh kar 0 rakhte hain
 * aur apna asli figure `prices.annual_total` me rakhte hain — ye `sales-agent.server.ts:90`
 * ke comment me live catalogue par naapa gaya tha. Un par rok lagana ek sahi tarike ko
 * todna hota, aur agent unhe padhta bhi nahi kyunki wo `main` nahi hote.
 *
 * Is file ko `loadSalesCatalog` (lib/ai/sales-agent.server.ts:102) ke saath mel me rakhna
 * hai. Wo query yahi maangti hai: kind = main · is_active · msrp > 0.
 */
import type { ItemPrices } from "@/lib/supabase/database.types";

/** Sirf is `kind` ko agent padhta hai — `loadSalesCatalog` ka `.eq("kind","main")`. */
export const AGENT_READS_KIND = "main" as const;

export interface TierValue { msrp: number; wholesale: number }

/**
 * Wo tier jo `items.msrp` column banta hai.
 *
 * **USD kabhi candidate nahi hai** — aur yahi poora bug tha. USD ek alag number hai
 * (₹136/mo vs $7/mo, dekho ItemPrices ka comment), koi converted INR nahi; isliye use
 * headline banane ka matlab hota ki ek export price ghar ke quote par lag jaye.
 */
export function headlineTier(prices: ItemPrices | null | undefined): TierValue {
  return prices?.annual ?? prices?.monthly ?? { msrp: 0, wholesale: 0 };
}

/**
 * Kya AI agent is item ko quote kar payega?
 *
 * `null` = haan (ya wo aisa item hai jise agent dekhta hi nahi, aur wo theek hai).
 * String = **kyun nahi**, user ki bhasha me — CLAUDE.md §24: kya hua, kyun, ab kya karein.
 */
export function agentQuoteBlocker(
  kind: "main" | "addon",
  prices: ItemPrices | null | undefined,
): string | null {
  /* Add-on ko agent padhta hi nahi. Uska `msrp` 0 hona ek aam aur sahi baat hai. */
  if (kind !== AGENT_READS_KIND) return null;

  const headline = headlineTier(prices);
  if (headline.msrp > 0) return null;

  /* Do alag galtiyan, aur inhe alag-alag batana zaroori hai: "kuch bhara hi nahi" aur
     "galat khaana bhara" — doosri wali me user ko lagta hai kaam ho gaya, aur wahi jyada
     mehnga confusion hai. */
  const onlyUsd =
    !prices?.annual && !prices?.monthly &&
    Boolean(prices?.usd && (prices.usd.msrp > 0 || prices.usd.wholesale > 0));

  const onlyWholesale =
    (prices?.annual?.wholesale ?? 0) > 0 || (prices?.monthly?.wholesale ?? 0) > 0;

  const why = onlyUsd
    ? "You entered only a USD price. USD is a separate number (for export deals), " +
      "and the AI does not build an INR quote from it."
    : onlyWholesale
      ? "You entered only the wholesale (purchase) price. The customer price is empty, so the AI " +
        "has no selling price."
      : "The customer price is empty in both Annual and Monthly.";

  return (
    "This Main plan will not work without a customer price.\n\n" +
    `${why}\n\n` +
    "What to do: enter the CUSTOMER price in the Annual (or Monthly) tier.\n" +
    "Or set Type to 'Add-on' if this plan is not sold on its own."
  );
}
