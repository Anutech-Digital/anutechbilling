"use client";
/**
 * R-2020 (R-2019a): the phone flow's trust card and "Who you'll deal with" founder card.
 * Every fact is read, never typed: the partner line (config PARTNER_LINE — never "Premier"
 * until the certificate, R-1602), the founder's name (COMPANY.founder), the company (tenant row),
 * the number (site WhatsApp number via buyContact). The quote is Pardeep's, exactly as in the
 * design (R-2019 decision 4). Photo and social proof stay hidden until real content (flags.ts).
 */
import { COMPANY, PARTNER_LINE, whatsappDisplay } from "@/site/lib/config";
import { whatsappHref, type BuyBrand, type BuyContact } from "../_parts/brand";
import { SHOW_SOCIAL_PROOF, FOUNDER_PHOTO_URL } from "./flags";

const TICK = <span aria-hidden className="text-emerald-ink font-bold">✓</span>;
const PLACEHOLDER = "border-[1.5px] border-dashed border-hairline-strong rounded-[10px] px-3 py-2.5 text-sm text-ink-3 leading-snug";

export function TrustCard() {
  return (
    <div className="flex flex-col gap-3 bg-white border border-hairline rounded-[14px] p-3.5">
      <div className="flex gap-3 items-center">
        <span aria-hidden className="w-[52px] h-[52px] rounded-full border-[1.5px] border-hairline grid place-items-center shrink-0 font-bold text-[22px] text-[#4285F4]">G</span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-bold text-[15px]">{PARTNER_LINE}</span>
          <span className="text-sm text-ink-2">Billing, setup and support from one team</span>
        </div>
      </div>
      {SHOW_SOCIAL_PROOF && (
        <div className="grid grid-cols-2 gap-2">
          <div className={PLACEHOLDER}>Google rating and review count</div>
          <div className={PLACEHOLDER}>Businesses served</div>
        </div>
      )}
      <ul className="flex flex-col gap-1.5 border-t border-hairline pt-2.5 m-0 p-0 list-none">
        <li className="flex gap-2 text-sm">{TICK}Proper GST invoice</li>
        <li className="flex gap-2 text-sm">{TICK}A named person on phone, in Hindi or English</li>
        <li className="flex gap-2 text-sm">{TICK}Your data stays on Google&apos;s servers</li>
      </ul>
    </div>
  );
}

export function FounderCard({ brand, contact }: { brand: BuyBrand | null; contact: BuyContact }) {
  const wa = contact.whatsapp;
  return (
    <section aria-labelledby="who-you-deal-with" className="flex flex-col gap-3">
      <h2 id="who-you-deal-with" className="font-bold text-[17px] m-0">Who you&apos;ll deal with</h2>
      <div className="bg-white border border-hairline rounded-[14px] p-3.5 flex flex-col gap-3">
        <div className="flex gap-3 items-center">
          {FOUNDER_PHOTO_URL && (
            /* eslint-disable-next-line @next/next/no-img-element -- the founder's photo, set in flags.ts */
            <img src={FOUNDER_PHOTO_URL} alt={COMPANY.founder} className="w-[60px] h-[60px] rounded-full object-cover shrink-0" />
          )}
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="font-bold text-base">{COMPANY.founder}</span>
            <span className="text-sm text-ink-2">{brand ? `Founder, ${brand.name}` : "Founder"}</span>
            {wa && <span className="text-sm text-ink-2">Your direct number: {whatsappDisplay(wa)}</span>}
          </div>
        </div>
        <p className="text-sm leading-normal m-0">{"“You'll have my WhatsApp from day one. If something breaks, you call me, not a ticket queue.”"}</p>
        {(wa || contact.tel) && (
          <div className="grid grid-cols-2 gap-2">
            {wa && (
              <a href={whatsappHref(wa, "Hi, I'm looking at Google Workspace on your website.")} target="_blank" rel="noopener noreferrer"
                className="h-11 rounded-[10px] bg-ink text-paper text-sm font-bold grid place-items-center no-underline">WhatsApp</a>
            )}
            {contact.tel && (
              <a href={contact.tel.href} className="h-11 rounded-[10px] border-[1.5px] border-hairline-strong bg-white text-ink text-sm font-bold grid place-items-center no-underline">Call</a>
            )}
          </div>
        )}
      </div>
      {SHOW_SOCIAL_PROOF && (
        <div className="flex flex-col gap-2">
          <h2 className="font-bold text-[17px] pt-1.5 m-0">What customers say</h2>
          <div className={PLACEHOLDER}>Customer quote with name, company, city and licence count</div>
          <div className={PLACEHOLDER}>Second customer quote</div>
          <div className="grid grid-cols-3 gap-2">
            <div className={`${PLACEHOLDER} text-center`}>Logo</div>
            <div className={`${PLACEHOLDER} text-center`}>Logo</div>
            <div className={`${PLACEHOLDER} text-center`}>Logo</div>
          </div>
        </div>
      )}
    </section>
  );
}
