/**
 * The pipeline as folders a salesperson can act on.
 *
 * ─── WHY NOT STAGE TABS ─────────────────────────────────────────────────────
 * `new / contact / demo / trial / quote / won / lost` describes where a deal sits in
 * a process. It does not answer the question a rep opens this page with, which is
 * "what do I do next?" — a ₹4L deal going cold and a ₹5k deal going cold are the same
 * tab, and a lead whose follow-up was due yesterday is in whichever stage it happened
 * to be parked in.
 *
 * ─── THE MONEY THRESHOLD IS IMPORTED; THE "HOT" RULE IS DELIBERATELY NARROWER ─
 * HIGH_VALUE (₹1,00,000) comes from heat.ts and is not re-typed here — a second copy
 * would drift from the heat badge the same rep is looking at three inches away.
 *
 * `isHotLead` is NOT used wholesale, and that is a decision worth arguing with. It
 * counts demo, trial AND quote as hot, which is right for a badge meaning "advanced
 * in the funnel". As a FOLDER rule it would make Hot Deals a superset of Quote Sent —
 * every quoted lead in both — and two folders where one is entirely inside the other
 * teaches a rep that the folders do not mean anything.
 *
 * So Hot Deals is the two signals that actually say "this one, today": a human
 * flagged it high priority, or it is worth ₹1,00,000 or more. The badge keeps its own
 * broader meaning and the two are not in conflict; they answer different questions.
 *
 * ─── JUNK AND LOST ARE NOT WORK ─────────────────────────────────────────────
 * Both are kept out of every working folder. A junk lead in Hot Deals because someone
 * typed ₹5,00,000 into a spam enquiry is exactly the sort of thing that teaches a rep
 * to stop trusting the folder counts.
 *
 * ─── JUNK IS NOT A FOLDER AT ALL ────────────────────────────────────────────
 * There used to be an "archived" folder holding `lost` OR `is_junk`, next to a Junk chip
 * of its own — so every binned lead sat in two places under two names, and neither chip
 * could be described in one sentence. "We competed and lost" and "this was never a real
 * enquiry" are different facts that lead to different actions: one is win/loss analysis,
 * the other is a lead-source problem.
 *
 * So `lost` means lost, junk belongs to the Junk view, and no lead is ever in both.
 *
 * ─── FOLDERS PARTITION; FLAGS OVERLAP — AND THE UI SAYS WHICH IS WHICH ──────
 * Redesigned 17 Aug 2026, on direct feedback. The row used to read
 * "All open 8 · Inbox 7 · Hot Deals 2", and Pardeep did what any reader does with
 * numbers sitting side by side: added them. 7 + 2 = 9 over 8 leads. The overlap was
 * intentional and defensible — and it does not matter, because a design the owner
 * himself has to ask three questions about is a design that failed. When the numbers
 * confuse the person the page was built for, the numbers are wrong even when they
 * are right.
 *
 * So the two kinds of chip are now two different TYPES:
 *
 *   FOLDERS answer "where is it?" — every open lead is in exactly ONE, cut by stage,
 *   and they visibly add up: Inbox + In Talks + Quote Sent + Demo/Trial = All open.
 *   The invariant is pinned by a test (`exactly one folder`), not by hope.
 *
 *   FLAGS answer "which of them matter right now?" — ⚡ Hot and ⏰ Due overlap the
 *   folders on purpose (a hot lead is still IN Inbox; that is the point of a flag).
 *   They render in their own group, after a divider, styled differently, so nobody
 *   is invited to add them to anything.
 *
 * The old design used action-folders ("Hot Deals" as a place). The insight worth
 * keeping from it lives on in the flags; the arithmetic honesty lives in the folders.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { isHighValueLead } from "./heat";

/** Mutually exclusive — every open lead is in exactly one. */
export type SalesStageFolder =
  | "inbox" | "talks" | "quoted" | "proving" | "won" | "lost";
/** Overlays — a lead keeps its folder AND may carry any number of flags. */
export type SalesFlag = "hot" | "followup";
/** Everything a chip can select. One union so the page holds one piece of state. */
export type SalesFolder = SalesStageFolder | SalesFlag;

export interface SalesFolderMeta {
  id:    SalesFolder;
  label: string;
  icon:  string;
  /** Plain English for when it is empty. */
  hint:  string;
  /** R-835: the empty hint on /leads, where the cards are leads, not deals. Unset = `hint`. */
  leadHint?: string;
}

/* The partition, in funnel order. Labels are the rep's words for each stop, and the
   Kanban columns use the same cuts — chips, list and board can never disagree. */
