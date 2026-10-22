/**
 * The 1-tap call-outcome chips: what each one actually changes.
 *
 * A rep working a call list needs one tap per lead, not a menu. But "one tap" is
 * exactly where a CRM starts lying: the fastest way to make a pipeline look busy is a
 * button that advances a stage without the thing it claims having happened. So the
 * rule for every chip in here is that it records what the rep DID, never what we hope
 * it means.
 *
 * ─── 26 AUG 2026: CHIPS AB STAGE BADAL SAKTE HAIN. NIYAM NAHI BADLA. ────────
 * Pardeep ne stage ka manual dropdown hatane ko kaha — stage sirf us baat se badle jo lead
 * ke saath sach me hui. Us se pehle is file ka har chip `stageChange: null` lautata tha.
 *
 * Us purane faisle ki DONO wajah aaj bhi sahi hain, aur dono neeche zinda hain. Jo badla wo
 * ye hai: pehle EK BHI chip aisa nahi tha jo "insaan se baat ho gayi" kehta ho, isliye
 * desktop par stage aage badhane ka ekmatra raasta dropdown tha. Ab `talked` hai.
 *
 * Niyam wahi purana hai, `stage-after-quote-sent.ts:24` se: **automation ek FACT par khulta
 * hai, andaze par kabhi nahi.** Isliye chip tabhi stage likhta hai jab chip ka apna naam
 * theek wahi cheez ho jo stage ka naam kehta hai — "Baat ho gayi" = contact. Ismein
 * andaza kahin nahi hai.
 *
 * ─── DO CHIP JO AAJ BHI STAGE KO HAATH NAHI LAGATE ─────────────────────────
 * "Send Quote" sirf quote builder kholta hai. Ye `stage = "quote"` NAHI karta.
 *
 * Ye susti nahi, pipeline aur wish-list ka farq hai. `stage = "quote"` teen jagah
 * load-bearing hai: heat.ts ka intentTier() ise advanced stage kehta hai, heatScore() use
 * funnel progress me 1.00 deta hai, aur Deals pipeline use qualified ginta hai. Tap par
 * stage likhne wala chip ek rep ko poori screen bhar hot, quote-stage leads bana dega bina
 * ek bhi quote maujood hue — aur us par bana forecast kalpana hoga. Stage tab hilta hai jab
 * quote row sach me banti hai, jo `stage-after-quote-sent.ts` karta hai.
 *
 * "No answer" bhi wahi niyam. Bina uthi call ek KOSHISH hai: wo log hoti hai aur lead kal
 * wapas aati hai. Use `contact` par le jaana matlab funnel ghanti bajne ko insaan tak
 * pahunchna gin raha hai, aur uske baad ka har "is hafte 40 leads contact ki" galat hoga.
 * `talked` isi liye alag chip hai — kyunki wo do alag baatein hain.
 *
 * ─── DATES ARE COMPUTED IN LOCAL TIME, ON PURPOSE ──────────────────────────
 * `follow_up_date` is a DATE column, and the users are in IST (UTC+5:30).
 * `new Date().toISOString().slice(0,10)` returns YESTERDAY's date for any moment
 * before 05:30 IST, so a rep tapping "Call tomorrow" at 7am would sometimes book the
 * call for today and sometimes for yesterday. This module formats from local date
 * parts instead. (The same `toISOString().split("T")[0]` pattern appears elsewhere in
 * this codebase — worth a sweep, but not silently changed from here.)
 */
import type { Lead } from "@/lib/supabase/database.types";
/* The activity kind is imported rather than typed as a loose string, so a chip cannot
   invent a kind the log_lead_activity RPC will reject at runtime. An `as any` at the
   call site would have made that a production error instead of a compile one. */
import type { LeadActivityKind } from "@/lib/queries/lead-activities";
import { advanceStage, markLost, type Stage, type StageAdvance } from "./stage-advance";

export type LeadOutcome =
  | "talked"
  | "no_answer"
  | "call_tomorrow"
  | "demo_done"
  | "trial_started"
  | "send_quote"
  | "mark_lost"
  | "mark_junk";

/** YYYY-MM-DD from LOCAL date parts — never via toISOString(). See the header. */
export function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Tomorrow, in local time, as YYYY-MM-DD. Month and year roll over correctly. */
export function tomorrowISO(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return localDateISO(d);
}

