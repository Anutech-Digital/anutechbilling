/**
 * useDictation — mic button ka React hissa. Niyam `dictation.ts` me hain (tested).
 *
 * Batwara wahi jo `outcomes.ts` / `use-outcome.ts` me hai: shudh niyam alag file me, aur
 * yahan sirf browser ka jod-tod. Web Speech API node me chalti hi nahi, isliye jo bhi
 * cheez test ho sakti thi — support ki jaanch, text jodna, error ka sandesh — wo `dictation.ts`
 * me hai; yahan wahi bacha jo bina browser ke naapa nahi ja sakta.
 *
 * ─── TYPES HAATH SE LIKHE HAIN, `any` NAHI ─────────────────────────────────
 * `webkitSpeechRecognition` TS ki lib.dom me nahi hai. CLAUDE.md §2 `any` mana karta hai,
 * aur `@types/dom-speech-recognition` ek nayi dependency hai jiski zaroorat itne chhote
 * surface ke liye nahi — neeche sirf wo teen cheezein declare ki gayi hain jo hum sach me
 * chhute hain.
 */
"use client";

import * as React from "react";
import { appendSpoken, dictationErrorMessage, dictationSupported } from "./dictation";

/* ── Utna hi type jitna hum use karte hain ──────────────────────────────────── */

interface SpeechAlternative { readonly transcript: string }
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult;
}
interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}
interface SpeechErrorEvent { readonly error: string }

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const C = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as RecognitionCtor | undefined;
  return typeof C === "function" ? C : null;
}

export interface Dictation {
  /** Button dikhana hi chahiye ya nahi — Firefox me ye API hai hi nahi. */
  supported: boolean;
  listening: boolean;
  /** Aakhri gadbad, aam bhasha me. Khaali string = kehne layak kuch nahi. */
  error: string;
  toggle: () => void;
  /** Bolte waqt jo abhi tak suna gaya (final nahi) — user ko dikhane ke liye. */
  interim: string;
  /** True jab gadbad ki wajah permission ho — tab UI "Mic chalu karein" dikha sakta hai. */
  needsPermission: boolean;
  /**
   * Chrome ka apna faisla: `granted` | `denied` | `prompt`. Khaali = abhi poochha nahi.
   *
   * Settings ka screenshot ye kabhi sabit nahi karta — Chrome ki site permission har
   * PROFILE ki alag hoti hai, aur ye us page se poochhti hai jo sach me chal raha hai.
   */
  permission: string;
  /**
   * Chrome se SEEDHA permission maango, aur milne par bolna shuru kar do.
   *
   * ─── YE KYUN, JAB SETTINGS ME ALLOW PEHLE SE HAI ────────────────────────
   * 26 Aug 2026: Pardeep ne `chrome://settings` me Microphone = Allow kar diya aur phir
   * bhi `not-allowed` aata raha. Uski wajah ye hai ki `SpeechRecognition` khud permission
   * ka prompt bharose se nahi laata — wo maan leta hai ki ijazat pehle se hai, aur na
   * hone par seedha `not-allowed` de deta hai. Us haalat me user ke paas koi raasta nahi
   * bachta.
   *
   * `getUserMedia` Chrome ka apna prompt LAATA hai. Yahi asli "mic chalu karein" hai.
   *
   * Aur `chrome://settings` ka link dena bekaar hai: Chrome kisi bhi web page se aise
   * link ko jaan-boojh kar mara hua rakhta hai. Isliye link ki jagah ye button.
   */
  requestMic: () => void;
  /** Abhi kaun si bhasha sun rahe hain. */
  lang: "en-IN" | "hi-IN";
  /** Bhasha badlo — yaad rehti hai, aur sunte waqt badalne par khud restart hota hai. */
  setLang: (l: "en-IN" | "hi-IN") => void;
}

/**
 * @param onText Jab ek poora vaakya final ho jaye — pehle se maujood text ke saath juda
 *               hua nateeja. Caller isi ko state me rakh leta hai.
 */
