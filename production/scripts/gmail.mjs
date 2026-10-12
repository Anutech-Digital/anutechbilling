#!/usr/bin/env node
/**
 * Gmail — sirf ERP wale label ke liye. Domain-wide delegation se, koi key file nahi.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * Is app ka aadha jeevan Gmail me hota hai: teen inbound raaste (enquiry, purchase,
 * contacts) wahin se aate hain. Jab koi tootta hai, Cloud Logging batata hai ki APP ne kya
 * kiya — ye nahi ki Gmail ne kya BHEJA tha.
 *
 * Aur ek pakka kaam bhi hai. 24–27 Aug 2026 ke beech purchase wala webhook har request 401
 * kar raha tha (comma-list ke bajaye raw `!==`). Un paanch dinon ke vendor invoice Gmail me
 * `erp-purchase` label ke saath pade hain aur app me kabhi nahi aaye. Unhe wapas laane ka
 * tarika ek hi hai: label hatao, forwarder unhe dobara uthayega.
 *
 * ─── SEEMA, AUR WO JAAN-BOOJHKAR HAI ────────────────────────────────────────
 * Ye Pardeep ka ASLI inbox hai. Isliye:
 *
 *   · `unlabel` sirf usi label ko hata sakta hai jo `erp-` se shuru hota ho. Baaki har
 *     naam par wo mana kar deta hai — galti se `INBOX` ya `IMPORTANT` hatana ek aisa kaam
 *     hai jo wapas nahi hota.
 *   · Mail DELETE karne ka koi raasta yahan nahi hai, aur na hona chahiye. `gmail.modify`
 *     me delete aata bhi nahi.
 *   · `find` kuch badalta nahi. Chhoone se pehle DEKHNA — hamesha.
 *
 * Chalane ka tarika:
 *   node scripts/gmail.mjs labels
 *   node scripts/gmail.mjs find erp-purchase
 *   node scripts/gmail.mjs show <id>                 # ek mail ka matn (padhne ke liye)
 *   node scripts/gmail.mjs unlabel erp-purchase <id> <id> ...
 */
import { execSync } from "node:child_process";
import { SA, SUB as DEFAULT_SUB } from "./apps-script-lib.mjs";

/**
 * KISKA mailbox. Domain-wide delegation domain ke kisi bhi user ko impersonate kar sakti
 * hai, aur 30 Aug 2026 ko wahi sawaal ka jawab nikla.
 *
 * Us din ye maana ja raha tha ki enquiry `pardeep@anutech.in` me aati hai. Naapa gaya to
 * us mailbox me `to:sales@anutech.in` wale 18 mail the aur **satrah ke satrah SENT** —
 * Pardeep ke apne bheje hue test. Ek bhi asli customer ka mail wahan tha hi nahi
 * (`from:someone.test@gmail.com` → 0), jabki wahi mail app me maujood hai.
 *
 * Yaani sales@ ek ALAG mailbox hai. Ek mailbox me dekh kar "mail aaya hi nahi" keh dena
 * is din ki sabse aasan galti thi.
 */
const SUB = (process.env.GMAIL_AS ?? "").trim() || DEFAULT_SUB;

/* `gmail.modify` — padhna aur label badalna. `gmail.readonly` kaafi nahi hai (label hatana
   hai), aur poora `https://mail.google.com/` bahut zyada hai (usme delete aa jata hai). */
const SCOPES = "https://www.googleapis.com/auth/gmail.modify";

/** Sirf ye label chhu sakte hain. */
const SAFE_LABEL = /^erp-/i;

