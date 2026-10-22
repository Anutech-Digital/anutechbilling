/**
 * Bolkar likhna — note box me typing ki jagah aawaz.
 *
 * ─── YE KYUN, JAB `lib/voice/stt.ts` PEHLE SE HAI ───────────────────────────
 * 26 Aug 2026, Pardeep: "voice se bhi me apni baat record ya entry kar saku".
 *
 * `stt.ts` (Sarvam Saaras) ko iski jagah use karna galat hoga, aur ye alag kaam hone ki
 * wajah se hai, susti ki wajah se nahi:
 *
 *   · stt.ts ek AUDIO FILE ka kaam karta hai jo webhook par aati hai — WhatsApp voice
 *     note. Wo server par chalta hai, ek baar me poori clip par.
 *   · Yahan aadmi box ke saamne baith kar bol raha hai aur shabd dikhte jaane chahiye.
 *     Har tukda server par bhejna, transcribe karana aur wapas laana — wo dictation
 *     nahi, intezaar hai.
 *
 * Aur ek amali baat: `SARVAM_API_KEY` is deployment par set NAHI hai (stt.ts me 25 Aug
 * 2026 ko jaancha gaya), to Sarvam wala raasta aaj kaam hi nahi karta. Browser ka
 * dictation aaj chalta hai, muft.
 *
 * CLAUDE.md §2 (koi nayi dependency nahi) tootta nahi: ye browser ki apni kshamta hai —
 * na koi package, na account, na bill.
 *
 * ─── EN-IN, HI-IN NAHI — AUR YE SOCH KAR CHUNA GAYA HAI ─────────────────────
 * `hi-IN` Hindi ko DEVANAGARI me lauta ta hai: "20 seats chahiye" → "20 सीट्स चाहिए".
 * Pardeep aur uski team Hinglish ROMAN me likhte hain (is repo ka har note waisa hi
 * hai), to Devanagari note baaki sab se alag dikhta aur dhoondhne me bhi na milta.
 * `en-IN` sab kuch Latin me rakhta hai — wahi shakl jisme wo waise bhi type karte.
 *
 * Ye wahi tarq hai jo stt.ts `codemix` ke liye deta hai, sirf yahan ka auzaar alag hai.
 *
 * ─── EK BAAT JO USER KO PATA HONI CHAHIYE ───────────────────────────────────
 * Chrome me ye API aawaz PEHCHANNE KE LIYE GOOGLE KE SERVER par bhejta hai. Lead ke
 * note me customer ki baatein hoti hain. Ye chhupane wali baat nahi hai — UI me kehna
 * chahiye, aur is tenant ka mail waise bhi Google Workspace par hai.
 */

/** Browser me ye kshamta hai ya nahi — button dikhane se pehle poochha jata hai. */
export function dictationSupported(w: unknown = typeof window === "undefined" ? undefined : window): boolean {
  if (!w || typeof w !== "object") return false;
  const win = w as Record<string, unknown>;
  return typeof win.SpeechRecognition === "function" || typeof win.webkitSpeechRecognition === "function";
}

/**
 * Bole hue tukde ko maujooda text ke saath jodo.
 *
 * Alag function isliye ki jodne ke niyam me hi teen chhoti galtiyan chhupi hain, aur wo
 * teeno test ke layak hain — jabki `SpeechRecognition` node me chalti hi nahi:
 *
 *   1. Khaali box par aage space nahi lagta ("  20 seats" jaisa shuru bura dikhta hai).
 *   2. Jo text pehle se space par khatam ho raha ho, uspar doosra space nahi jodna.
 *   3. Bola hua tukda apne aap me trim hona chahiye — API aksar aage-peechhe space deti hai.
 */
export function appendSpoken(existing: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return existing;
  if (!existing) return said;
  return /\s$/.test(existing) ? existing + said : `${existing} ${said}`;
}

/**
 * UI ko dikhane layak wajah. API ke code aam aadmi ke liye bemani hain.
 *
 * ─── PAR CODE CHHUPANA BHI GALAT NIKLA (26 Aug 2026) ────────────────────────
 * Pehla version sirf aam-bhasha wala sandesh lautata tha. Wo theek tha jab tak sab
 * theek chal raha tha — par jab Pardeep ke Chrome me mic permission `Allow` hone ke BAAD
 * bhi kuch nahi hua, to us sandesh se ye pata hi nahi chala ki asli gadbad kya thi: mic
 * device nahi mila, ya network, ya kuch aur. Har sambhavna ke liye ek round lagta.
 *
 * Isliye code ab sandesh ke saath, brackets me, aata hai. Wo aam user ke liye bemani hai
 * — par wo aam user ke liye nahi hai; wo us ek pal ke liye hai jab cheez kaam nahi kar
 * rahi aur kisi ko wajah chahiye. Ek na-samajh aane wala code ek na-samajh aane wali
 * chuppi se behtar hai.
 */
export function dictationErrorMessage(code: string): string {
  const plain = plainMessage(code);
  /* `aborted` ka sandesh khaali hai (user ne khud roka) — us par code chipkane se ek
     bemani line dikhne lagti. */
  return plain ? `${plain} (${code})` : "";
}

function plainMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      /* Sabse aam. Aur ise theek karne ka raasta app ke andar hai hi nahi — wo browser
         ki setting hai, isliye sirf "nahi hua" kehna dead-end hai (CLAUDE.md §24). */
      return "Microphone permission was not given. Allow it from the mic icon in the browser's address bar.";
    case "no-speech":
      return "Didn't hear anything. Please speak again.";
    case "audio-capture":
      return "No microphone found. Check that a mic is connected.";
    case "network":
      return "Voice typing needs internet — no connection found.";
    case "aborted":
      /* User ne khud roka. Ye khabar hai hi nahi. */
      return "";
    default:
      return "Could not recognise your voice. Please type it instead.";
  }
}
