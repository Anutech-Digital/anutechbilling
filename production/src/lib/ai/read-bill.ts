/**
 * Reading a vendor bill (PDF or photo) with Gemini vision.
 *
 * ─── WHY THIS MOVED OUT OF THE ROUTE ────────────────────────────────────────
 * The prompt and the call lived inside /api/ai/extract-bill. A second caller
 * arrived — the billing@ inbound-email path — and the choice was to copy the
 * prompt or to share it. A copied prompt drifts: one gets the fix for negative
 * credit lines, the other does not, and the two disagree about the same PDF
 * depending on how it reached the system. One prompt, one parser, two callers.
 *
 * ─── THIS FUNCTION NEVER WRITES MONEY ───────────────────────────────────────
 * It returns what the model read and nothing else. The rule the original route
 * states is worth restating because the email path makes it easier to forget:
 * these numbers feed GST input credit and the P&L, an AI can misread a total,
 * and nothing here may become a vendor_bill row without a human confirming it.
 * An emailed bill is not more trustworthy than an uploaded one — it is less,
 * because nobody was looking when it arrived.
 */
import "server-only";
import { geminiJson } from "./gemini";
import type { ExtractedBill } from "@/app/api/ai/extract-bill/sanitize";

export const BILL_PROMPT =
  "You are reading a vendor/supplier bill for a cloud reseller's books — a tax invoice, " +
  "or a PROFORMA invoice / quotation from a reseller (the same layout, often only a " +
  "'Description | Total' table with no qty or rate columns). The " +
  "supplier may be INDIAN (Google Cloud/Workspace, Microsoft, Zoho, etc.) billing in " +
  "rupees with GST (CGST+SGST or IGST), OR a FOREIGN online-service provider (e.g. " +
  "Anthropic, OpenAI, Google LLC) billing in USD/other currency — these carry an India " +
  "GST registration under state code 99 (OIDAR) and may show GST as a single line. " +
  "Extract and return ONLY JSON, no prose:\n" +
  "{\n" +
  '  "document_type": string|null,      // "tax_invoice", "proforma" (Proforma / Pro-forma Invoice, quotation) or "other", from the document\'s own title\n' +
  '  "vendor_name": string|null,        // the SUPPLIER who issued the bill (the seller, NOT the buyer)\n' +
  '  "vendor_gstin": string|null,       // 15-char India GST/VAT registration of the supplier if printed\n' +
  /* R-1767 (22 Oct 2026): a bill "Bill To" ANOTHER company was saved in ours with no warning —
     the reader never read the buyer. The extract-bill route compares it with our own GSTIN/name. */
  '  "buyer_name": string|null,         // the BUYER the bill is addressed to: the "Bill To" / "Billed To" / "Buyer" block. NEVER the seller\n' +
  '  "buyer_gstin": string|null,        // 15-char GSTIN printed in that Bill To / Buyer block (null if none). NEVER the seller\'s GSTIN\n' +
  '  "bill_no": string|null,            // the invoice/bill number\n' +
  '  "bill_date": string|null,          // invoice/issue date as YYYY-MM-DD\n' +
  '  "currency": string|null,           // ISO code of the amounts on the bill: "INR", "USD", etc.\n' +
  '  "subtotal": number|null,           // taxable value BEFORE tax, in the bill\'s currency (keep decimals)\n' +
  '  "cgst": number|null,               // CGST amount (0 if not shown)\n' +
  '  "sgst": number|null,               // SGST amount (0 if not shown)\n' +
  '  "igst": number|null,               // IGST or a single GST/tax amount (0 if not shown)\n' +
  '  "total": number|null,              // grand total INCLUDING tax, in the bill\'s currency\n' +
  '  "line_items": [                    // every product/service row on the bill (empty array if none)\n' +
  '    { "description": string, "qty": number|null, "unit_price": number|null, "amount": number, "category": string|null }\n' +
  "      // category: this row's expense category, from the same list as expense_category below (null when unsure)\n" +
  "  ],\n" +
  '  "category_guess": string|null      // "COGS-Workspace" Google, "COGS-M365" Microsoft, "COGS-Zoho" Zoho, else "COGS-Other" or null\n' +
  /* ── Expense ki category BHI yahin se (30 Aug 2026) ─────────────────────────
     Ye Pardeep ka sujhav tha — "isme AI ko use nahi kar sakte?" — aur wo theek tha.

     Pehle ye kaam ek keyword-table karta tha (`suggestCategory`), jo OPERATOR ke likhe
     chhote note ke liye bana tha. Amazon ke 180-akshar wale product title par wo tootta
     hai: ek gadda "Travel" ban gaya, kyunki uske naam me "Ruyi Gadi" tha aur table me
     `gadi` = gaadi (vehicle) likha hai. Us bug ko theek karne ke BAAD bhi, 6 asli item me
     se 3 par koi jawab nahi aaya, ek galat aaya (WiFi heater → Internet & Phone), aur do
     lagbhag ek jaise bag ko do alag jawab mile.

     AI ke paas POORA bill hai — vendor, har line item, HSN — jo ek regex se bahut zyada
     hai. Aur ye usi call me aata hai jo pehle se ho rahi hai: koi nayi request nahi, koi
     extra intezaar nahi, sirf ek aur field.

     "Salaries" list me jaan-boojhkar NAHI hai — wo Payroll se aati hai, aur use yahan se
     chhune dena tankhwah ko ek aam kharcha bana dega. */
  '  "expense_category": string|null    // If this is an OVERHEAD / running-cost bill, pick EXACTLY ONE of:\n' +
  '     Hosting, Software, Office Rent, Marketing, Advertising, Business Promotion, Staff Welfare,\n' +
  '     Travel, Professional Services, Bank Charges, Internet & Phone, Utilities, Office Supplies,\n' +
  '     Equipment, Repairs & Maintenance, Insurance, Other.\n' +
  '     Judge by WHAT THE THING IS, not by words in its marketing name: a "Travel Backpack" bought\n' +
  '     for the office is Office Supplies, not Travel. Travel means a journey actually taken.\n' +
  '     Use null when unsure. NEVER "Salaries".\n' +
  /* R-1744 (22 Oct 2026, Pardeep: "GST bill do to AI sab bhare") — the short note, and
     "Paid already" only when the bill itself says so. */
  '  "item_short": string|null,         // 1-3 word name of the main thing bought, e.g. "Workspace", "EC2", "Office chair"\n' +
  '  "paid_status": string|null,        // "paid" ONLY if the bill clearly says it is paid (PAID stamp, "Amount paid", receipt, balance 0); "unpaid" if it shows an amount due; else null\n' +
  '  "payment_mode": string|null        // how it was paid as printed ("UPI", "Credit card", "Net banking", "Cash") — only when paid, else null\n' +
  "}\n" +
  "RULES: Keep amounts in the bill's OWN currency (do NOT convert). Keep decimals (e.g. 265.50). " +
  "Never invent a value — use null (or [] for line_items) if the bill does not clearly show it. " +
  /* R-1510: a reseller's Proforma ("Google Workspace ( 1 September - 30 September ,
     2026 )" | "562,110.28 INR") came back without the product name. Spell out the
     2-column table, the full row text, and the number format, so the row survives. */
  "line_items: one entry per charged row of the item table, even when the table has only " +
  "a description and a total column (qty and unit_price null then). description is the FULL " +
  "row text exactly as printed — product name plus any plan, period or date range, e.g. " +
  "\"Google Workspace ( 1 September - 30 September , 2026 )\" — never shortened or dropped. " +
  "Every amount is a plain JSON number: no thousands commas, no currency word or symbol — " +
  "\"562,110.28 INR\" is 562110.28, \"₹5,62,110.28\" is 562110.28. " +
  "A single foreign 'GST - India' / 'VAT' line goes in igst. " +
  "CREDIT lines are NEGATIVE: a refund / 'unused time' / proration credit / discount row must have a NEGATIVE amount (and negative unit_price), e.g. -61.41 — never 0. " +
  "The line_items amounts must sum to the pre-tax subtotal (total minus tax), so keep signs correct. " +
  "vendor_name is the SELLER, never the reseller/buyer. buyer_name / buyer_gstin are the BUYER from " +
  "the 'Bill To' / 'Billed To' / 'Buyer' block, never the seller's name or GSTIN; null when the bill shows no buyer.";