async function token() {
  const my = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: SA, sub: SUB, scope: SCOPES,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600,
  });
  const s = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`,
    { method: "POST", headers: { authorization: `Bearer ${my}`, "content-type": "application/json" },
      body: JSON.stringify({ payload }) });
  if (!s.ok) throw new Error(`signJwt ${s.status}: ${(await s.text()).slice(0, 200)}`);
  const { signedJwt } = await s.json();

  const t = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt }) });
  if (!t.ok) {
    /* §24 — kya hua, kyun, ab kya. 401 ka matlab lagbhag hamesha ek hi cheez hai. */
    throw new Error(
      `Gmail ka token nahi mila (${t.status}). Iska matlab aam taur par ye hai ki DWD me\n` +
      `  gmail.modify jud nahi paya. admin.google.com → Security → Access and data control\n` +
      `  → API controls → Domain-wide delegation → Client ID 104150092217722770237 → Edit,\n` +
      `  aur us box me DONO scope, comma se alag:\n` +
      `    https://www.googleapis.com/auth/script.projects,https://www.googleapis.com/auth/gmail.modify\n` +
      `  (Wo box badal deta hai, jodta nahi — purana scope bhi saath likhna zaroori hai.)\n` +
      `  Google ka jawab: ${(await t.text()).slice(0, 200)}`);
  }
  return (await t.json()).access_token;
}

