/**
 * GET /api/public/theme — ResellerOS's design tokens, for the apps that must look like it
 * (10 Oct 2026: the DMS Customer Portal reads this at runtime instead of keeping a copy).
 *
 * Public: these are the colours every page of this app already ships in its CSS. The values come
 * from lib/theme/tokens.ts, which a test pins to globals.css. Cached briefly, so a brand change
 * reaches consumers within minutes.
 */
import { NextResponse } from "next/server";
import { APP_THEME } from "@/lib/theme/tokens";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(APP_THEME, { headers: { "cache-control": "public, max-age=0, s-maxage=300" } });
}
