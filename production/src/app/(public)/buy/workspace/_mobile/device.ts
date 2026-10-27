/**
 * R-2020 (R-2019a, 27 Oct 2026 — R-2019 decision 1): /buy/workspace is ONE address; the server
 * picks the phone flow or the desktop v2 page, so a visitor downloads one tree, not both.
 * Chrome / Edge / Samsung send Sec-CH-UA-Mobile ("?1" on a phone); Safari and older browsers
 * only a user agent, so a phone user agent counts too. A tablet is desktop (the v2 page fits).
 * `?view=mobile|desktop` overrides the guess — the phone flow's hand-over to the v2 checkout
 * uses it, and so can anyone checking the other layout.
 */
export type BuyView = "mobile" | "desktop";

interface HeaderReader { get(name: string): string | null }

const PHONE_UA = /\b(iPhone|iPod|Android.+Mobile|Mobile Safari|Windows Phone|Opera Mini|IEMobile)\b|\bMobi\b/i;

export function buyViewFor(headers: HeaderReader, viewParam?: string | null): BuyView {
  if (viewParam === "mobile" || viewParam === "desktop") return viewParam;
  const hint = headers.get("sec-ch-ua-mobile");
  if (hint === "?1") return "mobile";
  if (hint === "?0") return "desktop";
  return PHONE_UA.test(headers.get("user-agent") ?? "") ? "mobile" : "desktop";
}