export function useDictation(onText: (next: string) => void, currentText: () => string): Dictation {
  const [listening, setListening] = React.useState(false);
  const [error, setError] = React.useState("");
  const [interim, setInterim] = React.useState("");
  const recRef = React.useRef<SpeechRecognitionLike | null>(null);
  /* User ne "on" chhoda hai ya khud roka — auto-restart isi par tay hota hai. */
  const wantOnRef = React.useRef(false);
  const [lang, setLang] = React.useState<"en-IN" | "hi-IN">("en-IN");
  const langRef = React.useRef(lang);
  langRef.current = lang;

  /* Saheji hui bhasha — pehle render par padhi jati hai. */
  React.useEffect(() => {
    try {
      const l = window.localStorage.getItem("resellersos.dictation.lang");
      if (l === "en-IN" || l === "hi-IN") setLang(l);
    } catch { /* private mode — default en-IN chalega */ }
  }, []);

  /* Callbacks ko ref me rakha jata hai taaki recognition object dobara na banana pade
     har render par — wo band-shuru hone par aawaz ka ek tukda kha jata hai. */
  const onTextRef = React.useRef(onText);
  const currentRef = React.useRef(currentText);
  onTextRef.current = onText;
  currentRef.current = currentText;

  /**
   * Chrome KHUD kya sochta hai — Permissions API se, seedha.
   *
   * ─── YE KYUN BANA (26 Aug 2026) ───────────────────────────────────────────
   * Pardeep ne `chrome://settings` me Microphone = Allow kar diya, screenshot bhi bheja,
   * aur phir bhi `NotAllowedError` aata raha. Uske Windows par maine jaancha: OS mic
   * access Allow hai, mic device maujood aur OK hai, aur Chrome ne 24 Aug ko 46 second
   * mic use bhi kiya tha. Yaani teen sambhavnayein khatm.
   *
   * Bacha ek: uske Chrome me GYARAH profile hain, aur site permission har profile ki
   * ALAG hoti hai. Ek profile me Allow karke doosre profile ke tab me test karna bilkul
   * aisa hi dikhta hai — "settings me to Allow likha hai".
   *
   * Settings ke screenshot se ye kabhi pata nahi chalega. Ye API us page se poochhti hai
   * jo SACH ME chal raha hai, isliye profile ka sawaal apne aap khatm ho jata hai.
   */
  const [permState, setPermState] = React.useState<string>("");
  const checkPermission = React.useCallback(() => {
    const perms = typeof navigator === "undefined" ? undefined : navigator.permissions;
    if (!perms?.query) { setPermState("permissions-api-nahi"); return; }
    /* `as PermissionName` — "microphone" TS ki PermissionName union me nahi hai, par
       Chrome me chalta hai. Cast is ek naam tak simit hai; `any` poore object ko khol
       deta. */
    void perms.query({ name: "microphone" as PermissionName })
      .then((s) => setPermState(s.state))
      .catch(() => setPermState("could not check"));
  }, []);

  /* ── Permission badle to APNE AAP theek ho jao (26 Aug 2026) ─────────────────
     Pardeep ne Chrome me mic Allow kiya — panel me "Allowed" aur aawaz ki live patti
     bhi chal rahi thi — aur app phir bhi purana likha dikha rahi thi: "ijazat nahi mili
     (not-allowed)" aur "faisla: denied". Ek taraf Chrome haan keh raha tha, doosri taraf
     app na. Wo state baasi thi: maine ijazat MILNE ke baad dobara poochha hi nahi.

     `PermissionStatus.onchange` wahi pal pakadta hai. Ab jaise hi ijazat milti hai,
     purana laal sandesh khud hat jata hai — user ko dobara dabakar ye pata karne ki
     zarurat nahi ki ab theek hua ya nahi. */
  React.useEffect(() => {
    const perms = typeof navigator === "undefined" ? undefined : navigator.permissions;
    if (!perms?.query) return;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      const s = status?.state ?? "";
      setPermState(s);
      /* Ijazat mil gayi to purani gadbad ka sandesh jhooth ban jata hai — hatao. */
      if (s === "granted") setError("");
    };
    void perms.query({ name: "microphone" as PermissionName })
      .then((s) => {
        status = s;
        setPermState(s.state);
        /* ── Page khulte waqt BHI jaancho, sirf badalne par nahi ────────────────
           Pehla version sirf `onchange` par bharosa karta tha. Wo tab fail hota hai jab
           ijazat us waqt di jaye jab ye code chal hi nahi raha tha — Pardeep ne Chrome ke
           panel se Allow kiya, aur purana laal sandesh phir bhi pada raha, kyunki us pal
           koi sun hi nahi raha tha.

           Ek sandesh jo sach nahi hai, us se behtar koi sandesh na hona hai — aur wo
           "denied" likh kar aadmi ko wahin ghumata rehta hai jahan kuch theek karne ko
           bacha hi nahi. */
        if (s.state === "granted") setError("");
        s.addEventListener("change", onChange);
      })
      .catch(() => { /* Firefox/Safari me ye API nahi — line dikhegi hi nahi */ });
    return () => status?.removeEventListener("change", onChange);
  }, []);

  const stop = React.useCallback(() => {
    wantOnRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  /* Component gायab hone par mic band. Bina iske drawer band karne ke baad bhi mic chalti
     rehti hai — browser ka mic-indicator jalta rehta hai aur wo bharosa todta hai. */
  React.useEffect(() => stop, [stop]);

  const start = React.useCallback(() => {
    const C = recognitionCtor();
    if (!C) { setError("This browser does not support voice typing. It works in Chrome."); return; }

    setError("");
    const rec = new C();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let finalText = "";
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else pending += r[0].transcript;
      }
      setInterim(pending);
      if (finalText) onTextRef.current(appendSpoken(currentRef.current(), finalText));
    };

    rec.onerror = (e) => {
      /* ── `no-speech` ab GADBAD NAHI hai (26 Aug 2026) ────────────────────────
         Auto-restart aane se pehle `no-speech` ka matlab tha "kuch nahi suna, khatm".
         Uske baad iska matlab badal gaya: wo do vaakya ke beech ki chuppi hai, aur uske
         turant baad recognition dobara chalu ho jata hai.

         Isi wajah se Pardeep ke screen par "Kuch sunayi nahi diya" laal me pada tha
         jabki box me poora vaakya likha hua tha — dono ek saath, aur dono me se ek jhooth.
         Jab hum sunte rehne wale hain, ye kehna hi galat hai. */
      const ignorable = e.error === "no-speech" && wantOnRef.current;
      const msg = ignorable ? "" : dictationErrorMessage(e.error);
      if (msg) setError(msg);
      /* Gadbad par turant poochho — user ko wahi jawab chahiye us pal. */
      checkPermission();
      /* `no-speech` par API khud band ho jati hai; UI ko usse mel khana chahiye warna
         button "sun raha hoon" dikhata rehta hai aur kuch nahi hota. */
      setListening(false);
      setInterim("");
      recRef.current = null;
    };

    /* ── Chuppi par Chrome khud ruk jata hai — dobara chalu karo ─────────────────
       `continuous: true` ka matlab ye NAHI hai ki Chrome hamesha sunta rahega. Wo do-teen
       second ki chuppi par recognition khatm kar deta hai aur `onend` bhej deta hai. Mera
       pehla version wahin band ho jata tha — mic ka nishaan bujh jata aur aage bola hua
       kuch bhi darj nahi hota. Pardeep ne isi ko "dhang se nahi sun pa raha" kaha: shuru
       ka "Hello" aaya aur uske baad chuppi.

       `wantOnRef` batata hai ki user ne khud roka tha ya Chrome ne. User ne roka to kuch
       nahi karte; Chrome ne roka to turant dobara shuru — bolne wale ke liye ye ek hi
       lambi dictation jaisa mehsoos hota hai. */
    rec.onend = () => {
      setInterim("");
      recRef.current = null;
      if (!wantOnRef.current) { setListening(false); return; }
      try {
        rec.start();
        recRef.current = rec;
      } catch {
        /* Chrome kabhi usi object ko dobara start nahi karne deta. Us haalat me chup-chaap
           band karna hi imaandar hai — ek "sun raha hoon" jo sun nahi raha, usse bura hai. */
        wantOnRef.current = false;
        setListening(false);
      }
    };

    try {
      rec.start();
      recRef.current = rec;
      wantOnRef.current = true;
      setListening(true);
    } catch {
      /* Do baar start karne par API throw karti hai. Ye kharabi nahi, dobara-tap hai. */
      setListening(false);
    }
  }, [checkPermission]);


  const requestMic = React.useCallback(() => {
    const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!md?.getUserMedia) {
      setError("This browser cannot ask for microphone permission. Open it in Chrome.");
      return;
    }
    setError("");
    void md.getUserMedia({ audio: true })
      .then((stream) => {
        /* Stream turant band — humein sunna `SpeechRecognition` se hai, is stream se
           nahi. Ise khula chhodne par Chrome ka "recording" indicator jalta reh jata hai
           aur wo bharosa todta hai. Kaam sirf permission lena tha. */
        stream.getTracks().forEach((t) => t.stop());
        start();
      })
      .catch((e: unknown) => {
        const name = e instanceof Error ? e.name : "";
        if (name === "NotAllowedError") {
          setError(
            "Chrome blocked the microphone. Click the 🔒/ⓘ icon at the left of the address bar, " +
            "set Microphone to Allow, then press Ctrl+Shift+R. (blocked)",
          );
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          /* Ye wo shakha hai jise permission ki settings kabhi theek nahi kar sakti —
             aur jise permission ki galti samajh kar log ghanton settings me dhoondhte
             hain. Isliye ise alag se, saaf shabdon me. */
          setError("No microphone found on this computer. Is a mic or headset connected? (no-device)");
        } else {
          setError(`Could not start the microphone. (${name || "unknown"})`);
        }
      });
  }, [start]);

  return {
    supported: dictationSupported(),
    listening,
    error,
    interim,
    toggle: () => (listening ? stop() : start()),
    /* `not-allowed` aur `service-not-allowed` — dono par wahi ek raasta kaam karta hai. */
    needsPermission: /not-allowed|blocked/.test(error),
    permission: permState,
    requestMic,
    lang,
    /**
     * Bhasha badlo — aur wahi yaad rakho.
     *
     * ─── YE CHUNAV USER KA HONA CHAHIYE, MERA NAHI ────────────────────────────
     * Maine `en-IN` par tay kar diya tha, is TARQ se ki Pardeep Hinglish Roman me likhta
     * hai — jo sach hai — par wo ek ANDAZA tha ki wo bolega bhi waise hi. Nateeja: Hindi
     * shabd bigad kar aate the.
     *
     * Dono ka apna nuksaan hai, aur koi bhi "sahi" nahi:
     *   · `en-IN` — angrezi saaf, par Hindi shabd tootkar aate hain
     *   · `hi-IN` — Hindi saaf, par DEVANAGARI me ("20 सीट्स चाहिए")
     *
     * Kaun sa behtar hai, ye us par nirbhar hai ki us pal aap kya bol rahe ho — aur wo
     * maine tay karne ki koshish ki, jo galat tha. Ab wo switch aapke haath me hai.
     */
    setLang: (l: "en-IN" | "hi-IN") => {
      setLang(l);
      try { window.localStorage.setItem("resellersos.dictation.lang", l); } catch { /* ok */ }
      /* Chalte-chalte badla to dobara shuru — `rec.lang` sirf start hone par padha jata
         hai, isliye bina restart ke badlav ka koi asar nahi hota aur wo "kaam nahi kiya"
         jaisa lagta hai. */
      if (wantOnRef.current) { stop(); setTimeout(() => start(), 150); }
    },
  };
}
