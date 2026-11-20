/**
 * Class names and column widths for the lead list's spreadsheet grid — moved verbatim out
 * of (app)/leads/page.tsx (S35, 28 Sep 2026). The colgroup widths and the <th>/<td> order
 * are two halves of one column; read the notes on LEADLIST_COL_WIDTHS before changing either.
 */

/* `users.color` me token ka NAAM hota hai, CSS colour nahi. Jo token Avatar jaanta hai
   sirf wahi bheje jate hain; anjaan naam `muted` par gir jata hai — warna wo chup-chaap
   transparent circle bana deta hai (dekho owner cell ka comment). */
export type AvatarColor = "ink" | "amber" | "emerald" | "indigo" | "rose" | "slate" | "muted";
export const AVATAR_TOKENS: readonly string[] = ["ink", "amber", "emerald", "indigo", "rose", "slate", "muted"];

// Spreadsheet mode: Stage / Value / Priority / Follow-up are all editable in place, so the
// four fields a rep changes most never need the drawer.
//
// ─── THIS LIST IS HALF OF WHAT A COLUMN IS ─────────────────────────────────
// `table-fixed` reads its widths from here, so removing a <th> and its <td> without
// removing the entry leaves every later column wearing its neighbour's width. That is
// exactly what happened when Contact and Last update came out on 26 Aug 2026: the Stage
// select spilled across Plan and the row looked broken.
//
// Contact folded under the company name and Last update went entirely, so their 21%
// is redistributed — most of it to company, which now carries the name, the intent
// badge and the contact line, and a little to stage, whose select was already tight.
/* Header cell — spreadsheet ki tarah: har column apni line se alag, aur wo line
   header se chalti hui rows tak jaati hai. `border-r` hi wo ek cheez hai jo ek modern
   list ko grid jaisa dikhata hai. */
export const GRID_TH =
  "sticky top-0 z-10 bg-paper-2 border-r border-hairline px-2 py-1.5 text-3xs " +
  "font-semibold text-ink-3 uppercase tracking-wider text-left whitespace-nowrap";

/* Row ki unchai. Research (Pencil & Paper) teen padav deti hai — 40 / 48 / 56px — aur
   kehti hai ki chunav USER ka hona chahiye, kyunki bade monitor par saans chahiye aur
   chhote par zyada rows. Padding CSS variable se aati hai, warna 12 cell call-sites
   badalne padte. */
export const DENSITY_PY: Record<"compact" | "regular" | "relaxed", string> = {
  compact: "0.25rem", regular: "0.375rem", relaxed: "0.625rem",
};

/**
 * Body cell — wahi vertical line, kam padding, aur `whitespace-nowrap`.
 *
 * Nowrap isliye ki bina uske "26 Aug 2026" teen line me tootta tha aur us ek row ki
 * unchai baaki sab se alag ho jati thi. Spreadsheet ka aadha faayda hi ye hai ki har
 * row barabar ho — aankh scan karti hai, padhti nahi. Jo cell me na samaye wo truncate
 * hota hai aur poora `title` me milta hai.
 *
 * `overflow-hidden` uske saath HONA HI CHAHIYE, aur ye 26 Aug 2026 ko naapa gaya. Akela
 * nowrap text ko lapetne se rokta hai par cell ki seema par kaatta NAHI — to lamba plan
 * naam apne column se bahar nikal kar padosi par chadh gaya, aur screen par "Contacted"
 * ke upar "GW · Busin…" likha dikha. Table gadbad nahi tha, sirf clip nahi ho raha tha.
 */
/**
 * Body cell — lamba text WRAP hota hai, kata nahi.
 *
 * ─── Ye 26 Aug 2026 ko do baar palta, aur dono baar wajah thi ──────────────
 * Pehle sab `whitespace-nowrap` tha. Us se "26 Aug 2026" teen tukdo me tootna band hua
 * (row ki unchai barabar ho gayi), par nateeja ye nikla ki lamba email aur company ka
 * naam ellipsis me kat jate the — aur kata hua naam poori pehchan hi le uda ta hai.
 *
 * Pardeep: "agar kisi column ka text bada hota hai to wrap kare".
 *
 * Isliye ab batwara hai, aur wo cheez ke SWABHAV se hai:
 *   · TEXT (company, contact, email, plan) — wrap. Ye lambe hote hain aur poore padhne
 *     layak hone chahiye.
 *   · ATOMIC (phone, seats, value, follow-up, stage) — nowrap, `GRID_TD_ATOM`. "26 Aug
 *     2026" ya "+91 99999 95482" ko todna use padhne me MUSHKIL karta hai, aasan nahi;
 *     ye ek ikai hai, vaakya nahi.
 *
 * `align-top` isliye ki jab ek cell do line ka ho jaye, baaki cells uske beech me latak
 * kar row ko tirchha na dikhayein.
 */
export const GRID_TD =
  "border-r border-hairline px-2 py-[var(--cell-py)] align-middle break-words overflow-hidden";

/** Wo cells jinka text ek IKAI hai — date, number, phone. Inhe todna nahi. */
export const GRID_TD_ATOM =
  "border-r border-hairline px-2 py-[var(--cell-py)] align-middle whitespace-nowrap overflow-hidden";

