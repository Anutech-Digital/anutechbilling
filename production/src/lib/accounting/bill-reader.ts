/**
 * R-2005 — the ONE bill reader behind every "Upload bill": Add COGS Bill, Add expense, and the bank
 * Reconcile "The bill is not in the books yet — record it now". Each screen keeps its own form;
 * the file check, the /api/ai/extract-bill call (the route sanitises the read and runs the buyer
 * check), the error words and the "fill by hand" way out live only here, so the three can never
 * drift apart.
 */
import { isBuyerMismatch, resaleProduct, type BuyerMismatch } from "@/app/api/ai/extract-bill/buyer-check";

/** What the bill reader can read — the same types /api/ai/extract-bill accepts (R-1744). */
export const BILL_FILE_TYPES = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;
export const BILL_MAX_BYTES = 8 * 1024 * 1024;

const TOO_BIG = "File is too big (max 8 MB) — try a smaller photo, or fill the fields by hand.";
const BAD_TYPE = "Drop a PDF or a photo (JPG/PNG) of the bill.";
const NOT_SET_UP = "AI bill reading is not set up for your company (Settings → Integrations → AI). Fill the form by hand — the bill will still be attached.";
const NOT_READ = "Couldn't read the bill — fill the fields by hand. The bill will still be attached.";
const FAILED = "Upload failed — try again, or fill the fields by hand.";

export interface BillRead {
  /** The route's sanitised fields (sanitizeExtractedBill + buyer_mismatch). */
  fields: Record<string, unknown>;
  /** R-1767: the bill is addressed to another company. */
  buyer: BuyerMismatch | null;
  /** R-1767: a product we resell (Google Workspace, Microsoft 365, Zoho) → a COGS bill. */
  resale: string | null;
}
export type BillReadOutcome = { ok: true; read: BillRead } | { ok: false; error: string };

/** null = the file can be read; else the line to show. */
export function checkBillFile(file: Pick<File, "type" | "size">): string | null {
  if (!BILL_FILE_TYPES.test(file.type)) return BAD_TYPE;
  if (file.size > BILL_MAX_BYTES) return TOO_BIG;
  return null;
}

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload  = () => resolve(String(r.result ?? "").split(",")[1] ?? "");
  r.onerror = () => reject(new Error("read failed"));
  r.readAsDataURL(file);
});

/** Read a bill photo / PDF with the AI. Never throws — a failure is an error line to show. */
export async function readBillFile(file: File, fetchImpl: typeof fetch = fetch): Promise<BillReadOutcome> {
  const bad = checkBillFile(file);
  if (bad) return { ok: false, error: bad };
  try {
    const base64 = await toBase64(file);
    const res = await fetchImpl("/api/ai/extract-bill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileBase64: base64, mimeType: file.type }),
    });
    const json = (await res.json().catch(() => ({}))) as { fields?: Record<string, unknown>; error?: string; code?: string };
    if (!res.ok) return { ok: false, error: json.code === "ai_not_configured" ? NOT_SET_UP : (json.error || NOT_READ) };
    const fields = json.fields ?? {};
    return {
      ok: true,
      read: {
        fields,
        buyer: isBuyerMismatch(fields.buyer_mismatch) ? fields.buyer_mismatch : null,
        resale: resaleProduct({ category_guess: typeof fields.category_guess === "string" ? fields.category_guess : null }),
      },
    };
  } catch {
    return { ok: false, error: FAILED };
  }
}