export interface OutcomeEffect {
  /**
   * Columns to write on the lead. Null when the chip writes nothing.
   *
   * `stage` yahan JAAN-BOOJH KAR nahi hai — wo `useChangeLeadStage` se guzarta hai, jo
   * `lost` par loss-reason poochhta hai. Dekho `applyOutcome` me `withStage` ka comment.
   */
  patch: Partial<Pick<Lead, "follow_up_date" | "is_junk">> | null;
  /** An activity row to log, so the attempt is on the record. */
  activity: { kind: LeadActivityKind; detail: string } | null;
  /** The chip opens a screen instead of (or as well as) writing. */
  navigate: "quote" | null;
  /** Confirmation text. Says what happened, including the new date. */
  toast: string;
  /** True when the rep can put it back — drives whether an Undo action is offered. */
  undoable: boolean;
  /**
   * Stage ka faisla, hamesha apni wajah ke saath — `null` sirf un chips par jo stage se
   * matlab hi nahi rakhte. Jab `nextStage` null ho par `reason` maujood ho, matlab chip ne
   * stage badalna CHAHA tha aur niyam ne roka; wo user ko dikhna chahiye, chupna nahi.
   */
  stage: StageAdvance | null;
}

/** What the rules need to know about the lead. `stage` decides every forward-only refusal. */
export type OutcomeLead = Pick<Lead, "company" | "contact_phone" | "follow_up_date" | "stage">;

/**
 * What a chip does to a lead.
 *
 * Pure: no mutation, no navigation, no toast. The caller performs the effect. That
 * keeps the RULES testable without a Supabase mock or a router, which is why the
 * previous scattered quick-actions had none.
 */
export function applyOutcome(
  outcome: LeadOutcome,
  lead: OutcomeLead,
  now: Date = new Date(),
  /**
   * Baat me kya hua — call ke SAATH, alag row me nahi.
   *
   * Pardeep, 26 Aug 2026: "maine lead se phone par baat ki, aur jo baat hui wo kahan
   * record hogi". Us waqt do alag kaam karne padte the: note box me likh kar Save
   * (`note` row), phir "Baat hui" dabao (`call` row). Timeline me do tukde, aur baat ka
   * mazmoon us call se juda hi nahi hota jiska wo mazmoon tha.
   *
   * Ab wahi ek row me jata hai. Khaali chhod dena theek hai — row ke chips 1-tap wale
   * fast path hain, aur ek rep call list par kaam karte waqt likhna nahi chahta.
   */
  note = "",
): OutcomeEffect {
  const eff = baseOutcome(outcome, lead, now);
  const said = note.trim();
  if (!said || !eff.activity) return eff;
  /* Quotes me, aur `·` se juda — `—` se nahi. Do wajah: "No answer" ki detail khud
     "— retrying tomorrow" par khatam hoti hai, to ek aur dash "— retrying tomorrow —
     20 seats chahiye" bana deta tha; aur quotes batate hain ki ye hissa AADMI ne likha
     hai, app ne nahi. Ek timeline jisme dono ek jaise dikhein, wo baad me padhne wale
     ko ye nahi bata sakti ki kaun sa lafz customer ka tha. */
  return { ...eff, activity: { ...eff.activity, detail: `${eff.activity.detail} · "${said}"` } };
}