/* ── Jame hue column (26 Aug 2026) ───────────────────────────────────────────
   Pardeep: "check boxes aur three dots wale hamesha visible rahe chahe horizontal
   scroller bhi aaye" — aur phir "company column bhi".

   Wajah saaf hai: chaudai kheenchne ke baad table scroll karta hai, aur scroll karte hi
   ye pata hi nahi chalta ki ye row KISKI hai. Ek grid jisme naam scroll ho jaye, wo
   ginti to dikhata hai par pehchan nahi.

   Do cheezein zaroori hain, aur dono bhoolne par bug lagta hai:

   1. `bg-*` — sticky cell ke NEECHE se baaki cells guzarti hain. Bina apne background ke
      wo aar-paar dikhti hain aur do text ek doosre par chhap jate hain.
   2. z-index ka kram — header bhi sticky hai (top-0). Kone wale do cell (checkbox aur
      company ka header) DONO taraf sticky hain, isliye unhe sabse upar rehna hoga,
      warna scroll par wo apne hi body cell ke neeche chale jate hain. */
export const STICK_L_SELECT  = "sticky left-0 z-20";
/** Pehchan wala column, checkbox ke theek baad — isliye 40px, jo `select` ki fixed
    chaudai hai. (29 Aug 2026 tak isme Company thi, ab Contact.) */
export const STICK_L_IDENTITY =
  "sticky left-[40px] z-20 border-r-2 border-r-ink-4 " +
  /* ── Jame hue hisse ka kinara, aur ye SAAF dikhna chahiye ──────────────────
     Pehle yahan 0.08 alpha ki chhaya thi — naap kar dekha ki wo lagbhag dikhti hi nahi.
     Uska nateeja ye tha ki thoda scroll karne par agla column company ke peeche sarakta
     tha aur uska pehla akshar kat jata ("Susen" → "usen"), par kinara na dikhne ki wajah
     se wo "scroll hua hai" jaisa nahi, "toot gaya hai" jaisa lagta tha — Pardeep ne isi
     ko "sahi se kaam nahi kar raha" kaha.

     Aadhi kati cell sticky column ka SWABHAV hai (spreadsheet me bhi wahi hota hai); jo
     theek karne wali cheez thi wo ye batana tha ki kinara KAHAN hai. Isliye gehri lakeer
     (border-r-2 ink-4) aur 0.18 alpha ki chhaya. */
  "shadow-[8px_0_8px_-5px_rgba(0,0,0,0.18)]";
export const STICK_R_ACTIONS = "sticky right-0 z-20 border-l border-hairline";
/** Header ke liye wahi jagah, par ooncha z — wo top-0 par bhi sticky hai. */
export const STICK_HEAD = "z-30";

/* ── Excel-jaisi grid: har field ka APNA column (26 Aug 2026) ──────────────────
   Pardeep: "ye ek table ki tarah show karo jiska header bhi ho… jaise excel sheet
   banti hai".

   Pehle contact ka naam, email aur phone teeno `company` cell ke andar thuse the — ek
   card se aayi hui aadat, jahan wo teen line ban jate the. Spreadsheet me wo teen ALAG
   column hote hain: tabhi aankh ek hi cheez ko upar-neeche scan kar sakti hai, aur
   tabhi sort karne layak bhi banta hai.

   `table-fixed` ke saath ye colgroup hi ekmatra jagah hai jo chaudai tay karti hai — aur
   yahi wo galti hai jo is file me ab TEEN baar ho chuki hai: column hatate waqt sirf
   `<th>`/`<td>` hataya aur colgroup chhod diya, jisse har agla column apne padosi ki
   chaudai pehen leta hai. Column badlo to DONO badlo.

   ⚠️ Yahan pehle likha tha "Yogfal theek 100% rakha gaya hai". **Wo sach nahi tha** —
   29 Aug 2026 ko jodkar dekha to 109% nikla, aur `table-fixed` us farq ko table ko chauda
   kar ke poora karta hai. Ye ek aisa comment tha jo apni hi file ki galti chhupa raha tha.
   Ginti neeche likh di gayi hai; agli baar comment padhne ke bajaye JODNA. */
/* ── CONTACT pehle, COMPANY baad me (29 Aug 2026) ────────────────────────────
   Pardeep: "bina company ke lead ban sakti hai, par bina contact ke lead nahi ban sakti."
   Isliye jama hua (sticky) pehla column — jo scroll karte waqt batata hai ki row KISKI
   hai — ab contact ka hai. Jo cheez har lead par hoti hai, wahi pehchan ban sakti hai.

   Aur ye sirf table ka badlav nahi hai: dono lead form bhi usi din badle: pehle
   `company` min(2) maangta tha aur `contact_name` optional tha — theek ulta. */
/* ── R-2970 (20 Nov 2026): the column list moved to lib/leads/list-columns.ts ─────────
   The fixed LEADLIST_COL_ORDER / LEADLIST_COL_WIDTHS pair (and its 100% sum, which went
   wrong three times above) is gone. Each person now picks the shown columns and their
   order; the render order is renderOrder(shown), the first-paint widths are
   fallbackPercents(shown) — computed from one px table, so the sum is 100 by
   construction — and the measured first fit keeps phone / value / follow-up whole.
   Phone and Email are back as their own columns; Plan, Seats and Wait went to "Add a
   column" so the default still fits 1280 (measurements in list-columns.ts). */

export type Density = "compact" | "regular" | "relaxed";
