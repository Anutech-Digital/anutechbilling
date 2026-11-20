/**
 * Column ki chaudai jo user kheench kar badal sake — aur agli baar bhi wahi rahe.
 *
 * ─── YE KYUN BANA ──────────────────────────────────────────────────────────
 * 26 Aug 2026, Pardeep: "doosra column ko khinch kar bada ya chota kar sake". Leads
 * table ab spreadsheet jaisi hai, aur spreadsheet me chaudai user ki hoti hai — kyunki
 * kis column me kya samana chahiye, ye us par nirbhar hai ki wo AAJ kya dhoondh raha
 * hai. Ek fixed percentage har kisi ke liye galat hi hoti hai.
 *
 * ─── PIXEL, PERCENTAGE NAHI ────────────────────────────────────────────────
 * Default percentage me hain (container ke saath bade-chhote hote hain). Par kheenchna
 * pixel ka kaam hai: 6px ka drag "0.7% jodo" me badalna window resize par lodne lagta
 * hai. Isliye pehle drag par SAARE column apni maujooda pixel chaudai me jam jate hain
 * (`snapshot`), aur uske baad sab pixel me chalta hai. Ye jaan-boojh kar ek-tarfa hai —
 * aadha % aadha px table ko har render par hilata rehta.
 *
 * ─── localStorage, DB NAHI ─────────────────────────────────────────────────
 * Ye us aadmi ki us machine ki pasand hai, uske business ka data nahi. DB me daalna
 * matlab har chaudai ek write, ek RLS policy, aur ek multi-tenant sawaal — ek aisi cheez
 * ke liye jo dobara kheench kar theek ho jati hai.
 */

/**
 * KHEENCHNE ka sabse kam padav. Isse neeche column padhne layak nahi bachta.
 *
 * Ye storage ka floor NAHI hai, aur ye farq ek asli bug se aaya (26 Aug 2026). Pehle
 * dono ek hi number the: 44. Par snapshot har column ki MAUJOODA chaudai likhta hai, aur
 * checkbox column 28px ka hai, heat 37px ka. Reload par storage un teeno ko "bahut
 * chhoti" keh kar gira deta tha — to wo % par wapas chale jate aur baaki px par rehte,
 * yaani theek wahi mila-jula haalat jise is file ka header rokne ka daawa karta hai.
 *
 * 32 isliye ki checkbox aur ⋯ column iske aas-paas hi hote hain aur unhe kheench kar
 * chhota karne ki koi wajah nahi banti.
 */
export const MIN_COL_PX = 32;

export interface ResizeStart {
  /** Kis column ko kheencha ja raha hai. */
  id: string;
  /** Pointer ka x, jahan se drag shuru hua. */
  startX: number;
  /** Us column ki chaudai jab drag shuru hua. */
  startWidth: number;
}

/**
 * Drag ke dauran nayi chaudai.
 *
 * `Math.max` sirf ek surakhsha nahi hai — iske bina ulta kheenchne par chaudai rinatmak
 * ho jati thi aur browser use 0 maan kar column gायab kar deta tha, jise wapas laane ka
 * koi tarika screen par nahi bachta.
 */
export function widthAfterDrag(start: ResizeStart, currentX: number): number {
  return Math.max(MIN_COL_PX, Math.round(start.startWidth + (currentX - start.startX)));
}

/**
 * Autofit ki sabse zyada chaudai.
 *
 * Bina iski hadd ke ek lamba email ("accounts.payable.department@somelongcompany.co.in")
 * apne column ko 600px kar deta, aur baaki saare column screen se bahar chale jate — yaani
 * "text ke naap ka" karne ki koshish poori table ko na-padhne layak bana deti. Iske aage
 * ka text wrap ho jata hai, kata nahi.
 */
export const MAX_AUTOFIT_PX = 420;

/**
 * Column ki wo chaudai jisme uska sabse lamba text bilkul samaye.
 *
 * `textPx` me har cell ke text ki napi hui chaudai (header bhi), `chromePx` me padding +
 * border. Alag function isliye ki ismein teen faisle hain aur teeno test ke layak:
 * khaali column bhi padhne layak chaudai rakhe, ek lamba text poori table na bigade, aur
 * aadha pixel na aaye.
 */
export function autofitWidth(textPx: readonly number[], chromePx: number): number {
  const widest = textPx.length ? Math.max(...textPx) : 0;
  const wanted = Math.ceil(widest + chromePx);
  return Math.min(MAX_AUTOFIT_PX, Math.max(MIN_COL_PX, wanted));
}

