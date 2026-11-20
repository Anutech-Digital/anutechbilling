"use client";
/**
 * Column widths, density and the shown columns (R-2970) for the lead list — moved verbatim out of
 * LeadListView (S35, 28 Sep 2026). The rules and storage are in lib/leads/use-column-widths.ts
 * (tested); this is the pointer work.
 *
 * `ResizeGrip` is still created per render, exactly as it was inside LeadListView: the drag
 * listens on WINDOW precisely because the grip remounts (see beginResize's note), so the
 * remount is part of how this was proven to work and is kept.
 */
import * as React from "react";
import {
  widthAfterDrag, readStoredWidths, writeStoredWidths, autofitWidth, fitToContainer,
  coversAllColumns,
  MIN_COL_PX,
  type ResizeStart,
} from "@/lib/leads/use-column-widths";
import { type Density } from "@/components/features/leads/lead-list-grid";
import {
  ALL_LEAD_COL_IDS, CONTROL_PX, DEFAULT_LEAD_COLS, keepWhole, leadColDef, readShownColumns,
  renderOrder, writeShownColumns, isLeadColId, type LeadColId,
} from "@/lib/leads/list-columns";

/** Every key a stored width may carry — the checkbox, the ⋯ and every column a person can add. */
const KNOWN_WIDTH_KEYS = ["select", "actions", ...ALL_LEAD_COL_IDS];

