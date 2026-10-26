"use client";
/**
 * R-1970: the trust and help sections of /buy/workspace — why us, what happens after you pay,
 * FAQ, the "talk to us" band and the footer. Every company fact (name, GSTIN, address, phone)
 * is the website tenant's own (brand.ts). Not shown until real data exists (DECISIONS 6):
 * customer logos, case study, review rating, team photo, CIN, the "1-hour promise".
 */
import * as React from "react";
import Link from "next/link";
import { SLA, PARTNER_LINE } from "@/site/lib/config";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";
import { AFTER_PAY_STEPS } from "./plans";
import { stateName, whatsappHref, type BuyBrand, type BuyContact } from "./brand";

const H2 = "font-serif font-normal text-[clamp(30px,3.6vw,42px)] leading-[1.1]";

const PROMISES = [
  { n: "01", title: "You're the super admin", body: "Your company holds the top admin login from day one. We only get the access you approve, and you can remove it any time." },
  { n: "02", title: "We never read your email", body: "Emails, files and contacts live in your Google account, not ours. Our team never opens your mail or files — not even for support, unless you ask." },
  { n: "03", title: "No lock-in", body: "Want to move to Google direct or another partner? We transfer your subscription. No data moves, nothing stops working." },
];

/** R-1971: `children` = the GST invoice preview, beside "Check us before you pay". */
export function WhyUs({ brand, children }: { brand: BuyBrand | null; children?: React.ReactNode }) {
  const sellerState = stateName(brand?.stateCode);
  return (
    <section id="why-us" className="max-w-[1200px] mx-auto px-4 sm:px-5 pt-6 pb-[72px] scroll-mt-20">
      <h2 className={`${H2} mb-2.5 max-w-[760px] [text-wrap:balance]`}>Buying through a partner? Here&apos;s what stays yours.</h2>
      <p className="text-base text-ink-2 leading-relaxed mb-7 max-w-[680px]">
        We handle billing, setup and support. Your Google account, your data and your freedom to leave stay with you.
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3 mb-12">
        {PROMISES.map((c) => (
          <div key={c.n} className="bg-white border border-hairline rounded-[14px] p-[22px]">
            <div className="font-mono text-xs text-amber-ink mb-2.5">{c.n}</div>
            <h3 className="text-[17px] font-semibold mb-1.5">{c.title}</h3>
            <p className="text-sm text-ink-2 leading-relaxed m-0">{c.body}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-6 items-start">
      {brand && (
        <div className="flex-[1_1_420px] min-w-0 max-w-[640px]">
          <h3 className="font-serif font-normal text-[28px] mb-1.5">Check us before you pay</h3>
          <p className="text-[15px] text-ink-3 mb-[18px]">Don&apos;t take our word for it — check us on the official registers.</p>
          <div className="bg-white border border-hairline rounded-[14px] divide-y divide-hairline">
            {brand.gstin && (
              <div className="flex justify-between gap-3 flex-wrap items-center px-5 py-4">
                <div>
                  <div className="text-[15px] font-semibold">GSTIN <span className="font-mono font-medium">{brand.gstin}</span></div>
                  {sellerState && <div className="text-[13px] text-ink-3 mt-0.5">Registered in {sellerState}</div>}
                </div>
                <a href="https://services.gst.gov.in/services/searchtp" target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-amber-ink underline underline-offset-[3px]">
                  Verify on GST portal →
                </a>
              </div>
            )}
            <div className="flex justify-between gap-3 flex-wrap items-center px-5 py-4">
              <div>
                <div className="text-[15px] font-semibold">{brand.name}</div>
                <div className="text-[13px] text-ink-3 mt-0.5">{PARTNER_LINE}</div>
              </div>
              <a href="https://www.mca.gov.in/" target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-amber-ink underline underline-offset-[3px]">
                Verify on MCA →
              </a>
            </div>
          </div>
        </div>
      )}
      {children}
      </div>
    </section>
  );
}

export function AfterYouPay() {
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-5 py-[72px]">
      <h2 className={`${H2} mb-8`}>What happens after you pay</h2>
      <ol className="list-none m-0 p-0 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {AFTER_PAY_STEPS.map((t) => (
          <li key={t.when} className="border-t-2 border-amber pt-3.5">
            <div className="font-mono text-xs text-amber-ink uppercase tracking-[0.04em] mb-2">{t.when}</div>
            <div className="text-[15px] text-ink leading-normal">{t.what}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** FAQ copy — every answer is something we do today (no "Premier", no bank transfer yet). */
export function faqItems(brand: BuyBrand | null): Array<{ q: string; a: string }> {
  const home = stateName(brand?.stateCode);
  return [
    { q: "Is this the same Google Workspace I would buy from Google?", a: `Yes. Same apps, same admin console, same Google uptime commitment, and the same per-user price Google publishes for India. We are a ${PARTNER_LINE}, so we bill you in rupees with a GST invoice and help you set it up. You own your data and your admin account.` },
    { q: "I don't have a domain yet. Can I still buy?", a: "Yes. Tell us the name you want at checkout. We register it in your company's name, connect it to Workspace and call you to confirm — no DNS work on your side." },
    { q: "Can I add or remove users later?", a: "You can add users at any time on either plan. On the annual plan you can't reduce users or cancel before the year ends (Google's rule for annual plans). On the monthly plan you can add or remove users from month to month." },
    { q: "Annual or monthly — which should I choose?", a: "Annual costs less per user and is one invoice for the year, but you commit for 12 months. Monthly costs more and is billed every month. Most teams that are sure about Workspace pick annual." },
    { q: "Will I get a GST invoice I can claim input tax credit on?", a: `Yes. You get a tax invoice with your GSTIN and the correct split — CGST + SGST if you are in ${home ?? "our state"}, IGST if you are in any other state. Add your GSTIN at checkout; you can also buy without one.` },
    { q: "We use Microsoft 365, Zoho or cPanel email. Can you move us?", a: `Yes. We move existing email, contacts and calendars for you, free. How long: ${SLA.migration}. Your old email keeps working until the switch.` },
    { q: "How does the free trial work?", a: `${WORKSPACE_TRIAL_DAYS} days, with no payment details. You can buy any time during the trial and keep everything you set up. If you don't buy, the trial simply ends.` },
    { q: "How fast is it ready?", a: `We call or WhatsApp you ${SLA.firstReply} of your order. Your team's email is live ${SLA.workspaceLive}.` },
  ];
}

export function Faq({ brand }: { brand: BuyBrand | null }) {
  const [open, setOpen] = React.useState(0);
  const base = React.useId();
  return (
    <section id="faq" className="bg-paper-2 border-y border-hairline scroll-mt-20">
      <div className="max-w-[860px] mx-auto px-4 sm:px-5 py-[72px]">
        <h2 className={`${H2} mb-7`}>Questions people ask before buying</h2>
        <div className="flex flex-col gap-2">
          {faqItems(brand).map((f, i) => {
            const isOpen = open === i;
            return (
              <div key={f.q} className="bg-white border border-hairline rounded-xl">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`${base}-${i}`}
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  className="w-full flex justify-between gap-4 items-center text-left px-5 py-[18px] min-h-14 text-base font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-xl"
                >
                  <span>{f.q}</span><span aria-hidden className="text-xl text-ink-3 shrink-0">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && <p id={`${base}-${i}`} className="px-5 pb-5 m-0 text-[15px] text-ink-2 leading-relaxed">{f.a}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function SupportBand({ brand, contact, waMessage, onQuote }: { brand: BuyBrand | null; contact: BuyContact; waMessage: string; onQuote: () => void }) {
  return (
    <section id="talk-to-us" className="max-w-[1200px] mx-auto px-4 sm:px-5 py-[72px] scroll-mt-20">
      <div className="flex flex-wrap gap-8 items-center justify-between bg-ink text-paper rounded-[18px] p-6 sm:p-10">
        <div className="flex-[1_1_380px] min-w-0">
          <h2 className="font-serif font-normal text-[clamp(28px,3.2vw,38px)] leading-[1.12] mb-2.5">Prefer to talk it through?</h2>
          <p className="text-base text-paper/85 leading-relaxed mb-2.5">
            Our team answers the phone — Hindi or English, {SLA.hours}. Get a written GST quote, ask about migration, or have
            us place the order for you.
          </p>
          {brand?.address && <p className="text-sm text-paper/70 m-0">Visit us: {brand.address}</p>}
        </div>
        <div className="flex flex-wrap gap-2.5">
          {contact.tel && (
            <a href={contact.tel.href} className="inline-flex items-center h-[50px] px-[22px] rounded-[10px] bg-paper text-ink no-underline font-semibold">
              Call {contact.tel.display}
            </a>
          )}
          {contact.whatsapp ? (
            <a href={whatsappHref(contact.whatsapp, waMessage)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center h-[50px] px-[22px] rounded-[10px] border border-paper/40 text-paper no-underline font-semibold">
              WhatsApp a quote request
            </a>
          ) : (
            <button type="button" onClick={onQuote} className="inline-flex items-center h-[50px] px-[22px] rounded-[10px] border border-paper/40 text-paper font-semibold">
              Email me a GST quote
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export const FOOTER_LINKS = [
  { href: "/privacy-policy", label: "Privacy policy" },
  { href: "/terms-and-conditions", label: "Terms of service" },
  { href: "/refund", label: "Refund and cancellation" },
  { href: "/contact", label: "Contact" },
] as const;

export function SiteFooter({ brand }: { brand: BuyBrand | null }) {
  const legal = [brand?.address, brand?.gstin ? `GSTIN ${brand.gstin}` : null].filter(Boolean).join(" · ");
  return (
    <footer className="border-t border-hairline">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-8 flex flex-wrap gap-5 justify-between">
        <div className="text-[13px] text-ink-3 leading-[1.7] max-w-[560px] min-w-0">
          {brand && <div className="font-serif text-base text-ink">{brand.name}</div>}
          {legal && <div>{legal}</div>}
          <div>
            Google Workspace and related marks are trademarks of Google LLC.
            {brand ? ` ${brand.name} is a Google Workspace reseller.` : ""}
          </div>
        </div>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2 text-sm content-start">
          {FOOTER_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-amber-ink underline underline-offset-[3px] hover:text-amber">{l.label}</Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function TestModeBar() {
  return (
    <div role="status" className="bg-amber-soft border-b border-hairline-strong text-amber-ink text-[13px] text-center px-4 py-2 font-semibold">
      Test mode — orders are recorded but no real payment is taken.
    </div>
  );
}
