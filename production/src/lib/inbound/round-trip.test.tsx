import { describe, it, expect } from "vitest";
import { extractEntities } from "./extract";
import { resolveProduct, type ProductMatcher } from "./resolve-product";
import { planQuoteFromEnquiry, type CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";
import { decideAutoSend } from "@/lib/quotes/auto-send-quote";
import { buildQuotePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { replySubject } from "@/lib/email/reply-subject";
import { replyToAddress } from "@/lib/email/reply-to";
import { pdfText, undrawable } from "@/lib/pdf/pdf-text";
import type { Quote } from "@/lib/supabase/database.types";

/* ═════════════════════════════════════════════════════════════════════════════
   POORA CHAKKAR, EK TEST ME — 31 Aug 2026.

   Pardeep ne poochha: "koi na koi chhoti si kami rah jati hai — ek hi baar me poora flow
   theek nahi ho sakta?" Us din ke baaraah bug ginne par jawab saaf tha: dus ek hi RAASTE par
   the, aur galtiyan kadamon ke BEECH thi —

     mail aayi -> lead -> product -> daam -> quote -> PDF -> email -> jawab -> phir mail aayi

   Hum ek-ek kadam test kar rahe the, aur beech ki jagahon ko koi nahi dekhta tha:

     | Kadam ke beech                          | Wahan kya toota                        |
     | product pehchan -> quote                | reply branch par AI matcher nahi tha   |
     | quote -> PDF                            | maasik daam 12 se baant diya gaya      |
     | PDF -> aankh                            | ₹ font me hi nahi tha                  |
     | email -> customer ka inbox              | AI apna subject bana raha tha          |
     | customer ka jawab -> app                | Reply-To us mailbox par jo padha nahi jata |
     | term aana -> quote bhejna               | term faisle me shaamil hi nahi tha     |

   Isliye ye test ek ASLI vaakya leta hai aur use ANT tak le jata hai — asli functions se, aur
   nateeje ko CHEEZ banakar dekhta hai (PDF ke bytes, email ke header), sirf code padh kar
   nahi. DB aur Gemini hi nakli hain; beech ka koi kadam nakli nahi.
   ═════════════════════════════════════════════════════════════════════════════ */

/* Live catalogue, 30 Aug 2026 — msrp Rs/seat/MAHINA (annual tier), prices.monthly = flex. */
const ITEM: CatalogueItemPrice = {
  id: "i1",
  name: "Google Workspace Business Starter",
  msrp: 270,
  wholesale: 250,
  prices: { monthly: { msrp: 325, wholesale: 300 } },
} as CatalogueItemPrice;

const TENANT: TenantPdfInfo = {
  name: "ANUTECH DIGITAL PVT LTD",
  gstin: "07ABDCA0298H1ZP",
  email: "pardeep@anutech.in",
  phone: "+91 98765 43210",
  address: "Delhi",
  state: "Delhi",
  state_code: "07",
  logo_url: null,
  /* R-038 — is quote PDF par bank block nahi chhapta, par TenantPdfInfo har caller se
     yeh poochta hai (uska comment dekho). Nulls, taaki test ka matlab na badle. */
  upi_vpa: null,
  remit_bank_name: null, remit_account_name: null, remit_account_number: null,
  remit_ifsc: null, remit_branch: null,
};

/** Wo mailbox jise app padhti hai — tenant ka apna Gmail, owner ka address NAHI. */
const INGEST = [{ google_email: "sales@anutech.in" }];

/** 1x1 PNG. Asli bytes, par network nahi. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Wo model jo asli me chalta hai — us din uska jawab yahi tha. */
const matchStarter: ProductMatcher =
  (async () => ({ id: "i1", name: ITEM.name })) as ProductMatcher;

async function render(props: React.ComponentProps<typeof QuotePDF>): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");
  return await renderToBuffer(
    (<QuotePDF {...props} />) as unknown as Parameters<typeof renderToBuffer>[0],
  );
}

/**
 * Ek mail se lekar bheje jane layak PDF + email tak — har kadam asli function se.
 */
async function walk(opts: { subject: string; body: string }) {
  /* ── 1. Mail padho ── */
  const raw = extractEntities({
    fromName: "Pardeep Sharma",
    fromEmail: "pardeep.webmaster@gmail.com",
    subject: opts.subject,
    body: opts.body,
    catalogue: [{ id: ITEM.id, name: ITEM.name }],
  });

  /* ── 2. Product tay karo — pakka matcher chooke to model ── */
  const resolved = await resolveProduct(
    {
      exact: raw.product.value,
      /* Subject SAMET — aaj ki asli mail me poori maang subject me thi. */
      text: `Subject: ${opts.subject}\n\n${opts.body}`,
      catalogue: [{ id: ITEM.id, name: ITEM.name }],
      gemini: { apiKey: "k", model: "m", tenantId: null },
    },
    matchStarter,
  );
  const facts = resolved && !raw.product.value
    ? { ...raw, product: { value: resolved.entry, source: resolved.source } }
    : raw;
  const item = facts.product.value ? ITEM : null;

  /* ── 3. Daam lagao ── */
  const plan = planQuoteFromEnquiry({ item, seats: facts.seats.value, term: facts.term.value });

  /* ── 4. Bhejna hai ya nahi ── */
  const send = plan.ok
    ? decideAutoSend({
        termAssumed: plan.termAssumed,
        seats: facts.seats.value,
        recipient: "pardeep.webmaster@gmail.com",
        quoteId: "Q-ADPL-2026-27-0099",
        emailConfigured: true,
        senderIsOurs: false,
        isSelfTest: false,
      })
    : { send: false, reason: plan.reason };

  /* ── 5. Document banao — jaise asli quote row banti hai ── */
  const quote = plan.ok
    ? ({
        id: "Q-ADPL-2026-27-0099",
        customer_name: "Omega Co",
        subtotal: plan.subtotal,
        discount_pct: plan.discountPct,
        tax_rate: 18,
        amount: plan.amount,
        line_items: plan.items,
        billing_cycle: plan.items[0]?.commitment === "monthly" ? "monthly" : "yearly",
        created_date: "2026-08-31",
        expires_date: "2026-09-07",
        notes: plan.assumption,
        is_renewal: false,
      } as unknown as Quote)
    : null;

  const pdfProps = quote
    ? buildQuotePdfProps({ quote, customer: null, tenant: TENANT, logoDataUri: TINY_PNG })
    : null;

  /* ── 6. Email ka lifafa ── */
  const envelope = {
    subject: replySubject(opts.subject, "Your quotation"),
    replyTo: replyToAddress(INGEST, TENANT.email),
  };

  return { facts, plan, send, pdfProps, envelope };
}

/* ─────────────────────────────────────────────────────────────────────────────
   RAASTA 1 — jo AAJ asli me chala aur kaam kar gaya: teeno cheezein ek vaakya me.
   ───────────────────────────────────────────────────────────────────────────── */
describe("chakkar: seats + product + term, sab ek mail me", () => {
  const SUBJECT = "mujhe 37 email id ke liye quote chahiye google business starter monthly";

  it("mail se PDF tak — har kadam", async () => {
    const r = await walk({ subject: SUBJECT, body: "" });

    /* Product — "google business starter" catalogue ke poore naam se nahi milta; model ne
       pehchana. Yahi 31 Aug ka bug tha, reply branch par. */
    expect(r.facts.product.value?.name).toBe(ITEM.name);
    expect(r.facts.seats.value).toBe(37);
    expect(r.facts.term.value).toBe("monthly");

    /* Daam — flex tier, aur uspar KOI discount nahi (Pardeep ka niyam). */
    expect(r.plan.ok).toBe(true);
    if (!r.plan.ok) return;
    expect(r.plan.subtotal).toBe(37 * 325);
    expect(r.plan.discountPct).toBe(0);
    expect(r.plan.termAssumed).toBe(false);

    /* Bhejna — term customer ne likha hai, to bheja jayega. */
    expect(r.send.send).toBe(true);

    /* Document — row par cycle monthly, warna PDF 12 se baant deta. */
    expect(r.pdfProps?.billingCycle).toBe("monthly");
    expect(r.pdfProps?.subtotal).toBe(12_025);

    /* Lifafa — grahak ka apna subject, aur jawab us mailbox par jo PADHA jata hai. */
    expect(r.envelope.subject).toBe(`Re: ${SUBJECT}`);
    expect(r.envelope.replyTo).toBe("sales@anutech.in");
  });

  it("PDF ke BYTES — logo hai, aur rupee ka toota nishaan nahi", async () => {
    const r = await walk({ subject: SUBJECT, body: "" });
    expect(r.pdfProps).not.toBeNull();
    if (!r.pdfProps) return;
    const bytes = await render({ ...r.pdfProps, tenantLogo: TINY_PNG });

    /* Logo asli me draw hua. */
    expect(bytes.includes(Buffer.from("/Subtype /Image")), "logo PDF me nahi aaya").toBe(true);

    /* ── AUR YE JAANCH PEHLI RUN ME HI KUCH PAKAD LAAYI ─────────────────────
       Maine pehle likha tha `expect(pdfText(s)).toBe(s)` — "PDF ko diya gaya matn pehle se
       saaf ho". Wo laal hua, aur shart hi galat thi: poora point yahi hai ki matn GANDA ho
       sakta hai aur sanitiser use sambhal le.

       Jo nikla wo asli baat hai — quote ke apne notes me `₹` hota hai:

         "Term MONTHLY, as stated in the mail (₹325/seat/month, the flex tier)."

       `planQuoteFromEnquiry` wo likhta hai, wo `quotes.notes` me jata hai, aur notes PDF par
       chhapte hain. Yaani `pdfText` sajawat nahi hai — wo asli data par asli kaam kar raha
       hai. Sahi jaanch: sanitise ke BAAD kuch na-bann-ne wala na bache. */
    for (const s of [r.pdfProps.notes ?? "", r.pdfProps.customerName, r.pdfProps.tenantName]) {
      expect(undrawable(pdfText(s)), `sanitise ke baad bhi na-bann-ne wala akshar: ${s}`)
        .toEqual([]);
    }

    /* Aur ye pin — kyunki agar notes se ₹ hata diya jaye to upar wali jaanch bekaar ho
       jayegi aur koi nahi jaanega. */
    expect(r.pdfProps.notes ?? "", "notes me ₹ nahi hai — to sanitiser kuch nahi kar raha")
      .toContain("₹");

    /* ── AUR CONTROL, kyunki ab do duniya hain ──────────────────────────────
       Pehle yahan `toContain("Rs 325")` likha tha. Ab QuotePDF import karte hi embedded
       font register ho jata hai, to `pdfText` `₹` ko chhod deta hai — aur wo assertion
       laal ho gayi. Wo sahi laal thi: nateeja badla hai, kami nahi aayi.

       Iski jagah wo baat pin ki hai jo DONO duniya me sach hai — sanitiser chal raha hai —
       aur wo `✓` se naapi jati hai, jo Noto Sans me bhi NAHI hai. Yahi CONTROL hai: agar
       `pdfText` chupchaap identity function ban jaye, ye line pakad legi. */
    expect(pdfText("✓"), "pdfText kuch nahi kar raha — sanitiser mar chuka hai").toBe("+");
    expect(pdfText(r.pdfProps.notes ?? "")).toContain("325");
  }, 60_000);
});

/* ─────────────────────────────────────────────────────────────────────────────
   RAASTA 2 — jo AAJ TOOTA THA: term nahi likha. Quote banega par BHEJA NAHI jayega.
   ───────────────────────────────────────────────────────────────────────────── */
describe("chakkar: term nahi likha", () => {
  const SUBJECT = "mujhe 32 email id ke liye quote chahiye google business starter";

  it("quote banta hai, par daam ANDAZA hai to bheja nahi jata", async () => {
    /* Q-ADPL-2026-27-0055 ka asli maamla. Monthly aur annual me 12 guna ka farq hai, aur
       andaze wala daam customer humse manwa sakta hai. */
    const r = await walk({ subject: SUBJECT, body: "" });

    expect(r.facts.seats.value).toBe(32);
    expect(r.facts.term.value).toBeNull();
    expect(r.plan.ok).toBe(true);
    if (!r.plan.ok) return;
    expect(r.plan.termAssumed, "term andaza hona chahiye").toBe(true);

    expect(r.send.send, "andaze ke daam par quote nahi jana chahiye").toBe(false);
    /* `decideAutoSend` ka return ek union hai aur `send: true` wale roop par `reason` hota hi
       nahi — narrow karna padta hai. Ye vitest ko dikha hi nahi (wo type nahi dekhta); gate ke
       typecheck ne pakda. Isiliye dono gate me hain. */
    if (r.send.send) return;
    expect(r.send.reason).toContain("monthly or annual");
  });

  it("andaza annual par lagta hai — aur wahi 12x ka khatra hai", async () => {
    const r = await walk({ subject: SUBJECT, body: "" });
    if (!r.plan.ok) return;
    /* Annual line ka rate per SAAL hota hai (270 x 12), maasik ka per MAHINA (325). Dono ko
       ek jaisa maan lena hi wo galti thi jo ek GST document par chhap gayi. */
    expect(r.plan.items[0].rate).toBe(270 * 12);
    expect(r.pdfProps?.billingCycle).toBe("yearly");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   RAASTA 3 — chakkar band hota hai ya nahi. Yahi ek jaanch aaj ka Reply-To bug pakad leti.
   ───────────────────────────────────────────────────────────────────────────── */
describe("chakkar band hai — jo bahar jata hai wo wapas aata hai", () => {
  it("Reply-To wahi mailbox hai jise app padhti hai, owner ka address NAHI", () => {
    /* 31 Aug 14:32 — asli jawab gayab ho gaya. replyTo pardeep@anutech.in tha, connector
       sales@anutech.in padhta hai, aur `inbound_emails` me us aadhe ghante me ek bhi row
       nahi thi. Chup-chaap. */
    expect(replyToAddress(INGEST, TENANT.email)).toBe("sales@anutech.in");
    expect(replyToAddress(INGEST, TENANT.email)).not.toBe(TENANT.email);
  });

  it("koi connected mailbox na ho to owner ka address — par PEHLE nahi", () => {
    expect(replyToAddress([], TENANT.email)).toBe(TENANT.email);
  });

  it("jawab ka subject grahak ke thread me girta hai", () => {
    /* 31 Aug — AI ne apna subject bana liya tha, Gmail ne alag conversation bana di, aur
       Pardeep ke liye wo "koi jawab nahi aaya" ke barabar tha. */
    const theirs = "mujhe 32 email id ke liye quote chahiye google business starter";
    expect(replySubject(theirs, "Re: Google Workspace quotation - Omega")).toBe(`Re: ${theirs}`);
  });
});
