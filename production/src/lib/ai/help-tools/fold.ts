/**
 * Look-alike folding for Help AI (R-2882 / H-01c, review of R-2879 findings 3 and 5).
 *
 * Text written by outsiders — and a key name written by a tool author — can use characters that
 * READ like our own words: fullwidth brackets (＜＜＜), a Cyrillic "а" or Greek "Α" in place of the
 * Latin letter, a dot or dash between two words. Matching on the raw characters misses all of them.
 * `foldForMatch` gives the plain-Latin lower-case form the model would read it as, and
 * `foldWithOwners` keeps, for every folded character, which ORIGINAL character it came from, so
 * a match found in the folded text can be cut out of the original text (the person's real
 * Cyrillic names stay as they are).
 *
 * Pure functions, no imports — help-tools files may use only listed globals (the guard).
 */

/** lower-case look-alike → the Latin letter / bracket it passes for (after NFKD + lower-casing). */
const PAIRS: readonly string[] = [
  // Cyrillic
  "аa", "вb", "еe", "кk", "мm", "нh", "оo", "рp", "сc", "тt", "уy", "хx", "іi", "јj", "ѕs", "ԁd", "ԛq", "ԝw", "ӏl", "һh", "ԍg", "ѵv", "ѡw", "ԃd", "ɡg", "ɑa",
  // Greek
  "αa", "βb", "εe", "ιi", "κk", "νv", "οo", "ρp", "τt", "υu", "χx", "ωw", "ηn", "ζz",
  // Armenian / small capitals / dotless i
  "սu", "ոn", "ıi", "ᴜu", "ɴn", "ᴛt", "ʀr", "ꜱs", "ᴇe", "ᴅd", "ᴀa",
  // angle-bracket look-alikes (NFKC already maps the fullwidth and small forms)
  "‹<", "«<", "〈<", "⟨<", "❮<", "《<", "≪<", "⟪<", "‹<", "›>", "»>", "〉>", "⟩>", "❯>", "》>", "≫>", "⟫>",
];
const LOOKALIKE = new Map<string, string>(PAIRS.map((p): [string, string] => [p.slice(0, -1), p.slice(-1)]));

const MARKS = /\p{M}/gu;
const PLAIN = /^[\x20-\x7e]*$/;

/** Fold ONE original character: decomposed, accents and marks gone, lower-case, look-alikes → Latin. May be "". */
function foldChar(ch: string): string {
  const base = ch.normalize("NFKD").replace(MARKS, "").toLowerCase();
  let out = "";
  for (const c of base) out += LOOKALIKE.get(c) ?? c;
  return out;
}

/** The folded text and, for each folded character, the index (in code points) of the original it came from. */
export function foldWithOwners(text: string): { folded: string; owners: number[]; points: string[] } {
  const points = [...text];
  if (PLAIN.test(text)) return { folded: text.toLowerCase(), owners: points.map((_, i) => i), points };
  let folded = "";
  const owners: number[] = [];
  points.forEach((p, i) => {
    const f = PLAIN.test(p) ? p.toLowerCase() : foldChar(p);
    for (let k = 0; k < f.length; k++) owners.push(i);
    folded += f;
  });
  return { folded, owners, points };
}

/** The plain-Latin lower-case form of a text (for matching only — never shown). */
export function foldForMatch(text: string): string {
  return foldWithOwners(text).folded;
}

/**
 * A key / name reduced to its letters and digits as the model would read them: look-alikes folded,
 * every separator, invisible or other character dropped. "Tеnant-ID" (Cyrillic е) → "tenantid".
 */
export function foldKey(key: string): string {
  return foldForMatch(key).replace(/[^a-z0-9]/g, "");
}