/**
 * Autofit ke baad bachi hui jagah baant do — taaki table box bhar de.
 *
 * ─── YE KYUN BANA (26 Aug 2026) ─────────────────────────────────────────────
 * Is file ki har chaudai pehle HAATH SE likhi gayi thi — percentage me, aur main ne unhe
 * paanch baar dobara baanta: heat column aaya, gaya, seats aaya, wrap aaya. Har baar
 * yogfal 100% karna padta aur har baar kahin aur galti hoti — kabhi paisa katta, kabhi
 * stage, kabhi company do line me tootti. Pardeep ne theek poochha ki ek baar me kyun
 * nahi hota.
 *
 * Jawab: kyunki chaudai ANDAZE se aa rahi thi. Content se nikalne par ye poora bug-varg
 * khatam ho jata hai — column utna hi hota hai jitna uske text ko chahiye.
 *
 * Ek hi cheez bachti hai: agar sab column milkar box se CHHOTE reh jaayein, to daayen
 * taraf khaali maidan bachta hai jo tootne jaisa dikhta hai. Tab bachi jagah usi anupaat
 * me baant di jati hai. Ulta — jab content box se bada ho — kuch nahi kiya jata: wahan
 * horizontal scroll sahi jawab hai, nichodna nahi.
 */
export function fitToContainer(
  widths: Readonly<Record<string, number>>,
  containerPx: number,
  opts?: { shrink?: boolean; keep?: readonly string[] },
): Record<string, number> {
  const keys = Object.keys(widths);
  const total = keys.reduce((s, k) => s + widths[k], 0);

  /* ── R-2970 (20 Nov 2026): `keep` — atomic columns are not squeezed ───────────
     Phone and email joined the default view, so the first fit at 1280 has ~11% more to
     place than the box holds. Scaling every column the same cut the money ("₹3,2…") and
     the follow-up date. With `keep`, those columns stay whole and only the text columns
     (which wrap, with the full text in `title`) give up the room. When the kept ones alone
     leave too little room, the plain scale below is used. */
  if (opts?.shrink && opts.keep && opts.keep.length > 0 && total > containerPx && containerPx > 0) {
    const keep = new Set(opts.keep);
    const rest = keys.filter((k) => !keep.has(k));
    const keptPx = keys.filter((k) => keep.has(k)).reduce((s, k) => s + Math.round(widths[k]), 0);
    const restPx = rest.reduce((s, k) => s + widths[k], 0);
    const room = containerPx - keptPx;
    if (restPx > 0 && room >= rest.length * MIN_COL_PX) {
      const scale = room / restPx;
      const out: Record<string, number> = {};
      let used = 0;
      for (const k of keys) if (keep.has(k)) out[k] = Math.round(widths[k]);
      rest.forEach((k, i) => {
        if (i === rest.length - 1) out[k] = Math.max(MIN_COL_PX, Math.round(room - used));
        else { out[k] = Math.max(MIN_COL_PX, Math.round(widths[k] * scale)); used += out[k]; }
      });
      /* The caller's key order — the colgroup reads it in render order. */
      const ordered: Record<string, number> = {};
      for (const k of keys) ordered[k] = out[k];
      return ordered;
    }
  }

  /* ── `shrink` — pehli baar jamane ke liye, kheenchne ke baad NAHI (29 Aug 2026) ──
     Upar likha hai ki content box se bada ho to kuch nahi karna, scroll sahi jawab hai.
     Wo drag ke liye sach hai. Pehle autofit ke liye wo ek asli bug de raha tha:

     Aakhri column `actions` (⋯ wala) `sticky right-0` hai. Jab table container se sirf
     THODI si chaudi hoti hai, wo apni asli jagah par nahi baithta — kinare par chipak kar
     apne PADOSI ke upar chadh jata hai. Browser me naapa: `Follow-up` 1423→1514 tak thi
     aur `actions` 1464 par chipka tha — yaani Follow-up ke aakhri **50px** dab gaye. Screen
     par `FOLLOW-UP` ka header `FOLLC` dikh raha tha aur tareekh `28 Au(`.

     Aur wo tareekh is screen par sabse kaam ki cheez hai. "Scroll kar lo" jawab tab hai
     jab scroll karne par cheez DIKHE; yahan scroll ke baad bhi wo sticky column ke neeche
     hi rehti thi.

     Isliye: jab hum khud chaudai chun rahe hain, poori table ko container me utaar do —
     text kat kar `title` par chala jayega, jo har cell me pehle se hai. Jab USER ne
     kheencha ho, `shrink` nahi bhejte: uski chaudai uski hai, aur us soorat me scroll hi
     sahi hai. */
  if (opts?.shrink && total > containerPx && containerPx > 0 && total > 0) {
    const scale = containerPx / total;
    const out: Record<string, number> = {};
    let used = 0;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) out[k] = Math.max(MIN_COL_PX, Math.round(containerPx - used));
      else { out[k] = Math.max(MIN_COL_PX, Math.round(widths[k] * scale)); used += out[k]; }
    });
    return out;
  }

  /* Content box se bada ya barabar — chhodo, scroll hone do.
     Par MIN clamp phir bhi lagta hai. Ye test se nikla: bina iske
     `fitToContainer({a:1,...})` wapas `a:1` deta tha. Aaj us raste par aane wali saari
     value `autofitWidth` se aati hain (jo khud clamp karta hai), to bug dikh nahi raha
     tha — par ek function ka waada us par nirbhar nahi hona chahiye ki use kaun bula
     raha hai. Ek 1px ka column screen se gायab hota hai aur uske saath uska grip bhi,
     yaani wapas laane ka raasta bhi. */
  if (total <= 0 || containerPx <= 0 || total >= containerPx) {
    const kept: Record<string, number> = {};
    for (const k of keys) kept[k] = Math.max(MIN_COL_PX, Math.round(widths[k]));
    return kept;
  }

  const scale = containerPx / total;
  const out: Record<string, number> = {};
  let used = 0;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) {
      /* Aakhri column bachi hui poori jagah leta hai. Har column ko alag-alag round
         karne par 1-2px ka jodh reh jata hai, aur wo table ke daayen kinare par ek
         patli khaali lakeer bana deta — jo ek pixel ki galti jaisi dikhti hai. */
      out[k] = Math.max(MIN_COL_PX, Math.round(containerPx - used));
    } else {
      out[k] = Math.max(MIN_COL_PX, Math.round(widths[k] * scale));
      used += out[k];
    }
  });
  return out;
}