function baseOutcome(
  outcome: LeadOutcome,
  lead: OutcomeLead,
  now: Date = new Date(),
): OutcomeEffect {
  const tomorrow = tomorrowISO(now);
  const who = lead.company || "this lead";

  /* ── Stage kabhi `patch` me nahi jata, aur ye ahem hai ─────────────────────
     Pehla prayaas `patch.stage` likhta tha. Wo `useChangeLeadStage` ko bypass kar deta —
     wahi hook jo `lost` par pehle loss-reason poochhta hai aur reason na milne par move
     CANCEL kar deta hai. Uske apne header ke shabdon me: "A loss with no reason is the
     exact thing this feature exists to prevent." Us hook ki poori wajah hi ye thi ki stage
     saat alag jagah se badla ja raha tha; patch me stage ghusaana aathvi jagah bana deta.

     Isliye `stage` apne alag khaane me lautta hai, aur caller use us hook se guzarta hai.
     Mana hone par bhi lautta hai — wajah ke saath — taaki "kuch nahi hua" ke bajaye
     "ye wajah thi" dikhaya ja sake. */
  const withStage = (
    adv: StageAdvance,
    rest: Omit<OutcomeEffect, "stage">,
  ): OutcomeEffect => ({ ...rest, stage: adv });

  switch (outcome) {
    case "talked":
      /* Wo chip jo pehle maujood hi nahi tha, aur jiski gairhaazri me dropdown zinda tha.
         "Baat ho gayi" theek wahi cheez hai jo `contact` stage ka naam kehta hai — ismein
         andaza nahi hai, isliye ye likhne ka haqdaar hai. Follow-up ko haath nahi lagaya:
         agli baat kab karni hai, ye baat ho jaane se tay nahi hota. */
      /* ── EK naam, har jagah (26 Aug 2026) ────────────────────────────────────
         Pehle button "Call log" kehta tha, toast "baat hui", aur record bhi "Baat hui".
         Maine tarq diya tha ki button ek KAAM ka naam hai aur record ek NATEEJE ka —
         theory me theek, par Pardeep do baar isi par ruka: "panel me alag hai aur yaha
         alag". Do naam ka koi faayda nahi jab dekhne wala har baar ruk jaye.

         Par record me "Call log" likhna bhi galat hota: timeline ka TITLE pehle se
         "Call logged" hota hai, to detail me wahi baat do baar aati.

         Isliye prefix hi hata diya. Title kehta hai ki call thi; detail wo batati hai jo
         title nahi keh sakta — kis number par, aur kya baat hui. "No answer" apna prefix
         RAKHTA hai, kyunki wahi us row ka farak hai. */
      return withStage(advanceStage(lead.stage, "contact"), {
        patch: null,
        activity: {
          kind: "call",
          /* Dono khaali ho to `—` — timeline ka title akela bhi poora hai, par ek khaali
             detail line "kuch load nahi hua" jaisi dikhti hai. */
          detail: lead.contact_phone?.trim() || "—",
        },
        navigate: null,
        toast: `${who} · call logged`,
        undoable: false,
      });

    case "no_answer":
      /* Logged as an attempt and pushed to tomorrow. The stage stays put — see the
         header. The phone number goes in the detail so the log is useful later even
         if the number is edited. */
      return {
        patch: { follow_up_date: tomorrow },
        activity: {
          kind: "call",
          detail: `No answer${lead.contact_phone ? ` · ${lead.contact_phone}` : ""} — retrying tomorrow`,
        },
        navigate: null,
        toast: `No answer logged · ${who} comes back tomorrow`,
        undoable: true,
        stage: null,
      };

    case "call_tomorrow":
      /* Always tomorrow, even when a later date is already set. The rep just said
         "tomorrow"; quietly keeping next Friday because it was further out would
         override the person holding the phone. */
      return {
        patch: { follow_up_date: tomorrow },
        activity: { kind: "note", detail: "Follow-up moved to tomorrow" },
        navigate: null,
        toast: `${who} scheduled for tomorrow`,
        undoable: true,
        stage: null,
      };

    case "demo_done":
      /* Demo ek asli ghatna hai jo koi karta hai — wo kisi email ya call se apne aap
         nahi pata chalti. Isliye ye chip us ghatna ko darj karta hai, andaza nahi lagata. */
      return withStage(advanceStage(lead.stage, "demo"), {
        patch: null,
        activity: { kind: "note", detail: "Demo done" },
        navigate: null,
        toast: `${who} · demo logged`,
        undoable: false,
      });

    case "trial_started":
      return withStage(advanceStage(lead.stage, "trial"), {
        patch: null,
        activity: { kind: "note", detail: "Trial started" },
        navigate: null,
        toast: `${who} · trial started`,
        undoable: false,
      });

    case "send_quote":
      /* Navigation only. NOT stage = "quote" — the stage moves when a quote row
         exists. See the header for why this matters more than it looks. */
      return {
        patch: null,
        activity: null,
        navigate: "quote",
        toast: "",
        undoable: false,
        stage: null,
      };

    case "mark_lost":
      /* Lost funnel me aage nahi, baahar hai — isliye `markLost`, `advanceStage` nahi.
         Won deal yahan se Lost nahi hoti; wo alag faisla hai. */
      return withStage(markLost(lead.stage), {
        patch: null,
        activity: { kind: "stage", detail: "Marked as lost" },
        navigate: null,
        toast: `${who} · Lost`,
        undoable: false,
      });

    case "mark_junk":
      /* Junk stage nahi hai — ye "ye lead asli hi nahi thi" hai. Isliye stage ko haath
         nahi lagta; `is_junk` alag column isi liye hai. */
      return {
        patch: { is_junk: true },
        activity: { kind: "note", detail: "Marked junk from the call queue" },
        navigate: null,
        toast: `${who} marked junk`,
        undoable: true,
        stage: null,
      };
  }
}

