import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { resolveGeminiConfig, geminiJson } from "./gemini";
import {
  buildSalesAgentPrompt, parseSalesAgentDecision, applyHandoverRules, authorisedTotalsFor,
} from "./sales-agent";

/**
 * SUKHA CHALAN — asli AI se poochho ki wo KYA likhta, bina kuch bheje aur bina kuch likhe.
 *
 * ─── YE KYUN BANA ──────────────────────────────────────────────────────────
 * 30 Aug 2026 ko Pardeep ne poochha: "kya ye local par test nahi ho sakta?" — teen baar
 * deploy karne, email bhejne aur do minute intezaar karne ke baad, sirf ye dekhne ke liye
 * ki AI ne kya likha. Har chakkar lagbhag pandrah minute ka tha.
 *
 * Wo sahi the aur ye pehle hi hona chahiye tha. Us din ki teeno gadbadein — subject na
 * pahunchna, GSTIN maangna, aur "after the discount" par reply ka ruk jana — yahan **das
 * second** me dikh jatin.
 *
 * ─── YE KUCH BADALTA NAHI ──────────────────────────────────────────────────
 * Koi lead nahi, koi quote nahi, koi invoice number nahi, aur **koi email nahi**. Ye sirf
 * teen cheezein chalata hai: prompt banata hai, Gemini se jawab leta hai, aur usi guard se
 * guzarta hai jo asli raaste par lagta hai (`applyHandoverRules`). Database sirf PADHA jata
 * hai — Gemini ki chaabi ke liye.
 *
 * Ye farak zaroori hai. `[selftest]` marker asli lead AUR asli quote banata hai, aur quote
 * ek aisa GST number kha jata hai jo wapas nahi milta (dekho lib/inbound/self-test.ts). Wo
 * poore raaste ka test hai; ye sirf DIMAAG ka.
 *
 * ─── CHALANE KA TARIKA ─────────────────────────────────────────────────────
 *   DRY_RUN=1 DRY_SUBJECT="mujhe 70 email id ka quote chahiye google workspace business starter" \
 *     npx vitest run src/lib/ai/sales-dry-run.test.ts
 *
 *   DRY_BODY bhi de sakte hain. Na dein to body khaali maani jayegi — theek waise hi jaise
 *   Pardeep ke asli test email me thi, jahan poori baat subject me thi.
 *
 * Bina `DRY_RUN` ke ye SKIP hota hai, isliye `npm run test` par ye Gemini ko nahi bulata.
 */

const ON = process.env.DRY_RUN === "1";

const SUBJECT = process.env.DRY_SUBJECT
  ?? "mujhe 70 email id ka quote chahiye google workspace business starter";
const BODY = process.env.DRY_BODY ?? "";
const SEATS = process.env.DRY_SEATS ? Number(process.env.DRY_SEATS) : 70;

const TENANT = "fbb976f1-9090-4f10-9726-0901bd144e42";

describe.skipIf(!ON)("sukha chalan — AI kya likhta, aur jayega ya rukega", () => {
  it("draft banata hai aur guard se guzarta hai", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !svc) throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY chahiye — .env.local se lo.");

    /* PADHNE ke liye. Is file me ek bhi insert/update nahi hai. */
    const admin = createClient(url, svc);

    const { data: items } = await admin
      .from("items").select("name, msrp, wholesale").eq("tenant_id", TENANT);
    const catalog = (items ?? []).map((i) => ({
      sku: i.name, name: i.name, vendor: "google",
      /* items.msrp per SEAT per MONTH hai — saalana nahi. Wahi bhool 24 Aug ko har daam
         ka baarahvaan hissa quote kara rahi thi (c6f88a3). */
      msrpPerSeatPerYear: (i.msrp ?? 0) * 12,
      wholesalePerSeatPerYear: (i.wholesale ?? 0) * 12,
      monthlyFlexPerSeatPerMonth: null,
    }));
    expect(catalog.length, "catalogue khaali hai — tab ye test kuch saabit nahi karta").toBeGreaterThan(0);

    const lead = {
      leadId: "L-DRYRUN", company: "Dry Run Pvt Ltd", contactName: "Pardeep",
      seats: SEATS, plan: catalog[0].name,
      customerContact: "dryrun@example.com", channel: "email" as const,
      existingQuoteId: null, deliveredQuoteId: null,
    };

    const built = buildSalesAgentPrompt({
      lead,
      history: [],
      /* Wahi shakl jo ingest.ts bhejta hai — subject naam ke saath, phir body. */
      incoming: SUBJECT.trim() ? `Subject: ${SUBJECT.trim()}\n\n${BODY}`.trim() : BODY,
      catalog,
      sellerName: "ANUTECH DIGITAL PVT LTD",
      sellerEmail: "sales@anutech.in",
      authorisedTotals: authorisedTotalsFor(catalog, { plan: lead.plan, seats: SEATS }),
    } as Parameters<typeof buildSalesAgentPrompt>[0]);

    const gem = await resolveGeminiConfig(admin as never, TENANT);
    if (!gem.apiKey) throw new Error("Gemini ki chaabi nahi mili — tenant_secrets padha nahi ja saka.");

    const raw = await geminiJson<unknown>({
      apiKey: gem.apiKey, model: gem.model, tenantId: gem.tenantId,
      system: built.system, user: built.user,
      temperature: 0.2, label: "sales-dry-run",
    });
    expect(raw, "Gemini ne kuch nahi lautaya").toBeTruthy();

    const parsed = parseSalesAgentDecision(raw);
    expect(parsed.ok, `decision parse nahi hua: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
    if (!parsed.ok) return;

    const guarded = applyHandoverRules({
      decision: parsed.decision,
      seats: SEATS,
      allowedMoney: built.allowedMoney,
    });

    const d = guarded.decision;
    const send = d.action_required !== "HANDOVER_TO_HUMAN";

    /* Yahi is file ka poora maqsad — nateeja PADHNE layak ho. */
    console.log([
      "",
      "════════ SUKHA CHALAN ════════",
      `SUBJECT : ${SUBJECT}`,
      `BODY    : ${BODY || "(khaali)"}`,
      `SEATS   : ${SEATS}`,
      "",
      `FAISLA  : ${send ? "✅ JAYEGA" : "⛔ RUKEGA (insaan ke paas)"}`,
      guarded.overruled ? `GUARD   : ${guarded.reason}` : "GUARD   : kuch nahi roka",
      `INTENT  : ${d.customer_intent}`,
      "",
      "──── jo customer ko jata ────",
      `Subject: ${d.generated_response.email_subject}`,
      "",
      d.generated_response.body_text,
      "═════════════════════════════",
      "",
    ].join("\n"));

    /* Kuch assert nahi kiya jata — ye jaanch nahi, DEKHNE ka aujaar hai. Yahan ek
       expectation likh dena is file ko un teen bugs par laal kar deta jo iske hone ka
       kaaran hain, aur tab koi ise chalata hi nahi. Padhne wala faisla karta hai. */
    expect(d.generated_response.body_text.length).toBeGreaterThan(0);
  }, 60_000);
});