/**
 * Kya saheji hui chaudai AAJ ke saare column dhakti hai?
 *
 * ─── YE EK ASLI BUG SE AAYA (26 Aug 2026) ───────────────────────────────────
 * Pardeep: "lead ka owner kaun hai show hi nahi ho raha hai". Owner column us din bana.
 * Uske browser me chaudai pehle se saheji hui thi (usne kheenchi thi), aur us list me
 * `owner` nahi tha. Table ki chaudai usi list ke YOGFAL se banti hai — to naye column ko
 * 0px mili aur wo maujood hote hue bhi gायab raha.
 *
 * Sabse buri baat ye thi ki ye HAR naye column par dobara hota, aur sirf un logon ke
 * saath jinke paas purani chaudai saheji hui hai — yaani jo app ko sabse zyada use karte
 * hain. Naya column unhe hi na dikhta jinke liye wo banaya gaya hota.
 *
 * Isliye jaanch coverage ki hai, khaali-pan ki nahi: ek bhi column chhoot gaya to poori
 * saheji hui list chhod di jati hai aur autofit chalta hai. User ki kheenchi hui chaudai
 * jaati hai — par ek gायab column usse bahut bada nuksaan hai.
 */
export function coversAllColumns(
  stored: Readonly<Record<string, number>>,
  order: readonly string[],
): boolean {
  return order.length > 0 && order.every((id) => stored[id] != null);
}

/** localStorage ki chaabi — page aur version ke saath, taaki purani shakl na chipke. */
export const COL_WIDTH_KEY = "resellersos.leads.colWidths.v1";

/**
 * Sahi-salamat padho. Kharab ya chhedi hui value chup-chaap chhod di jati hai.
 *
 * Ye `try` dikhawa nahi hai: localStorage private-mode me throw karta hai, aur ek user
 * ki chhedi hui entry se poori leads list ka error boundary me girna bemani hoga —
 * chaudai ek pasand hai, data nahi.
 */
/**
 * @param known Aaj ke column. Diya gaya aur saved set me koi ANJAAN naam nikla, to poora
 *   saved layout chhod diya jata hai — sirf wo ek key nahi.
 *
 *   Wajah 29 Aug 2026 ko saamne aayi. Leads table se `email` aur `phone` column hataye
 *   gaye, aur jis browser me pehle kabhi column kheencha gaya tha wahan purani px-chaudai
 *   chalti rahi: table 1247px ki jagah me 1086px ki reh gayi — 161px khaali, aur bache hue
 *   column phir bhi tange hue. Sirf hatai gayi key girane se bhi wahi hota, kyunki bachi
 *   hui chaudai ek TERAH-column wali table ke liye chuni gayi thi.
 *
 *   Ek layout jo ab maujood hi nahi hai us table ka hai — use aadha bachana usse bura hai
 *   ki use jaane diya jaye. Chhodne par percentage wale default lagte hain, jo container
 *   bhar dete hain. Ek baar hota hai, aur khud theek ho jata hai.
 */
export function readStoredWidths(
  store?: Pick<Storage, "getItem">,
  known?: readonly string[],
): Record<string, number> {
  try {
    const raw = (store ?? window.localStorage).getItem(COL_WIDTH_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (known && known.length > 0) {
      const set = new Set(known);
      if (Object.keys(parsed as Record<string, unknown>).some((k) => !set.has(k))) return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      /* Sirf wahi maano jo sach me ek chaudai ho sakti hai. NaN, Infinity, string, 0 aur
         rinatmak — sab yahin ruk jate hain, warna wo `<col>` par jaakar column gायab
         kar dete.

         Yahan `MIN_COL_PX` se NAHI naapa jata: wo kheenchne ka padav hai. Checkbox
         column asli me 28px ka hai, aur use "bahut chhoti" keh kar girana usi column ko
         % par wapas bhej deta jise hum px me jamana chahte the. */
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.round(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** Likho. Nakaam hona theek hai — chaudai yaad na rehna ek asuvidha hai, kharabi nahi. */
export function writeStoredWidths(
  widths: Record<string, number>,
  store?: Pick<Storage, "setItem">,
): void {
  try {
    (store ?? window.localStorage).setItem(COL_WIDTH_KEY, JSON.stringify(widths));
  } catch {
    /* private mode / quota — chhod do */
  }
}