/** Chip presentation, so the row, the card and the swipe sheet render one vocabulary. */
export const OUTCOME_CHIPS: ReadonlyArray<{
  id: LeadOutcome;
  label: string;
  icon: string;
  tone: "default" | "amber" | "rose";
  /** Why this chip exists, for the title attribute — no mystery buttons. */
  hint: string;
  /** True when the chip needs a phone number to make sense. */
  needsPhone: boolean;
  /**
   * Kin stages par ye chip dikhna chahiye. `null` matlab hamesha.
   *
   * Saare chips hamesha dikhane se ek row me aath ho jate, aur "Demo hua" ek aisi lead par
   * dikhta jiska quote pehle hi ja chuka hai — jahan wo ek peechhe ka move hai aur niyam
   * use waise bhi mana kar dega. Chip ko wahin dikhao jahan wo sach me agla kadam hai.
   */
  showsAt: readonly Stage[] | null;
}> = [
  /* ── Label "Call log", par RECORD me likha "Baat hui" (26 Aug 2026) ──────────
     Pardeep ne drawer ka button "Call log" karwaya, aur row ka menu "Baat hui" hi dikha
     raha tha — ek kaam, do naam. Label badla.

     Par `applyOutcome` ki activity detail "Baat hui" hi rehti hai, aur wo jaan-boojh kar
     hai: timeline me uska jodidaar "No answer" hai, aur dono batate hain ki call me KYA
     HUA. Wahan "Call log" likhna us farak ko mita deta — dono call hi log hain. Button
     ek KAAM ka naam hai, record ek NATEEJE ka; ye ek jaise hone bhi nahi chahiye. */
  { id: "talked",        label: "Log call",      icon: "mobile", tone: "amber",
    hint: "You spoke to a person — the call is logged. The first time, the lead moves to Contacted; after that only the call is recorded.",
    needsPhone: true, showsAt: ["new", "contact", "demo", "trial", "quote"] },
  { id: "no_answer",     label: "No answer",    icon: "mobile", tone: "default",
    hint: "Log the attempt and bring this lead back tomorrow. Stage is not changed — ringing a phone is not contact.",
    needsPhone: true, showsAt: ["new", "contact", "demo", "trial", "quote"] },
  { id: "call_tomorrow", label: "Call tomorrow", icon: "clock",  tone: "amber",
    hint: "Move the follow-up date to tomorrow.", needsPhone: false, showsAt: null },
  { id: "demo_done",     label: "Demo done",     icon: "check",  tone: "amber",
    hint: "Moves the lead to Demo Done.", needsPhone: false, showsAt: ["new", "contact"] },
  { id: "trial_started", label: "Trial started", icon: "check",  tone: "amber",
    hint: "Moves the lead to Trial Active.", needsPhone: false, showsAt: ["contact", "demo"] },
  { id: "send_quote",    label: "Send quote",   icon: "send",   tone: "amber",
    hint: "Open the quote builder with this lead's details. The stage moves when the quote is actually created.",
    needsPhone: false, showsAt: null },
  { id: "mark_lost",     label: "Lost",          icon: "alert",  tone: "rose",
    hint: "Deal lost. A Won deal can't be marked Lost here.",
    needsPhone: false, showsAt: ["new", "contact", "demo", "trial", "quote"] },
  { id: "mark_junk",     label: "Junk",         icon: "alert",  tone: "rose",
    hint: "Hide as spam or a fake enquiry. Restorable from the Junk view.", needsPhone: false,
    showsAt: ["new", "contact"] },
];

/** Is lead par kaun se chip dikhne chahiye — stage ke hisaab se. */
export function chipsForStage(stage: string | null | undefined) {
  const s = (stage ?? "").trim().toLowerCase();
  return OUTCOME_CHIPS.filter(
    (c) => c.showsAt === null || (c.showsAt as readonly string[]).includes(s),
  );
}