const api = async (tk, path, init = {}) => {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init, headers: { authorization: `Bearer ${tk}`, "content-type": "application/json", ...init.headers } });
  if (!r.ok) throw new Error(`gmail ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "labels") {
  const tk = await token();
  const { labels = [] } = await api(tk, "labels");
  console.log(`token MIL GAYA — ${SUB} ka mailbox, ${labels.length} label\n`);
  const erp = labels.filter((l) => SAFE_LABEL.test(l.name));
  console.log("erp-* label (sirf inhe chhu sakta hoon):");
  for (const l of erp) console.log(`  ${l.name.padEnd(24)} ${l.id}`);
  if (erp.length === 0) console.log("  (koi nahi)");

} else if (cmd === "find") {
  const label = rest[0];
  if (!label) { console.error("kaunsa label? node scripts/gmail.mjs find erp-purchase"); process.exit(2); }
  const tk = await token();
  const { labels = [] } = await api(tk, "labels");
  const l = labels.find((x) => x.name.toLowerCase() === label.toLowerCase());
  if (!l) { console.error(`"${label}" naam ka koi label nahi mila`); process.exit(1); }

  const { messages = [], resultSizeEstimate } = await api(tk, `messages?labelIds=${l.id}&maxResults=50`);
  console.log(`${label} → ${messages.length} message (estimate ${resultSizeEstimate})\n`);
  for (const m of messages) {
    const d = await api(tk, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const h = Object.fromEntries((d.payload?.headers ?? []).map((x) => [x.name, x.value]));
    console.log(`  ${m.id}  ${(h.Date ?? "").slice(0, 16).padEnd(17)} ${(h.From ?? "").slice(0, 30).padEnd(31)} ${(h.Subject ?? "").slice(0, 50)}`);
  }

} else if (cmd === "search") {
  /* Gmail ki apni query, aur har mail ke LABEL bhi.
     30 Aug 2026 ko ye isliye chahiye tha: `find` sirf label se dhoondhta hai, aur us din
     ka sawaal ulta tha — "is naye email par label laga hai ya NAHI?". Label wali list me
     wo mail hota hi nahi, aur uski GAIR-maujoodgi ko "label nahi hai" padhna galat hota:
     list 50 par kat-ti hai. Isliye mail se poochho, label se nahi.

     Padhne ke alawa ye kuch nahi karta. */
  const q = rest.join(" ");
  if (!q) { console.error('node scripts/gmail.mjs search "to:sales@anutech.in newer_than:1d"'); process.exit(2); }
  const tk = await token();
  const { labels = [] } = await api(tk, "labels");
  const nameById = new Map(labels.map((l) => [l.id, l.name]));
  const { messages = [], resultSizeEstimate = 0 } =
    await api(tk, `messages?q=${encodeURIComponent(q)}&maxResults=25`);
  console.log(`"${q}" → ${messages.length} mila (estimate ${resultSizeEstimate})\n`);
  for (const m of messages) {
    const d = await api(tk, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    const h = Object.fromEntries((d.payload?.headers ?? []).map((x) => [x.name, x.value]));
    /* SYSTEM label (INBOX, UNREAD…) chhupaye nahi gaye — jab sawaal "ye mail gaya kahan"
       ho, tab SPAM ya TRASH hi jawab hota hai. */
    const ls = (d.labelIds ?? []).map((id) => nameById.get(id) ?? id).join(" ");
    console.log(`  ${m.id}  ${(h.Date ?? "").slice(0, 22).padEnd(23)} ${(h.From ?? "").slice(0, 28).padEnd(29)} ${(h.Subject ?? "").slice(0, 44)}`);
    console.log(`      label: ${ls || "(koi nahi)"}`);
  }

} else if (cmd === "show") {
  /* Ek mail ka matn — sirf padhne ke liye, kuch badalta nahi.
     Ye isliye chahiye tha: `erp-purchase` par pade Amazon mail se ye jaanna tha ki wo
     ANUTECH ke Amazon BUSINESS account se aaye hain ya aam consumer account se. Us farq
     par ye tay hota hai ki GST invoice milega ya nahi — aur wo baat mail ke matn me hoti
     hai, header me nahi. */
  const id = rest[0];
  if (!id) { console.error("node scripts/gmail.mjs show <id>"); process.exit(2); }
  const tk = await token();
  const d = await api(tk, `messages/${id}?format=full`);
  const h = Object.fromEntries((d.payload?.headers ?? []).map((x) => [x.name, x.value]));
  console.log(`From:    ${h.From}\nTo:      ${h.To}\nDate:    ${h.Date}\nSubject: ${h.Subject}\n`);

  /* Body kai jagah chhupa hota hai — MIME ka ped chalna padta hai. */
  const walk = (part, out = []) => {
    if (part?.body?.data && /^text\/plain/.test(part.mimeType || "")) {
      out.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
    }
    (part?.parts ?? []).forEach((c) => walk(c, out));
    return out;
  };
  const text = walk(d.payload).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  console.log(text.slice(0, 2500) || "(koi text/plain hissa nahi mila)");

  const att = [];
  const walkAtt = (part) => {
    if (part?.filename) att.push(`${part.filename} (${part.mimeType})`);
    (part?.parts ?? []).forEach(walkAtt);
  };
  walkAtt(d.payload);
  console.log(`\nattachment: ${att.length ? att.join(", ") : "koi nahi"}`);

} else if (cmd === "unlabel") {
  const [label, ...ids] = rest;
  if (!label || ids.length === 0) {
    console.error("node scripts/gmail.mjs unlabel erp-purchase <id> <id> ..."); process.exit(2);
  }
  if (!SAFE_LABEL.test(label)) {
    console.error(`MANA — "${label}" \`erp-\` se shuru nahi hota. Ye script sirf ERP ke apne label chhuti hai.`);
    process.exit(3);
  }
  const tk = await token();
  const { labels = [] } = await api(tk, "labels");
  const l = labels.find((x) => x.name.toLowerCase() === label.toLowerCase());
  if (!l) { console.error(`"${label}" naam ka koi label nahi mila`); process.exit(1); }

  for (const id of ids) {
    await api(tk, `messages/${id}/modify`, {
      method: "POST", body: JSON.stringify({ removeLabelIds: [l.id] }) });
    console.log(`  hataya  ${label}  ${id}`);
  }
  console.log(`\n${ids.length} message se label hata. Forwarder agli baar inhe dobara uthayega.`);

} else {
  console.log(`node scripts/gmail.mjs labels | search "<query>" | find <label> | show <id> | unlabel <label> <id>...

KISKA mailbox: default ${DEFAULT_SUB}. Badalne ke liye GMAIL_AS aage lagao —
  GMAIL_AS=sales@anutech.in node scripts/gmail.mjs search "newer_than:1d"

30 Aug 2026: sales@ ek ALAG mailbox hai. pardeep@ ke mailbox me asli enquiry hoti hi nahi —
sirf uske apne bheje hue test. Ek mailbox dekh kar "mail aaya hi nahi" mat keh dena.`);
  process.exit(2);
}
