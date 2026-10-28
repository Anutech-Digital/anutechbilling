/**
 * GET /api/fx/latest?from=USD  →  latest ₹ (INR) per 1 unit of `from`.
 * GET /api/fx/latest?from=USD&date=2026-10-25  →  the rate for that date (R-2056, vendor bills).
 *
 * Used by the quote / invoice builder's "International billing" block to
 * auto-fill the exchange rate (₹ per foreign unit) so the operator doesn't
 * hand-type a stale number.
 *
 * R-045 slice 3: the rate comes from `fetchInrRate` (src/lib/fx/rate-source.ts) —
 * the FBIL / RBI reference rate when FBIL publishes that currency and is reachable,
 * else an INDICATIVE market rate, labelled as such. The response carries `source`,
 * `kind` ("reference" | "indicative"), `label` and `asOf` (the rate's own date) so the
 * builder can show — and the quote/invoice can store — where the number came from.
 *
 * NOT a money-write: it only returns a suggested rate. The operator still sees
 * the number, can override it (source becomes "manual"), and it is stamped onto the
 * quote at save — the ₹ canonical amount is always derived from the value the
 * operator confirms.
 */
import { NextResponse, type NextRequest } from "next/server";
import { fetchInrRate, fetchInrRateOn } from "@/lib/fx/rate-source";

// Only currencies we actually bill in — rejects junk input.
const ALLOWED = new Set(["USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "INR"]);

export async function GET(request: NextRequest) {
  const from = (request.nextUrl.searchParams.get("from") ?? "").toUpperCase().trim();
  if (!ALLOWED.has(from)) {
    return NextResponse.json({ error: "Unsupported currency." }, { status: 400 });
  }

  /* R-2056: ?date=YYYY-MM-DD → that day's rate (a vendor bill's date); no date → latest, as before. */
  const date = request.nextUrl.searchParams.get("date");
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date must be YYYY-MM-DD." }, { status: 400 });
  }

  const result = date ? await fetchInrRateOn(from, date) : await fetchInrRate(from);
  if (!result) {
    return NextResponse.json(
      { error: "Couldn't fetch the latest rate right now. Enter it manually." },
      { status: 502 },
    );
  }
  return NextResponse.json(result);
}