/** Types Gemini vision can read. Anything else is refused before the call. */
export const READABLE_BILL_MIME = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;

/**
 * Ask Gemini to read a bill. Returns null on any failure — the caller decides
 * what that means, because it means different things: a route tells the operator
 * to type it in by hand, the email path leaves the message parked for review.
 */
export async function readBillWithGemini(args: {
  apiKey:   string;
  model:    string;
  mimeType: string;
  base64:   string;
}): Promise<ExtractedBill | null> {
  /* ── PEHLE YAHAN APNA `fetch` THA, AUR USME TIMEOUT BHI NAHI ──────────────
     Ye vendor ka bill padhta hai (image ya PDF) aur uska nateeja `inbound_purchases` me
     jata hai, jahan se aage kharcha/GST banta hai. Iske paas na timeout tha, na circuit
     breaker, na retry — aur ise inbound webhook AWAIT karta hai, yaani Gemini atke to
     request atke, aur forwarder POST ke baad thread label kar deta hai bina jawab dekhe.

     Prompt JAHAN THA WAHIN HAI — `user` part me, bina systemInstruction. Use system me
     sarkane se model ka output badal sakta tha, aur ye paise ka data padhta hai; isliye
     geminiJson ka `system` field optional banaya gaya (dekho lib/ai/gemini.ts).

     Timeout 30s, 15s nahi: pehle KOI nahi tha, aur PDF/image ka jawab text se dheema aata
     hai. 30s ek asli bound hai jahan pehle anant tha — 15s karke ek chalte flow ko todna
     is fix ka maqsad nahi. */
  return geminiJson<ExtractedBill>({
    apiKey: args.apiKey,
    model: args.model,
    user: BILL_PROMPT,
    attachment: { mimeType: args.mimeType, base64: args.base64 },
    temperature: 0,
    timeoutMs: 30_000,
    label: "read-bill",
  });
}