export function useLeadListColumns(leads: readonly unknown[]) {
  /* ── Kheench kar chaudai badalna (26 Aug 2026) ─────────────────────────────
     Niyam aur storage `lib/leads/use-column-widths.ts` me hain (tested); yahan sirf
     pointer ka kaam hai.

     `colRefs` isliye ki pehle drag par saare column apni MAUJOODA pixel chaudai me jam
     jayein. Bina us snapshot ke sirf kheencha hua column px me hota aur baaki % me —
     aur browser bachi hui jagah baant kar padosi columns ko har drag par hilata rehta,
     jo dekhne me table ka tootna lagta hai.

     Pointer events, mouse nahi: capture ke saath drag chalta rehta hai chahe pointer
     header se bahar chala jaye, aur touch/pen bhi apne aap kaam karte hain. */
  /* Density aur chhupe hue column — dono localStorage me, wahi tarq jo chaudai ka hai:
     ye is aadmi ki is machine ki pasand hai, uske business ka data nahi. */
  const [density, setDensity] = React.useState<"compact" | "regular" | "relaxed">("regular");
  /* R-2970: the shown data columns, in order — replaces the old "hidden" set over a fixed
     nine. Rules + storage: lib/leads/list-columns.ts (tested). */
  const [shown, setShownState] = React.useState<LeadColId[]>(() => [...DEFAULT_LEAD_COLS]);
  React.useEffect(() => {
    try {
      const d = window.localStorage.getItem("resellersos.leads.density");
      if (d === "compact" || d === "regular" || d === "relaxed") setDensity(d);
    } catch { /* private mode — pasand yaad na rehna asuvidha hai, kharabi nahi */ }
    setShownState(readShownColumns());
  }, []);
  const setShown = React.useCallback((next: LeadColId[]) => {
    setShownState(next);
    writeShownColumns(next);
  }, []);
  const order = React.useMemo(() => renderOrder(shown), [shown]);
  const orderKey = order.join(",");

  const [colW, setColW] = React.useState<Record<string, number>>({});
  const colRefs = React.useRef<Record<string, HTMLTableColElement | null>>({});
  const dragRef = React.useRef<ResizeStart | null>(null);
  const tableWrapRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * Us column ke sabse lambe text ki chaudai — autofit ke liye.
   *
   * ─── Clone karke naapa jata hai, canvas se NAHI ──────────────────────────
   * Pehla prayaas canvas `measureText` par tha, cell ke computed font ke saath. Naap kar
   * dekha: "susen@1234gmail.com" ke liye 273px aaya jabki 130px kaafi tha. Wajah ye ki
   * font cell par nahi, uske ANDAR wale span par hai (`text-xs`) — cell khud badi
   * inherited size rakhta hai. Canvas ko galat font diya, to naap 2x tak badi aayi.
   *
   * Clone me ye sawaal hi nahi rehta: nested font, badge, dot, icon — jo bhi cell me
   * hai, wo apni asli chaudai ke saath ginta hai. `white-space: nowrap` lagane se wo
   * chaudai milti hai jo text ko CHAHIYE, na ki wo jo aaj mili hui hai — aur wahi autofit
   * ka poora sawaal hai. (`scrollWidth` yahan kaam nahi karta: cells par wrap aur
   * `overflow-hidden` dono hain, to wo lipta hua text hi batata hai.)
   *
   * `null` lautta hai jab table na mile — us haalat me double-click kuch nahi karta, jo
   * galat chaudai lagane se behtar hai.
   */
  const measureColumn = (col: string): number | null => {
    const idx = order.indexOf(col);
    const table = tableWrapRef.current?.querySelector("table");
    if (idx < 0 || !table) return null;

    const pad = document.createElement("div");
    /* Screen se bahar, par LAYOUT me — `display:none` par chaudai 0 aati hai. */
    pad.style.cssText =
      "position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden;pointer-events:none";
    document.body.appendChild(pad);

    const widths: number[] = [];
    try {
      /* Header bhi ginte hain — warna autofit ke baad column ka apna naam kat jata. */
      const rows = [
        ...table.querySelectorAll<HTMLTableRowElement>("thead tr"),
        ...table.querySelectorAll<HTMLTableRowElement>("tbody tr"),
      ];
      for (const row of rows) {
        const cell = row.children[idx] as HTMLElement | undefined;
        if (!cell || !cell.innerText.trim()) continue;
        const cs = getComputedStyle(cell);
        /* Cell ka apna font pad par — taaki wo text bhi theek nape jo cell se font
           virasat me leta hai (jaise `GRID_TD_ATOM + text-sm`). Andar ke span apni
           class se ise khud override kar lete hain. */
        pad.style.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        pad.innerHTML = cell.innerHTML;
        widths.push(pad.getBoundingClientRect().width);
      }
    } finally {
      /* `finally` — beech me kuch bhi ho, ye div DOM me peeche nahi rehna chahiye. */
      pad.remove();
    }

    /* padding (px-2 = 8+8) + border + do pixel ki saans, taaki aakhri akshar na chhue. */
    return autofitWidth(widths, 16 + 2 + 2);
  };

  /* ── Pehli baar: chaudai CONTENT se, andaze se nahi (26 Aug 2026) ────────────
     `LEADLIST_COL_WIDTHS` ki percentage ab sirf ek fallback hai — pehle render ka, jab
     tak naapa na jaye. Asli chaudai yahan se aati hai.

     Ye badlav Pardeep ke us sawaal ka jawab hai ki ek baar me kyun nahi hota. Wajah ye
     thi ki main percentage HAATH SE baant raha tha, aur naya column aane par 100% dobara
     baantne me har baar kahin aur galti hoti — kabhi paisa katta, kabhi stage, kabhi
     company do line me tootti. Content se naapne par wo poora bug-varg khatam ho jata
     hai: column utna hi hota hai jitna uske text ko chahiye.

     Ek hi baar chalta hai (`autofitted`), aur sirf jab user ne khud kuch na saheja ho —
     uski kheenchi hui chaudai par chadhna uska kaam mitane jaisa hoga. */
  const autofitted = React.useRef(false);
  /* Bumped by a reset, so the first-fit effect runs again on a cleared layout. */
  const [fitNonce, setFitNonce] = React.useState(0);
  React.useEffect(() => {
    /* Aaj ke column bhi bhejo. Saved layout me koi anjaan naam mila (jaise `email`/`phone`,
       jo 29 Aug 2026 ko hata diye gaye) to wo poora layout chhod diya jata hai — wo ek
       aur hi table ka naap tha. Wajah `readStoredWidths` par likhi hai. */
    /* R-2970: a column added after the widths were set gets its default width; the table
       then grows and scrolls sideways, Contact staying sticky. */
    if (autofitted.current) {
      setColW((w) => {
        if (Object.keys(w).length === 0) return w;
        const missing = order.filter((k) => w[k] == null);
        if (missing.length === 0) return w;
        const next = { ...w };
        for (const k of missing) next[k] = isLeadColId(k) ? leadColDef(k).px : CONTROL_PX[k as "select" | "actions"];
        return next;
      });
      return;
    }
    const stored = readStoredWidths(undefined, KNOWN_WIDTH_KEYS);
    /* ── Saheji hui chaudai SIRF tab maani jaye jab wo poori ho (26 Aug 2026) ───
       Ye bug Pardeep ne pakda: "lead ka owner kaun hai show hi nahi ho raha hai".

       Owner column aaj bana. Uske browser me chaudai pehle se saheji hui thi (usne
       kheenchi thi), aur us list me `owner` nahi tha. Table ki chaudai usi list ke YOGFAL
       se tay hoti hai — to naye column ko 0px mili aur wo maujood hote hue bhi gायab
       raha. `<col>` uske liye 9% maang raha tha, par table ke paas baantne ke liye
       kuch bacha hi nahi tha.

       Ye ek baar ki galti nahi thi: HAR naye column par wahi hota, aur sirf un logon ke
       saath jinke paas purani chaudai saheji hui hai — yaani jo app ko sabse zyada use
       karte hain. Isliye jaanch coverage ki hai, khaali-pan ki nahi: agar saheji hui list
       aaj ke saare column nahi dhakti, to use chhod kar autofit chalta hai. User ki
       kheenchi hui chaudai jaati hai — par ek gायab column usse bahut bada nuksaan hai. */
    const covers = coversAllColumns(stored, order);
    if (covers) { setColW(stored); autofitted.current = true; return; }

    if (leads.length === 0) return;

    /* ── Table taiyar hone tak KOSHISH KARTE RAHO ────────────────────────────
       Pehla version ek hi `requestAnimationFrame` par naapta tha. Wo chup-chaap fail ho
       raha tha: agar us frame par table abhi render nahi hui, `measureColumn` null
       lautata, effect return ho jata — aur dobara kabhi nahi chalta, kyunki uske deps
       nahi badalte. Nateeja browser me dikha: PLAN ka text teen line me tootta tha aur
       row 73px ki thi, jabki autofit ke saath 45px aur ek line.

       Ye wo kism ka bug hai jo timing par nirbhar hai — kabhi chalta hai, kabhi nahi —
       aur isi liye ek baar "verify" karke chhod dena kaafi nahi tha. */
    let frame = 0;
    let id = 0;
    const attempt = () => {
      if (autofitted.current) return;
      const fitted: Record<string, number> = {};
      let ready = true;
      for (const col of order) {
        /* `select` aur `actions` me CONTROL hai, text nahi — checkbox aur ⋯ button. Unhe
           text se naapne par autofit MIN_COL_PX (32px) de deta hai, aur checkbox ko
           padding + border ke saath 40px chahiye, to wo apne hi column me kat jata.
           Inki chaudai CONTROL_PX (lib/leads/list-columns.ts) me px me likhi hai — wahi sahi hai. */
        if (col === "select" || col === "actions") {
          fitted[col] = CONTROL_PX[col];
          continue;
        }
        const w = measureColumn(col);
        if (w == null) { ready = false; break; }
        fitted[col] = w;
      }

      if (!ready) {
        /* 30 frame ≈ half second. Uske baad chhod dete hain: fallback percentage waise
           bhi kaam ki hai, aur hamesha ke liye rAF chalate rehna ek chhupa hua leak hai. */
        if (frame++ < 30) { id = requestAnimationFrame(attempt); }
        return;
      }
      autofitted.current = true;
      /* `shrink` sirf YAHAN. Ye pehli baar khud chaudai chun raha hai, aur agar jodh
         container se bada raha to sticky `⋯` column apne padosi ke upar chadh kar
         Follow-up ki tareekh dhak deta hai. Wajah `fitToContainer` par likhi hai.
         User ke kheenchne wale raaste par ye NAHI jata — wahan scroll hi sahi hai. */
      /* R-2970: `keep` — phone, value and follow-up stay whole; the text columns give way. */
      setColW(fitToContainer(fitted, tableWrapRef.current?.clientWidth ?? 0, { shrink: true, keep: keepWhole(shown) }));
    };

    id = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- orderKey stands for order / shown
  }, [leads.length, orderKey, fitNonce]);

  /* ── Save state ke SAATH bandha hai, drag ke ant par nahi (26 Aug 2026) ──────
     Pehle `endResize` likhta tha. Naap kar dekha: ek asli drag me CONTACT 403px ho gaya
     aur localStorage me purani value padi rahi — yaani reload par mehnat gायab. Wajah ye
     ki `pointerup` hamesha grip par nahi girta (capture chhoot jaye, pointer window se
     bahar nikal jaye, ya browser drag cancel kar de).

     Effect us poore sawaal ko hata deta hai: jo state me hai wahi disk par hai, chahe
     drag kaise bhi khatam ho. `hydrated` ise pehle render par chalne se rokta hai, warna
     mount ke waqt ka khaali `{}` sahi saheji hui chaudai ko mita deta. */
  const hydrated = React.useRef(false);
  React.useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; return; }
    writeStoredWidths(colW);
  }, [colW]);

  /* ── Drag WINDOW par sunta hai, grip par nahi (26 Aug 2026) ──────────────────
     Pehla version `setPointerCapture` + grip ke apne onPointerMove par chalta tha, aur
     asli maus se wo "thoda hilta phir ruk jata" tha. Wajah React me thi, browser me
     nahi: `ResizeGrip` is component ke ANDAR bana hai, to har `colW` badalne par — yaani
     har pointermove par — uska component-type naya hota hai. React purana <span> unmount
     karke naya mount karta hai, aur unmount hote hi pointer capture aur uske handlers
     dono chale jate hain. Drag pehle move par hi mar jata tha.

     Window par lage listeners ko is se koi farak nahi padta: wo grip ke zinda hone par
     nirbhar hi nahi hain. Isi wajah se pointer header se bahar chala jaye tab bhi drag
     chalta rehta hai — jo kheenchte waqt hota hi hai. */
  const moveRef = React.useRef<((e: PointerEvent) => void) | null>(null);
  const upRef   = React.useRef<(() => void) | null>(null);

  const stopListening = React.useCallback(() => {
    if (moveRef.current) window.removeEventListener("pointermove", moveRef.current);
    if (upRef.current) {
      window.removeEventListener("pointerup", upRef.current);
      window.removeEventListener("pointercancel", upRef.current);
    }
    moveRef.current = null;
    upRef.current = null;
    dragRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  /* Component gायab ho jaye drag ke beech me (route badla, view toggle) to listener
     peeche na reh jaye — warna wo ek hate hue component ka state set karta rehta. */
  React.useEffect(() => stopListening, [stopListening]);

  const beginResize = (id: string) => (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();          // header ka sort click na chale

    const snapshot: Record<string, number> = { ...colW };
    for (const key of order) {
      if (snapshot[key] == null) {
        /* Round: getBoundingClientRect 27.725 jaisi value deta hai, aur aadha pixel
           gridlines par har render me hilta dikhta hai. */
        snapshot[key] = Math.round(colRefs.current[key]?.getBoundingClientRect().width ?? MIN_COL_PX);
      }
    }
    setColW(snapshot);
    dragRef.current = { id, startX: e.clientX, startWidth: snapshot[id] };

    /* Drag ke dauran text select hona aur cursor ka badalna — dono zaroori hain. Bina
       `userSelect: none` ke kheenchna poore header ko neela kar deta hai, jo tootne
       jaisa dikhta hai. */
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setColW((w) => ({ ...w, [d.id]: widthAfterDrag(d, ev.clientX) }));
    };
    const onUp = () => stopListening();

    moveRef.current = onMove;
    upRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /* Sab chaudai default par wapas. Ye zaroori hai, sajावat nahi: grip patti 8px ki hai
     aur header ke kinare par baithi hai, to sort ke liye click karte waqt uspar haath lag
     jana aasan hai — aur ek galti se 400px ka ho gaya column bina wapsi ke raaste ke wahi
     dead-end hai jise CLAUDE.md §24 mana karta hai. */
  const resetWidths = () => {
    /* Storage first: the first-fit effect reads it in this same commit, and a stale full
       layout there would put the old widths straight back. */
    writeStoredWidths({});
    autofitted.current = false;
    setColW({});
    setFitNonce((n) => n + 1);
  };

  /** R-2970 "Reset to default": the default columns, in the default order, fitted afresh. */
  const resetColumns = () => {
    setShown([...DEFAULT_LEAD_COLS]);
    resetWidths();
  };

  /**
   * Header ke daayen kinare par pakadne ki patti.
   *
   * Double-click sirf USI column ko default par lauta deta hai — spreadsheet me yahi
   * aadat hai, aur ye poori list reset karne se sasta hai jab galti ek hi column me hui ho.
   */
  const ResizeGrip = ({ col }: { col: string }) => (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${col} column — double-click to fit`}
      title="Drag to resize · double-click to fit"
      /* Sirf pointerdown. Move/up window par sunte hain — dekho `beginResize` ka comment:
         ye span har render par remount hota hai, to uspar lage move/up handler drag ke
         pehle hi step me gायab ho jate the. */
      onPointerDown={beginResize(col)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        /* AUTOFIT — column utna hi jitna uska sabse lamba text (26 Aug 2026, Pardeep:
           "column ke divider par double click karne par jitna text hai maximum utna
           expand ho jaye"). Pehle ye default chaudai par lautata tha, jo Excel ka
           bartaav nahi hai aur kam kaam ka tha. */
        setColW((w) => {
          const fit = measureColumn(col);
          if (fit == null) return w;
          /* Snapshot zaroori hai: agar baaki column abhi % me hain, to akele is column ko
             px dena mila-jula haalat bana deta hai aur browser bachi jagah baant kar
             padosi columns hila deta. Wahi bug double-click par pehle bhi mila tha. */
          const next: Record<string, number> = { ...w };
          for (const key of order) {
            if (next[key] == null) {
              next[key] = Math.round(colRefs.current[key]?.getBoundingClientRect().width ?? MIN_COL_PX);
            }
          }
          next[col] = fit;
          return next;
        });
      }}
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none hover:bg-amber/40 active:bg-amber/60"
    />
  );

  return {
    density, setDensity, shown, setShown, order, colW, colRefs, tableWrapRef, resetWidths, resetColumns, ResizeGrip,
  };
}

export type LeadListColumns = ReturnType<typeof useLeadListColumns>;
export type { Density };
