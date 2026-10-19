/**
 * The ResellerOS plan tiers — read by reselleros-home.ts (the Beta line) and nothing else.
 *
 * R-1603 (19 Oct 2026): this file used to carry the whole old ResellerOS marketing page's copy
 * (KPIs, quotes, modules, security list, changelog, founder quote …). Nothing imported any of
 * it — the live page is (product)/reselleros/page.tsx, worded from reselleros-home.ts — and it
 * still held old claims ("Google Cloud Mumbai", "DPDP Act 2023 ready") that could be wired back
 * by mistake. Only OS_TIERS is used, so only OS_TIERS stays.
 */

export const OS_TIERS = [
  { name: "Beta", price: "₹0", note: "Now — first 10 resellers", highlighted: true, lines: ["Every module, no seat limits", "Onboarding done with you personally", "You decide when to start paying"] },
  { name: "Starter", price: "TBA", note: "Launches at ₹15K MRR", highlighted: false, lines: ["Single operator", "Subscriptions, quotes, invoices", "GST and renewals"] },
  { name: "Growth", price: "TBA", note: "Launches at ₹15K MRR", highlighted: false, lines: ["Small team, roles and audit log", "Banking reconciliation, TDS", "Customer quote links"] },
  { name: "Pro", price: "TBA", note: "Launches at ₹15K MRR", highlighted: false, lines: ["Partner channel and procurement", "API access and webhooks", "Priority escalation"] },
] as const;