export const SALES_FOLDERS: readonly SalesFolderMeta[] = [
  { id: "inbox",   label: "Inbox",       icon: "📥", hint: "New enquiries nobody has picked up yet." },
  { id: "talks",   label: "In Talks",    icon: "📞", hint: "Nobody is in conversation right now — contacted leads sit here." },
  { id: "quoted",  label: "Quote Sent",  icon: "📄", hint: "No proposals waiting on a customer's answer." },
  { id: "proving", label: "Demo / Trial",icon: "🧪", hint: "No demos or trials running — post-quote deals being proven sit here." },
  { id: "won",     label: "Won",         icon: "🏆", hint: "No deals closed yet — won leads collect here." },
  { id: "lost",    label: "Lost",        icon: "📁", hint: "No deals lost yet. Junk is separate — that is the 🚫 view.",
    leadHint: "No leads lost yet. Junk is separate — that is the 🚫 view." },
] as const;

/* The flags. Rendered after a divider, styled as filters, never summed with folders. */
export const SALES_FLAGS: readonly SalesFolderMeta[] = [
  { id: "hot",      label: "Hot",     icon: "⚡", hint: "Nothing marked high priority or worth ₹1,00,000 or more." },
  { id: "followup", label: "Due",     icon: "⏰", hint: "Nothing overdue — every follow-up date is still ahead." },
] as const;

export function isSalesFlag(id: SalesFolder): id is SalesFlag {
  return id === "hot" || id === "followup";
}

/** The fields the folder rules read. Structural so tests need no DB row. */
export type FolderLead = Pick<Lead, "stage" | "value" | "priority"> & {
  is_junk:        boolean | null;
  follow_up_date: string | null;
};

/** Lost, won or junk — closed one way or another, and not today's work. */
export function isClosed(l: FolderLead): boolean {
  return l.stage === "won" || l.stage === "lost" || l.is_junk === true;
}

/**
 * A follow-up that has come due.
 *
 * `<=` and not `<`: a follow-up dated today IS due today. Comparing dates as ISO
 * strings works because both sides are YYYY-MM-DD, and `todayISO` is the caller's
 * IST date (localDateISO) — using the browser's local date would move the boundary
 * for anyone travelling.
 */
export function isFollowUpDue(l: FolderLead, todayISO: string): boolean {
  if (isClosed(l)) return false;
  if (!l.follow_up_date) return false;
  return l.follow_up_date.slice(0, 10) <= todayISO;
}

export function inSalesFolder(l: FolderLead, folder: SalesFolder, todayISO: string): boolean {
  switch (folder) {
    /* ── THE PARTITION — cut by stage, so the counts visibly add up ─────────
       Junk is in NO folder (the 🚫 view is its only home), which is what lets
       "Inbox + In Talks + Quote Sent + Demo/Trial = All open" hold. */
    case "inbox":
      /* Untouched. Once someone has made contact it is no longer an inbox item, even
         if nothing has been agreed. */
      return l.is_junk !== true && l.stage === "new";

    case "talks":
      return l.is_junk !== true && l.stage === "contact";

    case "quoted":
      return l.is_junk !== true && l.stage === "quote";

    case "proving":
      return l.is_junk !== true && (l.stage === "demo" || l.stage === "trial");

    case "won":
      /* Junk is NOT excluded here, deliberately: a lead marked both won and junk is a
         data contradiction, and it should show up in Won where somebody will notice it
         rather than be filtered into silence. */
      return l.stage === "won";

    case "lost":
      /* Lost only. Junk has its own view — see the header. */
      return l.stage === "lost";

    /* ── THE FLAGS — overlays that deliberately overlap the folders ─────────── */
    case "hot":
      /* Read as OR: a ₹4,00,000 deal nobody flagged is still the biggest thing on the
         page, and a flagged ₹20,000 deal is still what the rep said to chase.
         Deliberately NOT isHotLead — see the header. */
      return !isClosed(l) && (l.priority === "high" || isHighValueLead(l));

    case "followup":
      return isFollowUpDue(l, todayISO);
  }
}

export function salesFolderCounts(
  leads: readonly FolderLead[],
  todayISO: string,
): Record<SalesFolder, number> {
  const counts = {
    inbox: 0, talks: 0, quoted: 0, proving: 0, won: 0, lost: 0,
    hot: 0, followup: 0,
  } as Record<SalesFolder, number>;
  for (const l of leads) {
    for (const f of [...SALES_FOLDERS, ...SALES_FLAGS]) {
      if (inSalesFolder(l, f.id, todayISO)) counts[f.id] += 1;
    }
  }
  return counts;
}

/**
 * ₹ of open pipeline in a folder.
 *
 * Won and lost return 0 even when the folder IS won or lost: a "total" beside a folder
 * name reads as pipeline, and putting closed money in it inflates the number a rep
 * reports upward.
 */
export function salesFolderValue(
  leads: readonly FolderLead[],
  folder: SalesFolder,
  todayISO: string,
): number {
  if (folder === "won" || folder === "lost") return 0;
  return leads
    .filter((l) => inSalesFolder(l, folder, todayISO))
    .reduce((sum, l) => sum + (l.value ?? 0), 0);
}
