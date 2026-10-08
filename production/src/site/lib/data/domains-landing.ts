/**
 * Domains landing — content for the /domains conversion redesign
 * ("Domain hosting improvement strategy" handoff, 3 Sep 2026).
 *
 * The commercial lever, verbatim from the handoff:
 *
 *   > The domain is ₹0 when it points at our hosting (yearly plan).
 *
 * Everything here exists to make that arithmetic obvious and HONEST. Two rules
 * from the handoff's copy guide are load-bearing and must not be "optimised" away:
 *
 *   · Always print the RENEWAL price next to the first-year price. The free
 *     domain reads as an offer, not a trick, only because the number it becomes
 *     is shown next to it.
 *   · Keep the passages that tell people NOT to buy — the honest counter-argument
 *     block and two of the six FAQ answers. They are what make a default-on
 *     hosting selection legitimate rather than a dark pattern.
 *
 * REAL DATA (Pardeep's standing instruction — the page carries the app's own
 * numbers, never the handoff's placeholders):
 *   · TLD prices come from TLDS (catalog.ts) — the same rate card the app sells.
 *   · Hosting prices come from HOSTING_TIERS (hosting-landing-v2.ts → LANDING_PLANS),
 *     the single source the /hosting page and the cart checkout also read.
 *   · The mailbox is Anutech Mail, ₹79/mo (MAIL_RATES, catalog.ts) → ₹948/yr.
 *
 * The arithmetic figures (₹499, hosting total) are NOT hardcoded here — the
 * component derives them from TLDS + HOSTING_TIERS so the card can never drift
 * from what the cart charges.
 */

/** Anutech Mail — ₹79/mo (MAIL_RATES, catalog.ts). One mailbox, billed yearly. */
export const MAILBOX_MO = 79;
export const MAILBOX_YR = MAILBOX_MO * 12; // ₹948

/** Which hosting tier the arithmetic card and the "₹0 with hosting" copy price against. */
export const ANCHOR_TIER = "Standard";
/** Which TLD anchors the hero arithmetic ("a .in on its own is ₹X"). */
export const ANCHOR_TLD = ".in";

/**
 * Why hosting is in the box — a registered domain does nothing on its own.
 * Explainer only, NO controls (the handoff tested a second plan chooser here and
 * it read as confusing — two places to make the same decision).
 */
export const DOMAIN_NEEDS: readonly { n: string; t: string; b: string }[] = [
  { n: "01", t: "The name", b: "What you just searched — the address people type. On its own it is a signpost with nothing behind it." },
  { n: "02", t: "A place to serve pages from", b: "Hosting is the ground the website actually stands on. Without it, the name resolves to nothing." },
  { n: "03", t: "Mail routing", b: "you@yourname.in only delivers once the domain points at a mail host. The bundle wires this for you." },
];

/**
 * The honest counter-argument — "Don't add hosting if any of these is you."
 * KEEP THIS. It is what makes a default-on hosting selection acceptable.
 */
export const DONT_ADD_HOSTING: readonly { lead: string; rest: string }[] = [
  { lead: "You already pay a host", rest: "with months left on it — finish that term first, then move the domain across for free when it's up." },
  { lead: "It's a defensive registration", rest: "— a brand or a spelling you're parking, not building on. The name alone is exactly right; skip the box." },
  { lead: "You need a VPS or dedicated server", rest: "— shared hosting isn't your tier. Tell us the load and we'll say so honestly rather than sell you the wrong thing." },
  { lead: "Your site lives on Shopify, Wix or Webflow", rest: "— keep it there. We'll just point the domain at it, no hosting needed, and help with the DNS free." },
];

/** Included with every domain — hosting or not. Eight, real. */
export const DOMAIN_INCLUDED: readonly { t: string; b: string }[] = [
  { t: "Anycast DNS", b: "Fast, resilient resolution from a global network — the same DNS whether or not you host with us." },
  { t: "WHOIS privacy", b: "Your personal details kept off the public record, free wherever the registry permits it." },
  { t: "Theft protection", b: "Registrar lock on by default, so nobody can start a transfer out without your say-so." },
  { t: "Auto-renew, your call", b: "On or off, you decide. We remind you before every renewal at the printed price — never a surprise charge." },
  { t: "Free email forwards", b: "Route you@yourname.in to any inbox at no cost, even before you add a full mailbox." },
  { t: "Bulk operations", b: "Move, renew or update a whole portfolio in one action — built for resellers running a book of names." },
  { t: "DNS set up for you", b: "Send us where it should point and our team wires the records for you. No dashboard wrestling." },
  { t: "GST invoice", b: "Every order carries a proper GST invoice with our GSTIN — claim the input credit like any business expense." },
];

/**
 * FAQ / objections — six pairs. TWO of them (marked) end by telling the visitor
 * NOT to buy the hosting box. That honesty is the point; do not soften it.
 */
export const DOMAIN_FAQS: readonly { q: string; a: string }[] = [
  {
    q: "I already have hosting — is the bundle for me?",
    // DON'T-BUY answer — keep.
    a: "Then don't buy the box. Register (or transfer) just the name, and we'll point it at your existing host and wire the DNS for you, free. The bundle exists for people who need somewhere for the site to live — if you already have that, you'd be paying twice.",
  },
  {
    q: "My website is still months away.",
    // DON'T-BUY answer — keep.
    a: "Buy just the name and stop there. A domain sitting unused for a few months costs you only the registration; there's no reason to pay for hosting a site that doesn't exist yet. Come back and add hosting the day you're ready — the same ₹0-domain maths still applies at renewal.",
  },
  {
    q: "My developer will choose the host.",
    a: "Register the name now so nobody else takes it, and let them decide the rest. If they pick us, the domain's already here and free with the plan; if they pick elsewhere, we point it there for you at no charge. Either way you haven't lost the name while deciding.",
  },
  {
    q: "Is the free domain a first-year trick?",
    a: "No — and the proof is on the page: the renewal price is printed next to every first-year price. A .in is free with a yearly plan this year and renews at ₹799, shown before you pay and printed on the invoice. There is no year-two rate jump hiding under the ₹0.",
  },
  {
    q: "What if your hosting turns out to be slow?",
    a: "Measure it before you commit. Every yearly plan carries a 30-day money-back guarantee, and you can run your own pages on our servers first. If it isn't faster for you, you get your money back — the domain fee is registry-final, but the hosting is on us to prove.",
  },
  {
    q: "Can I move the domain away later?",
    a: "Any time. It's a standard registration — no lock-in. Ask support for the auth/EPP code and you can transfer it to any registrar. We'd rather earn the renewal than trap it, which is also why the renewal price is never a surprise.",
  },
];
