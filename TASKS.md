# Tasks

> **STALE — 8 Sep 2026 tak ka (stamped 19 Oct 2026, R-1609). Asli: team board (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n) + code.** Ye file sirf history hai — isse status, counts ya "kya bacha hai" mat padho.

> Living task list — main ise update karta rahunga. Jaise-jaise kaam complete hoga, task `Done` mein strikethrough ho jayega. Tum bhi edit kar sakte ho. Visual board ke liye `dashboard.html` browser mein kholo.
> Full detail: [docs/MONEY-FLOW-TEST-MATRIX.md](docs/MONEY-FLOW-TEST-MATRIX.md) (per-transaction) · [docs/ACCOUNTING-AUDIT.md](docs/ACCOUNTING-AUDIT.md) (P&L / Balance Sheet) · [docs/UX-AUDIT.md](docs/UX-AUDIT.md) (interaction / behaviour) · context: [docs/PROJECT-KNOWLEDGE.md](docs/PROJECT-KNOWLEDGE.md)

## Active

---

# 🟠 HANDOFF — 7 Sep 2026. Subdomain cutover ADHA hai — pehle ise pura karo.

> App ka naya ghar: **reselleros.anutech.in** (live, cert bana, deploy ho chuka — commit 23eecf1).
> Purana anutech.in bhi poora chalta hai. Plan: https://claude.ai/code/artifact/1410baa6-40f1-4dd5-b353-be7e40316baf
>
> **HO GAYA:** Kadam 1 (Cloud Run mapping + Cloudflare CNAME, DNS-only — Claude ne khud lagaya) · Kadam 2 (code 3 jagah + llms.txt, deploy FINAL=SUCCESS, canonical naya).
> **BAAKI (Pardeep ne 7 Sep ko 'baad me' bola):**
> - [ ] **Kadam 3** — GoTrue ko naya SITE_URL + allow-list (VM .env, auth container recreate) — exact paste-command chat me 7 Sep ko diya gaya hai; bina iske naye pate par Google-login purane pate par utaar deta hai. Iske baad SAB users ek baar re-login.
> - [ ] **Kadam 4** — Razorpay dashboard: webhook URL + website URL → naya origin.
> - [ ] **Kadam 5** — Cloudflare 301 redirect anutech.in/* → reselleros (/api/* CHHOD kar), purani mapping HATANI NAHI. Phir E2E verify.
>
> **DSP MERGE (7 Sep):** Phase 0 ✅ (pul live — DSP mare hue Mumbai-URL par tha, ab reselleros.anutech.in/api/v1 + nayi key; Test connection Success; Sync-all JAANBOOJH KAR skip — 27 asli emails jaati). Brick 1 ✅ (agent tooling: notes/time/canned — schema dono DB, test ALL PASS, UI deploy c529cb0, browser-verified TKT-TEST-TOOLING-1 par; PostgREST ko DDL ke baad NOTIFY reload chahiye). Brick 2 ✅ (AI runbooks: domain/hosting/SSL/spam/deleted-mail/billing-crossfire + naya domain_or_hosting topic — deploy ecbe1e0, 65/65 tests). Brick 3 ✅ CSAT (schema 20260907150000 dono DB ALL PASS + portal ★-widget + agent verdict-strip — deploy 4ab6444, browser-verified: CUSTOMER VERDICT ★×5 TKT-TEST-TOOLING-1 par). Agla: bot-intents ka baaki content? nahi — ho gaya; ab bacha: DSP data-migration design (1,228 tickets) + Phase-2 dup-delete + Phase-3 chat/calls buy-vs-build.


---

# 🟢 HANDOFF — 1 Sep 2026. Deep audit (4 auditor, sab naapa hua) ke 26 kaam — status YAHIN update hota hai.

> Poori report: https://claude.ai/code/artifact/7cf5e0d1-b317-492d-ac54-d5a660e5fba8
> Har daave ka file:line saboot report me hai. Pardeep ka nirdesh (1 Sep): saare kaam karo,
> har poora hua kaam isi list me tick karo, permission recommended par khud accept.

## 🔴 AUDIT-P0 — pehle asli customer se pehle (khule darwaze)

- [x] **A1. Invite-takeover band** ✅ 1 Sep — migration `20260901090000` (token) prod par lagi+tracked (0 pending invites the); password-signup ab token+email dono par join karta hai, bina token pending-invite par 409 (account banta hi nahi); invite-email me personal `?invite=` link; Google raasta jaisa tha (mailbox-proof wahi). Pin-test `invite-token.test.ts` (4).
- [x] **A2. Project-quote accept par token** ✅ 1 Sep — migration `20260901080000` prod par lagi+tracked; route/page dono `quoteTokenMatches` se; teeno link-builder `?t=` ke saath; pin-test `project-quote-token.test.ts` (3) — `api/public/project-quote/[id]/accept` bina kisi token/session ke chalta hai; baaki sab quote-routes `?t=` maangte hain.
- [x] **A3. Rate-limiting** ✅ 1 Sep — `lib/security/rate-limit.ts` (fixed-window, per-instance — Cloud Armor ka badla nahi, kharche ka dhakkan; file me likha hai): middleware me sab `/api/public/*` + signup (AI chat 30/5min, likhne-wale 10/10min, PIN 15/15min, GET 120/5min per IP) + PIN par PER-EMPLOYEE 10/ghanta. 10 test (ginti+wiring). Live 429 deploy ke baad naapna hai.
- [x] **A4. `users` DELETE owner-only + audit** ✅ 1 Sep — migration `20260901100000` prod par: DELETE sirf owner (aur kabhi apni row nahi), `current_user_is_owner()` helper, `log_row_change` trigger users par. SQL test `users_delete_owner_only` LIVE green (dono disha + audit-row). Service-role raasta abhi bhi unaudited — wo C-item me darj hai.
- [x] **A5. Overpayment-credit atomic** ✅ 1 Sep — migration `20260901110000`: excess ki `customer_credits` row ab `record_payment` ke ANDAR (live pg_get_functiondef + 3 surgical edits — retype nahi, wahi 22-Aug wala sabak); return me `overpaid_credit`; dialog ka post-commit insert hata. SQL tests LIVE: **7/7** record_payment (naya: atomic+incremental+replay-safe; purane sab bhi green — koi regression nahi).
- [x] **A5b. `refund_payment` RPC** ✅ 1 Sep — migration `20260901120000` LIVE: ek txn me RFV voucher (pehli baar allocate hua!), quote/subscription recompute, overpayment-credit band; GST-invoice par refuse → "pehle credit note" (§24), bank-reconciled/add-seats guards delete_payment jaise. Hook ab RPC par, /payments par "Refund payment" action (reason → voucher). SQL test `refund_payment` LIVE green (6 cases). Gateway-refund jaan-boojh kar manual — return me likha aata hai.
- [x] **A6. CI wiring (aadha)** ✅ 1 Sep — money-check ab PUSH par bhi (deploy/session/main; pehle 0 runs ever) aur pehli baar git me TRACKED; suite-health tripwire CI ke e2e me (dark 54 e2e ab har run me dikhte hain). ⏳ Baki aadha: SQL tests CI me — DB creds GitHub-secrets me rakhne ka faisla Pardeep ka (repo khud ise "decision, not cleanup" kehta hai) — 👉 list me joda.
- [x] **A7. Sentry + uptime monitor** ✅ 1 Sep — NAAPA: dono DSN Cloud Run par pehle se SET the (docs jhooth bol rahe the; health-signals.ts ka comment sudhara). Naya: Cloud Monitoring uptime-check `/api/version` (5 min) + email-alert Pardeep ko + `docs/DEPLOY-ROLLBACK.md` runbook. Sentry ki delivery dashboard se hi verify hogi (reasoned-only).
- [x] **A8. Restore REHEARSED** ✅ 1 Sep — kal raat ke offsite JSON se ANUTECH ke 46 tables/1,993 rows scratch-schema me TYPED load, har ginti mili, sab rollback; canary (bigaadi ginti) laal hua to green asli hai. Repeatable: `scripts/gen-restore-rehearsal.cjs`; BACKUP.md me darj. ⏳ Bacha: auth-users + storage-files kisi backup me nahi (data lauta to bhi login nahi lautega) — agla kaam.

## 🟠 AUDIT-P1 — world-class banane wale

- [x] **B1. Reports page ke PAANCH fabrications khatam** ✅ 1 Sep — audit ne 1 dhoondha tha, andar 5 the: funnel, 12-mahine MRR trend, 17% margin (KPI+per-customer), ID-se-bana "renewal risk", jhoothe trend-badge, +Math.max(lowRisk,1) ka floor. Ab: pipeline leads ki asli stage-ginti, MRR history mrr_snapshots se (1 asli bindu + note), risk sirf seat-utilisation, seats-by-vendor asli; guard `reports-honesty.test.ts` (5). Browser-verified: MRR ₹3,77,370 DB se hu-ba-hu.
- [x] **B2. Default catalog guided raaste me** ✅ 1 Sep — setup-wizard ke Import step me "Load default catalog" card (loaded ho to green tick), aur getting-started checklist me naya kadam "Load your price list" (asli items-count se ticked; ab 6 kadam). Tests updated (10 green).
- [x] **B3. §24 ab MACHINE-enforced** ✅ 1 Sep — ratchet test `toast-error-ratchet.test.ts`: nange toast.error (na description na action) ki ginti baseline 450/481 se UPAR gayi to suite laal (Stop-hook har turn chalata hai). Purana sudhaaro to baseline neeche karo — wapas chadh nahi sakta. CLAUDE.md §24 me darj. (Purane 450 ka safaya alag chal raha kaam hai — ratchet unhe badhne se rokta hai.)
- [x] **B4. In-app notifications** ✅ 1 Sep — `notifications` table LIVE (RLS: apni hi khabar; browser-insert band — spoof-guard) + row-par read_at (localStorage ka cross-device jhol khatam). Emitters: payment.received (Razorpay webhook), quote.accepted (public accept), lead.created (dono enquiry routes), ticket.created (DB-TRIGGER — portal/email/AI teeno raaste ek jagah). Panel+topbar-badge DB se, 60s poll (realtime ka precedent nahi — jaan-boojh kar). SQL test LIVE 1/1 (trigger+RLS+read+spoof).
- [x] **B5. Mobile card-view — 4 customer-facing pages** ✅ 1 Sep — quote-accept (interactive: checkbox+seat-input cards me bhi; ganit EK jagah, do render), portal invoices (Pay+PDF card me), portal orders, project-quote. Mobile-viewport browser-verified (koi side-scroll nahi). ⏳ Baaki 17 internal/accounting tables — alag chhoti lehar.
- [x] **B9. Flex par 12× UNDER-CHARGE band** ✅ 1 Sep — display se kahin gehra nikla: `quoteInstalments` flex ke per-month stored aankdo ko saal maan kar 12 par baant raha tha — **pay-button ₹5,753/month ke badle ₹479 charge karta** (`/api/public/quote/[id]/pay` bhi isi par tha). Ab engine `lineCommitment==="monthly"` par null (stored = mahine ki vasooli), accept-view poora flex-aware ("PAYABLE EACH MONTH ₹5,753/month", "Pay this month"), record_payment ka `v_is_monthly` pehle se sahi tha. 94 billing test + browser-verified. Kisi flex-customer ne abhi tak pay NAHI kiya tha — bach gaye.
- [x] **B6. Deploy hardening** ✅ 1 Sep — startup-probe `/api/version` LIVE (aur usi din saboot: kharab-probe wali revision ready nahi bani, traffic purani par tika); rollback runbook `docs/DEPLOY-ROLLBACK.md` + ASLI rehearsal (00460→00458→latest, ~1 min, dono taraf zinda). ⏳ migrations-verify deploy-gate: Cloud Build ko DB creds chahiye — wahi Pardeep-faisla jo A6 ka hai.
- [x] **B7. Data-export + forecast** ✅ 1 Sep — quotes/leads/subscriptions par Export CSV (pure builders `lib/export/crm-csv.ts` + tests; customers/payments par pehle se tha — audit ka wo hissa galat nikla, aur **GSTR-1 gov-format bhi /accounting/gst par pehle se tha** — meri duplicate banne se pehle hati). /renewals par 6-mahine ka forecast-chart (flex ALAG, jod me nahi — 12× sabak; `forecast.ts` + 4 tests). Browser-verified: ₹0 bhi sach hai (annual book Aug-27 me renew hota hai).
- [x] ~~**B8. Hindi i18n**~~ ❌ CANCELLED — Pardeep ka faisla (1 Sep): "hindi ui nahi karna hai". UI English+Hinglish hi rahegi. `next-intl` (dead dep) uninstall; CLAUDE.md §2/§13 se "Hindi planned" ka jhooth hata. Roadmap me dobara nahi aayega.

## 🟡 AUDIT-P2 — chamak

- [x] C1 ✅ 1 Sep — CSP live (object-src none/base-uri/form-action kase; script udaar — file me kyun likha), logos bucket SVG-mukt (migration; sab PNG the), browser me 0 violation
- [ ] C2. 23 tenant_id + top FK indexes ka migration
- [x] C3. Stale docs ✅ 1 Sep — LAUNCH_READINESS: dated stale-banner (10 "not built" items verified SHIPPED against code; Hindi-i18n false claim flagged). MONITORING_SETUP: Sentry already LIVE (DSN set on prod, verified via gcloud) + Excel→ANUTECH. CLAUDE.md §17b + bank.ts:669 docstring theek ho gaye C5 me. proration.ts:38 pehle se honest. MONEY-FLOW matrix pehle se 1-Jun par revised (snapshot vs §2.1 current) — jhooth nahi.
- [x] C4 (aadha) ✅ 1 Sep — reportCron ab 18/18 wired; ⏳ scheduler-script ke 6 missing jobs + murda configs hatana baaki
- [x] C5. Bank-reconcile ek atomic RPC me ✅ 1 Sep — reconcile_bank_txn (migration 20260901160000). 6 chained client-writes → 1 transaction; dono hooks (useReconcileTransaction + useAutoReconcile→applyReconcile) ab isi ko call karte hain, drift band. Test: supabase/tests/reconcile_bank_txn.test.sql (mutation-verified). Gate 4/4 green. CLAUDE.md §17b update.
- [x] C6 ✅ 1 Sep — "" fallback ab THROW hai (khaali chaabi = forgeable sab); .env.example me 9 vars darj; alag PDF_SIGNING_SECRET jaan-boojh kar prod par NAHI rakha (purane links tootte) — rotation ke waqt
- [~] C7. Bulk/undo/j-k propagation; nav progressive-reveal — PARTIAL (1 Sep)
  - [x] Nav progressive-reveal: pehle se LIVE — Sidebar single-open accordion (sirf current section khula, baaki collapsed). Browser me confirm kiya.
  - [x] j/k propagation → **customers** screen par jod diya (useListKeys, aria-selected + amber tint, KeyHintBar). Browser-verified real data par: j/k navigate, o opens Anitatech. Gate 4/4.
  - [x] j/k → **payments** bhi (PaymentRowView ko selected/rowRef props; enabled sirf non-project view; gate 4/4). 
  - [ ] j/k baaki lists par: invoices, online-orders, projects, expenses, attendance (paused — merge priority)
  - [ ] Bulk-select propagation: invoices par pehle se hai; baaki lists par nahi
  - [ ] Undo propagation: leads/payroll/attendance par hai; delete-actions par extend karna
  - NOTE: teenon 'propagation' hain — pattern maujood, N-screens par phailana. Batch me Pardeep greenlight kare to karta rahunga.
- [x] C8 ✅ 1 Sep — dono Google-token routes getUser-first (provider_token session se, darwaza getUser se); dono WhatsApp handshake constant-time
- [ ] C9. Bundle budget + analyzer; plausible ya hatao daava
- [ ] C10. Input validation on remaining JSON routes — details on the board (R-1432)

## 🧭 MERGE (website+DMS+ResellerOS) — naksha: https://claude.ai/code/artifact/1f80ef89-2cd6-42a4-89ed-090014f31b6f

Chaaron faisle Pardeep ne mujhe saunpe (1 Sep shaam) — liye gaye:
- [x] **F1. DMS repo PRIVATE** — faisla haan; ⚠️ mera GitHub-account us org me admin nahi (404) → **Pardeep ka 1 click** (neeche 👉 me).
- [x] **F2. Domain-batwara** — www.anutech.in = chehra (website), app.anutech.in = dukaan (DMS), root→www. (DNS Phase 1 me.)
- [x] **F3. Homepage website ka** — DMS ke dono marketing-variants + admin-toggle Phase 1 me 301/retire.
- [x] **F4. ₹1 offer website se UTAR gaya** ✅ — engine+tests fixture par salamat; wapas = DMS promo-engine (Phase 3) ke baad ek line. Live map ka khaali rehna ab TEST se pinned.

Aage (kram se):
- [x] **M0. DMS Phase-0 suraksha** ✅ 1 Sep — PR #1 (IDOR ownership-scoped, secrets AES-encrypt, backup redact, XFF last-entry, webhook constant-time, role-leak) + PR #2 (2 public read-API) DONO merge to main. ⏳ Baaki sirf: DMS DEPLOY (Pardeep ka pipeline) + Razorpay key/webhook ROTATE (dashboard).
- [~] **M1. Jod (chal raha)** — DMS ke 2 public read-API bane (PR #2, availability+tld-pricing, 9 test); website ka hero-search ab ASLI (nakli hash gaya) aur /domains + /pricing rate-card live-merge par (live-tld-pricing.ts). Bacha: (a) website www par deploy, (b) DMS marketing 301. **Buy→cart handoff JAAN-BOOJH KAR Phase-2 me** — cross-origin cart-bridge Phase-2 ke shared-cart me delete ho jata, isliye throwaway nahi banaya. Zinda hone ki shart: DMS PR #1+#2 merge+deploy.
- [ ] **M2. Ek ghar**: website → DMS (marketing) route-group; SEO greenfield; ek cart; cross-repo test-path theek.
- [ ] **M3. Promo-engine DMS me** (₹1 wapas) + inner reskin + webhook-consolidation.

## 👉 sirf Pardeep (audit se)

- [ ] 3 open security/ops owner items from the 1 Sep audit — details on the board (R-1432)

# 🟢 HANDOFF — 25 Aug 2026 (शाम). Satrah feature, ek bhi migration nahi, aur chaar cheezein jo LIVE tooti hui hain.

> Neeche isi din ka subah ka handoff hai, phir 24 Aug ka. **Yahan se "kya karna hai" lo. "Kyun"
> par bharosa mat karo** — is file ke kaaran teen baar galat nateeje nikle hain, aur aaj bhi
> mere hi do dawe naapne par galat nikle. Wo neeche `MAINE JO GALAT KAHA` me hain.
>
> **Sabse zaroori do minute:** seedha `🔴 LIVE TOOTA HUA` par jao. Baaki baad me padho.

## 🔴 LIVE TOOTA HUA — inhe chhune se pehle jaan lo

**1. `quoteIsWarranted` bina digit wale message par 30-seat quote paas karta hai.**
`leads.seats` null ho aur model `seats_discussed: 30` de — *"poori team ke liye chahiye"* par,
jis message me **ek bhi ank nahi hai** — to `quoteIsWarranted` **true** deta hai.
[`quote-dispatcher.ts:313`](production/src/lib/ai/actions/quote-dispatcher.ts) model ke padhe
number par gir jaata hai, aur neeche ka ek hi likhawat-guard `seatsHeardNotWritten` hai — jo
**sirf voice note** ke liye hai. Naap kar dekha, andaza nahi.
**Ab kam hai, khatam nahi:** `lib/ai/pipeline.ts` ka qualifier ise `HANDOVER` bana deta hai —
**jab wo chalta hai.** Qualifier fail ho (Gemini null de) to purana raasta wapas aa jaata hai.
👉 **Poora band karne ka matlab hai dispatcher ka seat resolution har channel ke liye badalna.
Wo money code hai — CLAUDE.md §0.4 ke tehat plan + Pardeep ki haan chahiye. Maine jaan-boojh
kar nahi chhua.**

**2. Resend ka sending domain verified NAHI hai.**
25 Aug ko `dunning.send` fail hua: `Resend 403 — "You can only send testing emails to your own
email address (pardeep@anutech.in). To send emails to other recipients, please verify a
domain"`. Key **set hai**, domain **nahi**. Iska matlab: customer ko koi bhi automated mail
**jaata hi nahi, fail hota hai**.
👉 Ye us baat ko sudhaarta hai jo maine aaj subah kahi thi (neeche dekho).

**3. `leads.domain` webhook path par HAMESHA khaali hai.**
28 lead, **har ek par NULL**. Wo column sirf trial aur public-checkout route bharte hain (form
me poochha jaata hai). AI sales agent **inbound email/WhatsApp webhook** se bane leads par
chalta hai, jo use kabhi nahi bharte.
**Ek line se theek kiya** (`businessDomainFromEmail(args.customerContact)`) — par jaan lo ki
**do "poore" feature do din andhere me thay**: domain observation aur switch/trade-in block.
Dono ke test green thay. Test us line ko cover hi nahi karte thay.

**4. Aath block sirf "dial set nahi hai" ki wajah se hain.**
`ai_action_log` me 90 din: **33 drafted, 0 sent**, 23 held + 8 failed. Sabse aam rukawat —
`no setting for this action, so its default "hold" applies`, **31 me 8 baar**.
👉 Ye guard nahi hai. Ye **anset setting** hai. `/automation` par jaakar dial tay karo.

### 🔵 SHAAM KA DOOSRA HISSA — chaar "seekhne wale loop" aur do faisle jo dohraye jaayenge

Shaam ko chha feature aur bane (kul **chhabbis commit**, `anutech/deploy` se **41 aage**, test
**5,320** / 264 file). Inme se **chaar ek hi shape ke hain** — AI apne se seekhe — aur agli session
me ye **dobara maange jaayenge**. Chaaron ka jawaab ek jagah likha hai taaki dobara na sochna pade:

| Loop | File | Faisla | Kyun |
|---|---|---|---|
| Won deals se seekhna (Vector RAG) | `lib/ai/playbook.ts` | **Sirf sawaal seekhta hai, jawaab nahi** | Won-deal filter *asardaar* hone ka filter hai, *sach* hone ka nahi |
| Raat ka reflection cron | `lib/ai/reflection.ts` + `api/cron/ai-reflection` | **Output prompt me KABHI nahi** | Reflection customer ka text padhta hai; prompt me guards hain → **prompt injection** |
| ~~Human rep ka jawaab (RLHF)~~ | ~~`lib/ai/gold-standard.ts`~~ — **30 Aug 2026 ko hata diya** | Asool sahi tha: *wahi guards jo agent par lagte hain, phir aadmi ki haan* | Code kabhi chala hi nahi — 520 line, sirf apna test. Asool yahan likha hai; jis din ye feature banega, isse shuru karna |
| Lost deals se seekhna | `lib/ai/loss-analysis.ts` | **Diagnosis ko sahi kism ke fix par bhejta hai** | Price aur delay ke **ulte fix** hain |

**Chaaron ka ek hi asool:** kram badalna surakshit hai, **dawa jodna nahi.** Ye module
`AUTHORISED_CLAIMS` ka subset assert karte hain: `tone.ts`, `trade-in.ts`, `playbook.ts`.

> ⚠️ **30 Aug 2026 — `ab-test.ts` aur `insights.ts` HATA diye gaye.** Dono kabhi kisi asli
> code se nahi bulaye gaye — sirf apne test se. 598 + 553 line, aur unme se **ek bhi line
> kabhi chali nahi**. Naapa gaya us din, jab poochha gaya ki "loop engineering" is app me
> lagayi ja sakti hai ya nahi: jawab nikla ki loop pehle se bane the, bas chalu nahi the.
>
> Pada hua code padhne wale ko bhramit karta hai — wo maan leta hai ki feature maujood hai.
> Git me sab bacha hai; zaroorat pade to wapas aa sakta hai.
>
> **`gold-standard.ts` bhi usi din hata diya** (520 line test samet, sirf apna test use
> karta tha). Teeno milakar **1,671 line** — aur unme se ek bhi line kabhi nahi chali.
>
> **Jo hataya wo code hai, faisla nahi.** Upar wali table me teeno ka asool likha hua hai,
> kaate hue roop me. Jis din inme se koi feature sach me banega, wo asool wahin se uthana
> chahiye — kyunki wo asool sahi the; bas unhe kisi ne wire nahi kiya tha.

**Aur ek farq jo yaad rakhna:** `loss-analysis.ts` ka `safeToApplyAutomatically` **jhoota
inkaar nahi hai.** Authorised claims ka kram automatic badalna **sach me surakshit hai** — sirf
sample nahi hai (15 price-loss chahiye, **0 hain**). Baaki teen loop me automation **usool se**
mana hai. Ye farq mitao mat.

### 🔴 Naye naap — jo agli session ko pata hona chahiye

| Naap | Value | Matlab |
|---|---|---|
| `quotes` | 31 → **27 accepted, 0 LOST** | Lost-deal analysis ke liye **kuch nahi hai** |
| `leads.lost_at` | **har row par null** | Deal "lost" mark hi nahi hoti |
| `leads.lost_reason` | **kabhi nahi likha** | Diagnosis ka sabse acha source khaali hai |
| `ai_sales_conversations` role='agent' | **0** | Agent ne kabhi jawaab nahi diya → latency naapi hi nahi ja sakti |
| Held draft timeline par | **12** | Ye likhe gaye aur bheje nahi gaye |
| `ai_action_log` held | **23** | Handover trigger **chalta hai** — RLHF ke liye asli material |
| pgvector | **install nahi** | "Vector DB" maujood nahi |
| won deal jispar conversation ho | **0 / 27** | Playbook shoonya se bharta |
| `ai_knowledge_base` | **table nahi hai** | Maine banai bhi nahi — schema par tumhari haan chahiye |

### 💰 SLA ka asli exposure — jo agli session ko naapna nahi padega

30-seat Business Starter, asli catalogue (msrp ₹270 / wholesale ₹110 per seat per **month**):

```
customer deta hai ......... ₹8,100 / mahina
hamara margin ............. ₹4,800 / mahina
99.0-99.9% mahina, 15% ... ₹1,215  =  margin ka 25%
95-99%, 25% credit ....... ₹2,025  =  42%
95% se neeche, 50% ....... ₹4,050  =  84%
```

Google ka apna credit schedule, **hamare invoice par**. Aur peeche sahara nahi:
TASKS.md:1564 — reseller agreement **approved nahi**. Isliye `agreement.esign.send` dial
**`off`** hai aur uska **`auto` setting hai hi nahi**.

### Aur do guard chhed jo shaam ko band hue

1. **Telecall ka seat count bina guard tha.** `heardNotWritten` webhook me **kahin nahi** tha, aur
   us route ka comment jhootha tha (*"the seat count ... is checked above"* — **upar kuch nahi
   jaanchta tha**). Ab pass hota hai; sirf **ROK** sakta hai.
2. **`takes?` ek vaada exempt kar raha tha.** *"We will take 3 days."* **rule likhe jaane ke din
   se SAFE tha** — `takes?` bare form bhi match karta hai. Ab bare `take` sirf modal ke baad
   exempt hai.


## MAINE JO GALAT KAHA — aaj, aur naapne par pakda gaya

**"RESEND_API_KEY set hai, isliye galat-price wala auto-quote ka risk live hai."**
Aadha sach. Key set hai — par **domain verified nahi hai**, to wo quote customer tak *jaata
hi nahi, 403 par marta*. Risk utna live nahi tha jitna maine kaha. `quote.send = hold` phir
bhi sahi faisla hai, par wajah alag hai.

**"`ai_autonomy` ke dials ke liye UI hi nahi hai."** — ye likhne se pehle grep ne galat sabit
kar diya. Page hai: `/automation` (`src/app/(app)/automation/page.tsx`) + `/api/ai/autonomy`.
**`/settings/automation` nahi hai** — maine wahi link likha tha aur `typedRoutes` ne typecheck
par pakda.

## Aaj kya bana — satrah commit, `anutech/deploy` se 32 aage

Test **4,346 → 5,046** (+700), 256 file. **Koi migration nahi lagi** (kal chha lagi thi,
drift 0 hai). Har commit par gate: typecheck 0 · test green · lint 0 · build exit 0.

| Feature | File | Sabse zaroori baat |
|---|---|---|
| **3-stage pipeline** (SDR → price → close) | `lib/ai/pipeline.ts` | **Price stage `kind: "code"` hai aur test use wahan rokta hai.** Pricing agent chha guard ek saath paar karta hai |
| Tone switching | `lib/ai/tone.ts` | Tone **kram badalta hai, dawa nahi jodta** — `leadWith ⊆ AUTHORISED_CLAIMS` test |
| Trade-in / switch | `lib/ai/trade-in.ts` | Offer pehle se authorised tha ("free migration"); bas kabhi lead nahi kiya jaata tha |
| **Disparagement guard** | `lib/ai/disparagement.ts` | *"Your legacy GoDaddy setup is outdated"* **har guard se nikal jaata tha** |
| AI performance panel | `lib/ai/performance.ts` + `components/features/dashboard/ai-performance-card.tsx` | **0 send = `null`, `0%` nahi.** "Touched", "generated" nahi |
| Lead grading | `lib/leads/grading.ts` | **Free mailbox negative signal NAHI hai** — wo customer hai jisne hamara product khareeda hi nahi |
| Guard: minutes/seconds + Hindi din | `lib/ai/promise-check.ts` | "10 minutes", "aaj hi", "10 seconds" — sab pehle **safe** thay |

### Prompt ke do virodh jo aaj theek hue (dono mere hi chhode hue)

1. `WHAT YOU MAY PROMISE` me `no 3.5% foreign-currency card loading` tha, aur **usi prompt** me
   net-cost block kehta tha `do NOT state what a card or bank charges`. Dono har us message par
   maujood thay jisme product + seats thay. `3.5%` hataya (`net-cost.ts:21` — issuers
   1.75%–3.5% lete hain, ek number jhoothi precision hai). `100%` ITC **bacha hai** — wo kanooni
   haq hai, kisi aur ke bank ka andaza nahi.
2. Trade-in block khud kehta tha `"runs on GoDaddy TODAY"` aur `"you MAY PROMISE"` — **dono
   token `findPromises` refuse karta hai.** Wo **har switcher ki reply rok deta**.

## 👉 PARDEEP KE LIYE — jo sirf tum kar sakte ho

| # | Kaam | Kyun rukas hai |
|---|---|---|
| 1 | **Resend par domain verify karo** | Iske bina koi automated mail customer tak nahi jaata (403) |
| 2 | **`/automation` par dial tay karo** | 8 block sirf "setting nahi hai" ki wajah se. `quote.send` abhi `hold` hai — jaan-boojh kar |
| 3 | **Add-on catalogue banao** | Cross-sell ke liye — 25 item hain, **add-on ZERO**. Neeche dekho |
| 4 | `tenants.followup_value_drop` ka paragraph likho | Cadence ka Day-4 step iske bina skip hota hai |
| 5 | Razorpay **live** keys | Abhi `rzp_test_` hai; `decideProvisioning` test key par mana karta hai |
| 6 | `SARVAM_API_KEY` | Voice note transcription |
| 7 | Google CSP application | **Shuru bhi nahi hui.** Iska matlab: AI **"official Google Partner" nahi keh sakta** (guard lagaya hai) |
| 8 | Cloud Scheduler jobs | `ai-support-sla`, `ai-telecall-renewals` |
| 9 | Telephony partner email | Exotel / Plivo / Ozonetel — draft ban chuka hai |
| 10 | **Deploy** | 32 commit aage |

## Catalogue ki do gadbad jo cross-sell rokti hain

**Add-on ek bhi nahi.** 25 item, **saare `kind='main'`**. `loadSalesCatalog` `kind='main'` par
filter karta hai *taki add-on bahar rahein* — aur add-on hai hi nahi, to filter abhi no-op hai.
Par wajah asli hai: **add-on per-seat priced nahi hote**, to unhe per-seat quote karna wahi
barah-guna class ki galti hai.

**Aur saat item ke naam bare tier hain:** `Basic` ₹250, `Free` ₹0, `Moderate` ₹667, `Premium`
₹1667, `Standard` ₹125 (hosting), `Starter` ₹50 (hosting), `Plus` ₹187 (hosting) — sab
`kind='main'`. **`Starter` ₹50 (hosting) theek `Google Workspace Business Starter` ₹270 ke
paas baitha hai**, aur `resolveItem` **exact name match** karta hai. Agar kisi lead ka
`plan` bas `"Starter"` hua, wo ₹50 wale hosting item se match karega.
👉 **Ye jaancha jaana chahiye.** Maine naam nahi badle — item ke naam badalna commercial
faisla hai, cleanup nahi.

## Aaj ka pattern — agli session ke liye

**Satrah feature me se pandrah me kuch aisa mila jo theek dikhta tha aur theek nahi tha.** Ye
sanyog nahi. Teen baar ka dohraav:

1. **Prompt ka nirdesh guard nahi hota.** `MIGRATION_CLAIMS_FORBIDDEN` "current provider bad"
   mana karta tha — aur wo vaakya har check se nikal jaata tha.
2. **Green test ka matlab "chal raha hai" nahi hota.** Do feature do din andhere me thay, saare
   test green.
3. **Mutation test me green ke do matlab hote hain** — guard theek hai, *ya* mutation lagi hi
   nahi. Aaj teen baar sed/perl/`node -e` ne backslash kha kar chup-chaap kuch nahi badla.
   **Har mutation ke baad `diff` se naapo, test se pehle.**

---

# 🟢 HANDOFF — 25 Aug 2026. AI Telecalling agent bana, migration lagi, aur auto-quote ka brake laga.

> Neeche 24 Aug ka handoff hai. **"Kya karna hai" lo, "kyun" par bharosa mat karo** — is file
> ke kaaran pehle bhi galat nikle hain. Aaj bhi do dawe naapne par galat nikle, dono neeche
> likhe hain.

### ✅ Migration prod par lag gayi (25 Aug), aur SQL test ne ek asli bug pakda

`20260825120000_ai_telecalling.sql` **applied + tracked**. `db push` nahi chalaya — sirf apni
file `db query -f` se, phir `migration repair`. Verify **ALAG run** me (skill §2): 1 naya table ·
19 column · 6 index · 2 policy · RLS ON · `subscriptions` par additive unique key ·
1 trigger. Dono composite FK par **`confdelsetcols` sahi** — `{lead_id}` aur
`{subscription_id}` akele, `tenant_id` list me **nahi** (wahi bug jo bare form me hota hai).
`migration list --linked` ab phir se **drift 0**.

Backup pehle liya: `resellersos-data-2026-08-25T03-31-03-386Z.json` — **114 table / 1,652 row**
(pichhla known-good 114/1,645; table count wahi, 7 row zyada).

**🔴 Aur phir isolation test ne wo pakda jo maine khud likha tha aur khud tod diya tha.**
Ek hi migration me do guard the jo aapas me ladte hain:

```
check (lead_id is not null or subscription_id is not null)   -- has_subject
foreign key ... on delete set null (lead_id)                 -- lead_fk
```

Jis lead ko call kiya gaya ho use delete karo → Postgres `SET lead_id = NULL` chalata hai →
lead-only row me **dono null** ho jate hain → CHECK fire → **DELETE hi refuse ho jata hai**
(`23514 ... CONTEXT: UPDATE ONLY ... SET lead_id = NULL`). Yaani **bilkul wahi failure jise
rokne ke liye column list likha tha**, doosre darwaze se, usi comment ke ek screen neeche.

Fix `20260825140000_ai_telecall_subject_check_on_insert.sql` — CHECK hataya, rule **BEFORE
INSERT trigger** me daala. UPDATE jaan-boojh kar cover nahi kiya, kyunki FK ka SET NULL ek
UPDATE hi hai. Sabak: **CHECK "hamesha" kehta hai, requirement "likhte waqt" ki thi.** Lead
delete hone ke baad dono null hona galti nahi, wahi intended end state hai — `phone_number`
aur `transcript` row par bache rehte hain.

Test ab poora green (exit 0), aur green sach hai: ek assertion palat kar dekha → exit 1 aur
`FAIL 1: a call log was allowed to point at ANOTHER TENANT'S lead` screen par aaya.
Prod par residue zero — `ai_telecall_logs` **0 row**, tenants 3, quotes 20, leads 27, subs 16.

### Kya bana

| Cheez | File |
|---|---|
| Schema — call log, composite FK, RLS, retry guard | `supabase/migrations/20260825120000_ai_telecalling.sql` |
| Schema fix — subject rule INSERT par, CHECK me nahi | `supabase/migrations/20260825140000_ai_telecall_subject_check_on_insert.sql` |
| Persona + script + dynamic variables (pure) | `src/lib/ai/telecaller-prompt.ts` · **21 test** |
| Call ke faisle — number, ghanti, outcome (pure) | `src/lib/ai/telecall.ts` · **47 test** |
| DB side — row likhna, history padhna | `src/lib/ai/telecall.server.ts` |
| **Chokepoint** — dial pehle, vendor baad me | `src/lib/ai/actions/telecall-dispatcher.ts` · **21 test** |
| Retell / Vapi client (ek darwaza) | `src/lib/telecall/provider.ts` |
| Post-call payload normaliser (pure) | `src/lib/telecall/inbound.ts` · **20 test** |
| Lead/subscription loader (ek jagah) | `src/lib/telecall/subject.server.ts` |
| Outbound trigger API | `src/app/api/v1/telecalling/make-call/route.ts` |
| Post-call webhook | `src/app/api/v1/telecalling/webhook/route.ts` |
| Renewal cron (roz 10:30 IST, Mon–Fri) | `src/app/api/cron/ai-telecall-renewals/route.ts` |
| SQL isolation test (7) | `supabase/tests/ai_telecalling_tenant_isolation.test.sql` |
| Scheduler entry + env docs | `scripts/setup-cloud-scheduler.sh` · `.env.example` |

Gate: `typecheck` 0 · `test` **4,483 pass** (237 file, +137) · `lint` 0 error · `build` 0.
Teeno route build me dikhte hain. Do mutation se laal karke dekha (neeche).

### 🔑 Chaar faisle jo tumhe pata hone chahiye

**1. Brief ne daam maange the, aur unme se ek GALAT tha.** Brief kehta tha "Standard
₹750/mo". Live catalogue me `GW-STD-fbb` ka `msrp` **864** hai. 750 bolna matlab ₹114/seat/
month kam — 12 seat par saal ka **₹16,416** — aur wo bhi **phone par, bolkar**.

Par asli baat wo nahi. Agar 750 sahi bhi hota, tab bhi wo **doosra source** hota, aur hardcoded
number apne aap se hamesha sahmat rehta hai — koi test use baasi hote hue nahi pakad sakta.
Isliye `telecaller-prompt.ts` me **ek bhi number nahi** hai; catalogue call ke waqt padha jaata
hai. Ek test uski apni source padhta hai aur 3+ digit ka koi bhi literal mile to laal ho jaata
hai. **750 wapas daal kar dekha — laal hua.** Sirf `Microsoft 365` ki chhoot hai, aur wo test
me naam lekar likhi hai (regex dheela karne se 750 phir ghus jata).

**2. Awaaz wapas nahi li ja sakti — aur isse guard ka matlab hi badal jata hai.** Is codebase
ke saare rule maante hain ki message TEXT hai: galat daam ke baad correction bheji ja sakti
hai, draft pehle se maujood hota hai, aur `hold` ka matlab hai insaan pehle padhega. **Call me
ye teeno nahi hain.** Isliye `verifyCallMoney` transcript par call ke BAAD chalta hai — wo kuch
rok nahi sakta. Uska poora faayda itna hai ki insaan ko seconds me pata chal jaye, aur wo
docstring me **"detector, not a guard"** likha hai. Uska blind spot bhi likha hai: speech-to-
text "das hazaar teen sau" shabdon me deta hai, aur `verifyDraftMoney` **digit** dhoondta hai.

**3. `telecall.place` dial `hold` par hai, aur `hold` khaali nahi hai.** Number nikalta hai,
catalogue padhta hai, poori script aur dynamic variables banata hai, `ai_telecall_logs` me
`status='held'` likhta hai — aur ghanti nahi bajata. Operator wahi row kholkar dekh sakta hai
ki kya bola jaata aur kise, phir haath se call kar le. Yahi wo saudaa hai jo kisi ko dial
sirf "faayda lene ke liye" ghumane se rokta hai — wahi shape jo `support.reply.send` ne liya tha.

**4. Call se bani quote purane hi darwaze se jaati hai.** Webhook `dispatchSalesDecision` ko
bulata hai, apna doosra quote path nahi banata. Matlab phone se aayi quote par bhi `reply.send`
ka dial, seat ceiling, aur `next_document_number` wahi lagte hain — telecalling on karna
customer ko likhne wale brake ka rasta nahi ban sakta.

### ✅ Aur teen defect jo design me hi band kiye (test-backed)

- **Transcript se intent NAHI padha jaata.** "No, please don't send me a quote" me "quote"
  shabd hai. Keyword match thoda kharaab faisla nahi deta — wo us insaan ko quote bhej deta hai
  jisne saaf mana kiya. Isliye sirf vendor ki structured analysis padhi jaati hai; na ho to
  `action_taken = none` aur record par likha jaata hai ki analysis nahi aayi.
- **Webhook tenant BODY se nahi leta.** Signature payload ko *authentic* banata hai, *sahi*
  nahi. Row hum khud likhte hain, isliye tenant wahi se aata hai (`findTelecallByProviderCallId`).
- **Retry se do quote nahi banti.** `(tenant_id, provider_call_id)` par unique index + row-level
  `alreadyFinished` check. Dono vendor slow response par dobara POST karte hain.

### 📌 Jo BAAKI hai

1. **Koi vendor account nahi hai.** `RETELL_*` / `VAPI_*` kahin set nahi. Bina inke bhi cron
   chalta hai aur har call ka record banta hai — dial nahi karta, wajah likh deta hai.
2. **Vendor agent par 5 analysis field configure karne padenge** — naam `.env.example` ke
   aakhir me exact likhe hain. Inke bina quote-trigger kabhi nahi chalega.
3. **Cloud Scheduler par job banayi nahi** — entry `scripts/setup-cloud-scheduler.sh` me hai
   (`30 10 * * 1-5`), script chalayi nahi.
4. **`doNotCall` abhi hamesha `false`** — customer record par flag hai hi nahi. Guard maujood
   hai aur chalta hai; use khilane wala column banana baaki hai. Dono route me ye baat likhi hai.
5. **Koi UI nahi.** `held` row aur `ai_telecall_logs` sirf DB me hain. Lead timeline par note
   jaata hai, par "Waiting on you" jaisi screen telecall ke liye nahi bani.

### ⚠️ Do dawe jo naapne par galat nikle (24 Aug ke handoff me)

- **"Aaj ke 8 commit live par nahi hain"** — `anutech/deploy` se HEAD **12 commit** aage tha,
  aur usme AI sales agent aur support agent bhi hain. Yaani wo deploy sirf daam theek nahi
  karta, do agent ko pehli baar asli inbound mail par chaalu karta hai.
- **"`quote.send` dial `auto` par hai"** — nateeja sahi, wajah galat. Prod ke `ai_autonomy` me
  **0 row** thi. `quote.send` `auto` isliye tha kyunki `autonomy.ts` ka code default
  `today: "auto"` hai — **kisi ne on nahi kiya tha**. Do baat: deploy isse nahi badalta, aur
  ise `hold` karna ek naya row banana hai — code chhue bina lagne wala sabse sasta brake.
  (Wo row aaj daal diya gaya — neeche.)

### 🔴 Teen baar poochha gaya sawaal ab band hai — aur jawaab bura hai

**`RESEND_API_KEY` Cloud Run par SET hai.** 36 character, prefix `re_`, secret-ref nahi seedha
env var, aur wo bhi us revision par jispe **100% traffic** hai (`resellersos-00391-lqn`).
Service `resellersos`, region **asia-south1** — `gcloud config` ka default region
`asia-northeast2` hai, jo galat hai; region galat dene par service "exist hi nahi karti" lagti hai.

Yaani `isEmailConfigured()` live par **true** deta tha, aur wo gate **khula** tha. Poori chain
naapi gayi, har kadi live:

| Kadi | Haalat | Kaise naapa |
|---|---|---|
| `isEmailConfigured()` | khula | `RESEND_API_KEY` serving revision par maujood |
| `quote.send` dial | tha `auto` | `ai_autonomy` 0 row → code default |
| Kill switch | off | teeno tenant par `ai_kill_switch=false` |
| Gmail bhej sakta hai | haan | ANUTECH `email_provider=gmail` + `gmail.send` token |
| Galat-product bug | **live** | `containsWord`/`isAmbiguousSingleWord` `anutech/deploy` me 0 match |
| Live code | 24 Aug 16:19 IST | revision creation ≈ `20275ef` (16:12 IST); saare fix 18:47 ke baad |

Ek hi brake bacha tha: `termAssumed` — quote tabhi apne aap jaati hai jab customer ne khud
"monthly"/"annual" likha ho.

**Ek sudhaar:** 12× wala msrp bug live **nahi** tha — wo `loadSalesCatalog` me hai, jo AI sales
agent ka hissa hai, aur wo agent hi live nahi hai. Live bug sirf galat-product wala tha.

### ✅ Brake laga diya (25 Aug) — ek row, deploy nahi

`ai_autonomy` me pehla row daala: ANUTECH · `quote.send` · **`hold`**. Verify alag connection se.
Aur — asli check — **live branch ye row padhta hai**: `autonomy.server.ts` me
`from("ai_autonomy")`, `send.ts` me `resolveAutonomy(`, `send-auto-quote.ts` me
`automated: { ... action: "quote.send" }`, aur live ka `quote.send` `supports` me `"hold"`
maujood hai (warna dial "ye mode nahi chalta" kehkar default par laut jata). `loadAutonomyPolicy`
`cache: "no-store"` par hai, to stale bhi nahi milega.

Wapas kholna ek row hatana hai:
```sql
delete from public.ai_autonomy where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42' and action='quote.send';
```

**Deploy ab bhi baaki hai** (12 commit) — par ab wo jaldi ka kaam nahi, aaram se ho sakta hai.
Dhyaan rahe: wahi deploy AI sales agent aur support agent ko pehli baar asli inbound mail par
chaalu bhi kar dega.

---

# 🟢 HANDOFF — 24 Aug 2026 (shaam). AI Support Agent bana AUR migration lag gayi.

> Pichhla handoff (usi din, AI Sales Agent) neeche hai. **"Kya karna hai" lo, "kyun" par
> bharosa mat karo** — is file ke kaaran pehle bhi galat nikle hain, aur usi block ka
> "🟡 migration nahi lagayi" wala hissa apne hi upar wale hisse se takra raha tha.

### ✅ Migration prod par lag gayi (24 Aug), alag run me saabit bhi hui

`20260824180000_ai_support_agent.sql` **applied + tracked**. `db push` nahi chalaya — sirf apni
file `db query -f` se chalayi, phir `migration repair`. Verify ALAG run me (skill §2):
1 naya table · `support_tickets` par **9/9 naye column** · `support_tickets_tenant_id_key`
unique · composite FK **`ON DELETE SET NULL (ticket_id)`** (`confdelsetcols=[3]`, yaani
`tenant_id` list me NAHI — wahi bug jo bare form me hota hai) · channel check · RLS ON ·
2 policy · 4/4 index. `migration list --linked` ab phir se **drift 0**.

Backup pehle liya: `resellersos-data-2026-08-24T14-16-05-208Z.json` — 112 table / 1,434 row,
**nau key table live count se exactly match**. (Table count 110→112 badha kyunki pichhli
migration ne do table jode the — dump sikuda nahi.)

SQL test bhi likha aur chalaya: `supabase/tests/ai_support_agent_tenant_isolation.test.sql` —
6 test, rollback-style, prod par safe. **Do mutation chala kar dekha ki sach me kaatta hai**
(FK assertion palti → red; row count 2→3 → red). Mutation B ne saath me ye bhi saabit kiya ki
DELETE chala aur theek 2 row ka `ticket_id` null hua. Prod par koi residue nahi — tenants 3,
support_tickets 0, transcript 0.

### Kya bana (sab test-backed, poora gate green)

| Cheez | File |
|---|---|
| Schema — transcript, escalation, assignment, SLA clocks | `supabase/migrations/20260824180000_ai_support_agent.sql` |
| Reasoning (pure) — prompt, KB, guards, escalation rules | `src/lib/ai/support-agent.ts` · **59 test** |
| SLA faisle (pure) — auto-close, breach alert | `src/lib/ai/support-sla.ts` · **16 test** |
| Server side — customer/subscription lookup, thread, Gemini | `src/lib/ai/support-agent.server.ts` |
| Ek inbound message ka poora safar | `src/lib/ai/run-support-agent.ts` |
| Jawaab / resolve / escalate + desk alert | `src/lib/ai/actions/support-dispatcher.ts` |
| Email ingest | `src/app/api/v1/integrations/support-email-inbound/route.ts` |
| WhatsApp ingest | `src/app/api/v1/integrations/support-whatsapp-inbound/route.ts` |
| SLA cron (har 15 min) | `src/app/api/cron/ai-support-sla/route.ts` |
| Payload normaliser (pure) | `src/lib/inbound/support-inbound.ts` · **12 test** |

Gate: `typecheck` 0 · `test` **4,346 pass** (231 file) · `lint` 0 · `build` 0.

### 🔑 Chaar faisle jo tumhe pata hone chahiye

**1. Koi DNS record value code me nahi hai, aur ye jaan-boojh kar hai.** Galat MX record
customer ki poori mail band kar deta hai — hamare likhe instruction par, chup-chaap.
`verifyNoInventedRecords` kisi bhi draft ko rokta hai jo MX host, SPF include, DKIM/DMARC ya
port ka value likhta hai; KB sirf **raasta** batata hai ("Admin console → Domains → Activate
Gmail"). Bilkul `money-guard` ka shape. **Isme record ki list mat jodo** — wo doosra source ban
jayega ek value ka jo hamara nahi hai. Tenant apne verified value record kare, tab
`loadAuthorisedRecords()` se aayenge.

**2. `ai_support_tickets` table NAHI banayi, chahe brief ne maanga tha.** `support_tickets`
pehle se hai (SLA column, portal UI, `/api/support/tickets`, `inbound_emails.ticket_id`) aur
usme 0 row thi. Do ticket table ka matlab: dashboard ke count kam, aur "kitne ticket khule
hain" ke do jawaab. Isi tarah `escalated_to_human` naya **status** bhi nahi banaya — `status`
band vocabulary hai aur chhathi value waale ticket kisi filter tab me nahi dikhte. Escalation
ek column hai (`ai_escalated` + reason + time), status `open` rehta hai.

**3. Kuch bhi apne aap nahi jaayega jab tak dial nahi ghumate.** Naya `support.reply.send`
**`hold`** par hai. Agent jawaab likhta hai, ticket ke transcript par file karta hai, bhejta
kuch nahi. Pardeep `/automation` se ghumayega. **Par escalation alert aur SLA breach alert dial
se BAHAR hain** — wo hamare apne desk ko jaate hain, aur kill switch ko hamari apni ghanti band
karne ka haq nahi (wahi rule jisne `compliance.send` ko registry se hataya tha).

**4. Purana `support` branch badla gaya hai, joda nahi.** `api/webhooks/inbound-email` ka
support branch pehle khud ticket insert karta tha; ab `runSupportAgentForMessage` karta hai —
warna ek message par do ticket bante. Us function me do cheezein extra hain jo branch nahi kar
sakta tha: usi sender ka khula ticket **dobara use** hota hai (pehle teen reply = teen ticket),
aur 48 ghante ke andar resolved ticket **reopen** hota hai, jiska vaada resolution note customer
se karta hai.

### 💰 Demo se nikle teen paisa-defect — teeno theek, live saabit

Pardeep ne AI sales agent ka demo maanga. Chaar asli enquiry live webhook par bheji, aur usne
teen paisa-defect khol diye. Teeno wahi kism ke: **guard sahi jawaab par fire kar raha tha, ya
galat source se feed ho raha tha.**

**1. 12× unit mismatch.** `items.msrp` per MONTH hai (AGENTS.md §1) aur quote path hamesha
`msrp × 12` karta tha. `loadSalesCatalog` column ko seedha `msrpPerSeatPerYear` me daal deta
tha. Ek hi deal ke teen daam nikle:

| Kahan | ₹/seat/year | 12 seats |
|---|---|---|
| Agent ki email | 864 | 10,368 |
| Jis quote ka wo number de rahi thi | 1,500 | 21,240 |
| Sach | 10,368 | 1,24,416 |
| Hamari cost | 7,440 | 89,280 |

Do number cost se **neeche**, aur `verifyDraftMoney` ne **approve** kiya — kyunki uska
allow-list bhi usi galat figure se banta tha. Fix: `perSeatPerYear()`, `isBelowCost()` guard,
aur — asli baat — ek test jo **dono path ka number aapas me baandhta hai**. Sirf
`perSeatPerYear(864)===10368` bug wale din bhi pass hota.

**2. Bare generic word product ban gaya.** Customer ne "Google Workspace **Business** Standard"
likha; catalogue ka naam "Google Workspace Standard" tha (bina "Business"), to koi poora naam
match nahi hua aur 8-akshar ka hosting SKU **"Standard"** (₹125/month) jeet gaya. Fix:
whole-word matching + ek-shabd wala naam reject jab wo shabd doosre naamon me bhi ho. Refuse
karna ek manual quote ka kharcha hai; guess karne ne asli customer ko galat cheez ka galat daam
bheja.

**3. Agent quote ka TOTAL bol hi nahi sakta tha.** Unit fix hone ke baad agent ne sahi
₹1,24,416 nikala aur guard ne rok diya — total arithmetic hai, aur model par arithmetic ka
bharosa nahi. Sahi rule, par nateeja: quote ki covering email **kabhi** ja hi nahi sakti thi,
kyunki uska poora kaam amount batana hai. Fix: model ko arithmetic dena nahi — **app khud
total nikale** aur authorised fact ki tarah de. `authorisedTotalsFor()` seats × price nikalta
hai, aur caller live quote ka apna subtotal + amount jodta hai. Iske bahar ka koi figure aaj
bhi handover karata hai.

**Aur ek chauthi cheez jo rename ne roki.** `create-renewal-quote.ts` catalogue row ko **naam
se** dhoondhta tha (`items.name = subscriptions.plan`), jabki `plan` bikri ke waqt ki text
COPY hai. Wahi lookup `renewalTerm` ke us guard ko feed karta hai jisne **144× ka renewal**
pakda tha. Do item rename karne se wo guard Kriti Tech ki ACTIVE subscription ke liye **andha**
ho jaata — chup-chaap, 24 Aug 2027 tak. Ab wo `item_id` se resolve karta hai (jo row par pehle
se maujood tha), naam sirf fallback hai, aur teeno caller ise pass karte hain — ek test source
par ye teenon pin karta hai.

**Catalogue rename (prod):** `GW-STD-fbb` → "Google Workspace Business Standard",
`GW-PLS-fbb` → "Google Workspace Business Plus". `GW-STR-fbb` me "Business" pehle se tha —
yahi asangati defect 2 ki jad thi. 6 khule lead ka `plan` text backfill kiya. **Historical
document chhue nahi**: `quotes.plan` aur `subscriptions.plan` bikri ke waqt ki copy hain, aur
customer ko jo becha gaya usse badalna record me jhooth likhna hota.

**Aakhri verification, live:** wahi 12-seat enquiry dobara →
`Q-ADPL-2026-27-0058` · plan **Google Workspace Business Standard** · line rate **₹10,368** ·
line cost **₹7,440** (pehle 0) · subtotal **₹1,24,416** · GST ke saath **₹1,46,811**. Aur agent
ki email:

> Price per seat: **Rs 10,368 per year** · Total Amount: **Rs 1,24,416** (plus applicable GST)

Handover nahi hua — sirf dial ne roka. Email ka per-seat = quote ka line rate, email ka total =
quote ka subtotal. Ek hi deal, ek hi number.

**Jo abhi bhi khula hai:** `quote-builder.tsx` aur `add-lead-form.tsx` me ek hardcoded
plan→price map hai jo catalogue se **8 me se 8 line par** alag hai (Standard 736 vs 864,
M365 Standard 735 vs 990). Wo sirf **fallback** hai — tab chalta hai jab catalogue me match na
mile, aur us case me cost jaan-boojh kar 0 rehta hai — to wo asli daam ko override nahi karta.
Par wo ek doosra source hai, aur is file ka apna header kehta hai ki doosra source barabar nahi
rehta. Hataana baaki hai.


### 🟢 Usi din raat: handover ka queue, insaan ka edit capture, aur backup theek

**Handover ka queue bana.** Dono agent handover ka flag set karte the aur reason bhi likhte the —
aur **koi screen use padhta hi nahi tha** (`requires_human_attention` sirf follow-up cron me tha,
`ai_escalated` kahin nahi). Ab: leads par **"Waiting on you"** view (Mine ke baad, rose, sirf tab
jab kuch ho) aur card par poori **wajah**; support par **"AI → you"** badge aur detail panel me
poora reason. **Browser me khud dekha**, screenshot liye. Do asli lead + ek probe ticket sirf
photo ke liye flag kiye the, turant revert.

> Badge pehle **closed ticket par bhi** dikh raha tha — wahi galti jo subah `shouldAlertUnassigned`
> me thi (na wo, na uski query `status` dekhti thi). Screen dekhne se mila, test se nahi.

**Insaan ka edit capture** (`ai_draft_feedback`, migration lagi hui hai). Agent **self-learning
nahi karta** — outcome se kuch nahi seekhta, har naya lead zero se. Aaj ke nau prompt rule
maine uske asli draft padh kar likhe. Ab jab rep AI ka draft bhej-ta hai, jodi save hoti hai:
draft, jo gaya, aur verdict (`sent_unchanged` / `lightly_edited` / `rewritten`). Rewrites hi
padhne layak rows hain. **Ye training data NAHI hai** — koi weight nahi badalta; ye batata hai ki
agli baar prompt me kya theek karna hai.

**Backup toota hua tha aur theek ho gaya.** `npm run backup:db` do baar fail —
`exited 3221225794` (Windows 0xC0000142). Wajah tool nahi, **shape** thi: har table ke liye ek
`npx supabase` process, ~120 launch. Ab **3** launch (table list · ek `union all` · ek
`jsonb_build_object`). Do baar lagatar chala, aur dump ke counts **dason key table par live se
match**. AGENTS.md **L105**.

### 🔴 Do faisle KHULE hain — agli session inhi se shuru kare

**1. DEPLOY — aur ye aaj ka asli khatra hai.**
Aaj ke 8 commit **live par nahi** hain. Live par abhi bhi:
- galat-product wala quote bug (bare "Standard" → hosting SKU, ₹1,500/seat/year)
- `quote.send` dial **`auto`** par
- Gmail token ab **chalu** hai (24 Aug shaam reconnect hua, row DB me hai to Cloud Run bhi bhej sakta hai)

Yaani ek asli enquiry par galat daam wali quote **apne aap ja sakti hai**. **Deploy risk nahi,
risk hatana hai.** Raasta: `git push anutech HEAD:deploy` → Cloud Build → Cloud Run.
`main` se nahi.

**2. `isEmailConfigured()` galat sawaal poochta hai.**
```
isEmailConfigured() → Boolean(RESEND_API_KEY)      ← Resend ke baare me
sendAutoQuote       → route: { tenantId }           ← asli send GMAIL se
```
Quote apne aap jaaye ya nahi, ye gate **Resend** ki key dekhta hai — jabki bhejta **Gmail** se
hai. Pardeep ne 24 Aug ko bataya ki Resend **testing wala** use hoga; **usse ye surakshit nahi
hota** — test key bhi gate khol degi aur mail asli Gmail se asli customer ko jayegi. AGENTS.md
**L12** (naam jo sawaal poochta hai, field usi ka jawaab de). Aadha notice pehle bhi hua tha:
`api/cron/invoice-dunning/route.ts:243` par comment maujood hai.
Fix chhota hai: async helper jo *resolved route* dekhe, phir `autoQuoteForLead` me use + test.
**Paisa-adjacent hai — CLAUDE.md §0.4, Pardeep ki haan chahiye.**

### ❓ Ek sawaal jiska jawaab nahi mila (teen baar poochha)

**Cloud Run par `RESEND_API_KEY` set hai ya nahi?** Local par nahi hai (isliye probe me quote
nahi gayi). Cloud Run ka pata nahi — `gcloud` chala kar ya console → Service → Variables se
dekhna padega. Ye tay karta hai ki upar wala risk **aaj** khula hai ya nahi.

### Aur teen cheezein jo abhi bhi baaki hain

- **Webhook URL kisi provider par point nahi.** Naye support endpoint live hain par koi call
  nahi kar raha. Purana raasta chal raha hai aur wo bhi ab agent chalata hai.
- **Cloud Scheduler par SLA job banayi nahi** — entry `scripts/setup-cloud-scheduler.sh` me hai
  (`*/15 * * * *`), script chalayi nahi.
- **Dial abhi bhi `hold`** — `reply.send` aur `support.reply.send` dono. 20 draft padh kar hi
  ghumana. `/automation` par `Waiting` rows aur har lead ki timeline par poora draft hai.

---

### 🧪 Support agent bhi live probe kiya — teen defect nikle, teeno theek

Sales agent ki tarah support agent bhi sirf test-verified tha, kabhi asli message nahi dekha tha.
Char probe live webhook par bheji (`@example.invalid` se), **dono ingress path** aur SLA cron
dono. Machinery pehli baar me chal gayi — ticket bana, tier + `sla_due_at` trigger ne stamp
kiye, transcript likhi, escalation flag laga, desk alert bana, kuch bhi customer ko nahi gaya.
**Par teen defect nikle, aur teeno wahi kism ke the: guard sahi jawaab par fire kar raha tha.**

**1. Console URL ko DNS record samajh liya.** "Kaunse MX record chahiye" par agent ne theek wahi
kiya jo KB kehta hai — customer ko uske apne console par bheja — aur guard ne draft rok diya
kyunki usme `admin.google.com` tha. Wo console ka pata hai, **jawaab hai, galti nahi**. Hostname
pattern `google.com` ke neeche sab kuch pakadta tha. Fix: `CONSOLE_HOSTS` — sirf wo console jo
KB naam leta hai, plus do account page jo runbook ko chahiye (app password `myaccount` par
hota hai). `mail.google.com` aur `mail.zoho.com` **jaan-boojh kar list me nahi** — wahi jagah
hai jahan galat value nuksaan karti. 5 test, mutation se laal.

**2. Triage sirf bhejne par file hoti thi.** Ek DNS ticket jise agent ne `dns_records` padha
tha, Support screen par `category=other, priority=normal` — untriaged default — par baitha tha,
kyunki category/priority sirf successful-send path likhta tha. **Triage bhejna nahi hai.**
`hold` ka poora argument yahi hai ki kaam ho jaaye aur operator ka next step ek tap ho; galat
file kiya ticket wo aadha faayda kha jaata hai (screen category se filter aur priority se sort
karta hai). Fix: `triageFields()` held path par bhi likhi jaati hai — par status aur dono clock
NAHI, kyunki wo message customer tak pahunchne ke baare me hain.

**3. Band ho chuki escalation par alert hamesha aata rehta.** `shouldAlertUnassigned` aur uski
query dono `status` dekhte hi nahi the. Yaani rep ka aam tareeka — escalation ka jawaab de kar
band kar do, bina pehle apne naam kiye — us ticket ko **har sweep par** alert karata rehta.
Wahi failure jiske liye once-only stamp bana tha, doosre darwaze se. Fix: `closed`/`resolved`
par `already_handled`. Decision me bhi aur query me bhi — decision ko apne aap sahi hona chahiye.
3 test, mutation se laal. **Live saabit:** probe ticket band karne ke baad cron ka
`escalated_examined` 2 se **0** ho gaya.

**Jo pehli hi baar theek chala (live-verified):**

| Kya | Saboot |
|---|---|
| Dono ingress path | naya `/api/v1/integrations/support-email-inbound` aur purana `webhooks/inbound-email` ka support branch — dono ne ticket khola |
| Severity → priority | outage waali ticket `urgent`, DNS waali `low` |
| Outage handling | model ne khud `service_outage, CRITICAL` padha aur escalate kiya |
| SLA trigger chhua nahi gaya | dono ticket par `tier=free` aur `sla_due_at` stamped |
| Record guard ka asli kaam | draft me agent ne khud likha *"We do not provide generic MX record values directly, as exact records should always be taken from your own admin console"* |
| Cron ka auth | secret ke bina 401, galat secret par 401, sahi par 200 |
| `ran_on` IST se | `localDateISO` — 15:16 UTC par bhi `2026-08-24` |
| Alert ka fail-safe | Gmail token toota hua tha, to alert nahi gaya aur `sla_alert_sent_at` **stamp nahi hui** — do baar chalaya, dono baar retry kiya. Chup nahi hua. |

**Cleanup:** chaaron probe ticket `closed` + resolution_note. Open tickets **0**, live escalations
**0**, `emails_actually_sent` **0**, customers 14, quotes 20 — kuch nahi badla.

### 🔴 Aur usi shaam: AI SALES agent do jagah se practically band pada tha

Support agent ban jaane ke baad Pardeep ne poochha "sales agent chala kya". `ai_sales_conversations`
me **0 row** thi — yaani 24 Aug ko banne ke baad wo ek bhi asli message par chala hi nahi tha
(wajah maasoom: aakhri inbound mail 10:49 par aayi thi, agent ~12:00 par live hua). To live
webhook par ek probe enquiry bheji, `@example.invalid` address se. Usse do defect nikle, dono
ek hi khandaan ke — **guard sahi jawaab par fire kar raha tha.**

**Defect 1 — prompt jo authorise karta hai, guard usi ko rok raha tha.** Agent ne enquiry theek
padhi (confidence 0.95), achha reply likha, aur apne hi guard ne handover kar diya:

```
reply.send / held — 'The draft commits us to something nobody authorised —
it says "24/7"; "free". A promise in our name needs a person behind it.'
```

Dono cheezein `SALES_AGENT_SYSTEM_PROMPT` khud kehta hai ki keh sakte ho — *"24/7 support from a
named local team"* aur *"Free migration of existing mail and data"*. `24/7` ko `findPromises` ka
DATE branch `\d{1,2}[/-]\d{1,2}` "24 July" samajhta hai, aur bare `free` DISCOUNT branch me
girta hai. Matlab har wo reply handover hota jo company ke asli selling point use kare — yaani
lagbhag har pehla jawaab.

Fix: `maskAuthorisedSellingPoints()` in `sales-agent.ts` — sirf `24/7`/`24x7`, aur `free`
**sirf us sentence me jo migration ke baare me ho**. "First month is free" aur "migrate by
Friday" aaj bhi block hote hain. **7 test, do mutation se laal** (mask hataya → do
false-positive test red; mask chaura kiya → boundary test red).

**Defect 2 — aur ye zyada gehra tha: dial isse jeet hi nahi sakta.** Fix ke baad handover band
hua, par reply phir bhi ruki — is baar `auto-reply.ts:138` par, kyunki `decideAutoReply` poora
`findPromises` chalata hai jisme money check **khaali allow-list** ke saath hai. To `Rs 864` —
tenant ke apne catalogue ka daam — "promise" gina gaya.

Ye gate dispatcher se **pehle** hai: refuse hone par `run-sales-agent` draft file karke laut
jaata hai. **Iska matlab `reply.send` ko `auto` karne se bhi kuch nahi badalta tha** — daam
waali koi reply kabhi na jaati, aur sales agent ka kaam hi daam batana hai. Feature ka main
rasta band tha aur khula dikhta tha.

Fix: `AutoReplyInput.promisesAlreadyChecked` (default **false**, to purana acknowledgement path
bilkul waisa hi). Sirf `run-sales-agent.ts` ise pass karta hai, kyunki `applyHandoverRules`
pehle hi `verifyDraftMoney` **catalogue ke saath** dono surface par chala chuka hota hai — wo is
gate se sakht check hai. Baaki chhe condition (loop, koi intezaar nahi, do baar jawaab, insaan
laga hua hai, khaali draft, generic template) hamesha chalti hain. **4 test**, jinme ek SOURCE
par assert karta hai ki `run-auto-reply.ts` ye flag **nahi** pass karta — warna acknowledgement
path chup-chaap daam bolne ki ijazat pa lega. Do mutation se laal.

**Teesri probe ne live par saabit kiya ki ab chain poora chalta hai:**

| | Probe 1 | Probe 2 (defect 1 fix) | Probe 3 (dono fix) |
|---|---|---|---|
| Nateeja | `handed_over` | `held` (guard) | `held` (**dial**) |
| `requires_human_attention` | true | false | false |
| Draft dikhta hai | ❌ | ✅ | ✅ |
| Follow-up schedule hua | ❌ | ❌ | ✅ **24h**, "Customer has not replied with the required seat count" |
| Log ka reason | guard ka overrule | guard ka overrule | `no setting for this action, so its default "hold" applies` |

Aakhri row hi asli baat hai: ab **dial** rok raha hai, guard nahi. `/automation` se ghumate ho
to reply chali jayegi. Aur draft ne `Rs 864` quote kiya — live catalogue ka daam, spec ke ₹750
ka nahi — yaani "daam kabhi code me nahi" wala design live par saabit ho gaya.

**Kuch bhi bahar nahi gaya, teeno probe me:** `email_log` ki row `status=failed, provider=stub,
"not sent — default hold applies"` kehti hai. Teeno probe lead junk + `lost`, pending follow-up
cancel, live leads phir se 12, waiting-on-a-person 0. Transcript ki row jaan-boojh kar rakhi
hain — wahi saboot hai.

> ⚠️ **Sabak jo teeno defect me common hai:** `promise-check.ts` acknowledgement path ke liye
> likha gaya tha, jahan surakshit jawaab **kuch bhi** vaada nahi karta. Usi ko sales ya support
> reply par bina soche lagane se guard sahi jawaab par fire karta hai — aur phir koi guard hata
> deta hai. Naya path jodo to pehle ye poochho: *is path par kya kehna authorised hai, aur wo
> authorisation guard tak pahunch rahi hai ya nahi?*

### 🟡 Teen cheezein jo maine jaan-boojh kar NAHI ki

- **Webhook URL kisi provider par point nahi kiye.** Naye endpoint `/api/v1/integrations/support-email-inbound`
  aur `.../support-whatsapp-inbound` live hain par koi unhe call nahi kar raha. Forwarder/Meta
  config Pardeep ka kaam hai. Tab tak support mail purane raaste se aata hai — aur wo raasta bhi
  ab agent chalata hai, to feature dono taraf se zinda hai.
- **Cloud Scheduler par job banayi nahi.** `scripts/setup-cloud-scheduler.sh` me entry jodi hai
  (`*/15 * * * *`), par script chalayi nahi — wo prod infra badalta hai.
- **Push notification nahi joda.** `PushEvent` ek band union hai; escalation ka push jodna UI ka
  faisla hai. Abhi alert email se jaata hai aur ticket dashboard par urgent dikhta hai.

---

# 🟠 HANDOFF — 24 Aug 2026. AI Sales Agent bana AUR migration lag gayi.

> Pichhla handoff (22 Aug) neeche hai, wo abhi bhi padhne layak hai.

### ✅ Migration prod par lag gayi (24 Aug), aur saabit bhi ho gayi

`20260824120000_ai_sales_agent.sql` **applied + tracked**. Verify alag run me kiya
(AGENTS.md §5): 2 table · leads par 3 naye column · `leads_tenant_id_key` unique ·
2 composite FK · 5 policy · 6 index · RLS dono par ON.

**`supabase db push` MAT chalana — wo 5 file chalata, sirf 1 nahi.** Skill `resellersos-env`
§2 sahi hai. Maine `db query -f` se sirf apni file chalayi, phir `migration repair` se track
kiya. Push karte to `20260817100000` (GST data-repair) bhi chal jaati — wo idempotent to hai,
par uska chalna ek paisa-faisla hai, reflex nahi.

Backup pehle liya: `resellersos-data-2026-08-24T12-55-51-662Z.json` — 110 table / 1,432 row,
9 key table live count se exactly match (skill §5 ka check).

Naya SQL test bhi likha: `supabase/tests/ai_sales_agent_tenant_isolation.test.sql` — 5 test,
rollback-style, prod par safe. Do mutation chala kar dekha ki sach me kaatta hai.

### 💰 GST wali migration bhi lag gayi — Q-2026-9776 par ₹8,165 theek hua

Pardeep ne 24 Aug ko bola, tab lagayi. `20260817100000_fix_missing_gst_on_onboarded_quotes`
**applied + tracked**.

`Q-2026-9776` · **(a customer)** · tenant (client) (Client
A) · subtotal ₹45,360 · 18% · amount **₹45,360 → ₹53,525**.

Chalane se PEHLE dono UPDATE ka preview liya — statement 1 par 1 row, statement 2 par 0 row
(us quote ki koi subscription hai hi nahi). Chalane ke BAAD backup se poora diff kiya:
**20 me se 1 row badla, exactly +₹8,165, na koi row bani na gayi.**

Ab poore table me `quotes_not_gross = 0`.

> ⚠️ `Q-3BBD-2026-27-0001` par quote amount (55,885) aur outstanding (947) alag dikhte hain —
> **ye bug nahi hai.** Us par ₹54,938 aa chuka hai aur invoice bhi ban chuki hai, to
> 55,885 − 54,938 = 947 sahi hai. Migration ne use apne guards se sahi tarah chhoda.

### 🔴 Ek kaam BAAKI hai jo code nahi kar sakta

Q-2026-9776 ka status **accepted** hai. Customer ne **₹45,360 par haan** kaha tha, ab quote
**₹53,525** kehta hai. Data theek ho gaya, **rishta nahi**. Customer ko batana ya naya quote
bhejna Pardeep ka kaam hai — usse pehle invoice mat banao.

### ✅ Migration drift KHATAM — `db push` ab surakshit hai

24 Aug ko teen migration lagayi (`20260824120000`, `20260817100000`, `20260817210000`) aur do
jo pehle se lagi hui thin (`20260822200000`, `20260823140000`) unhe track kiya — **track karne
se pehle verify kiya ki wo sach me lagi hain**, naam par bharosa nahi kiya.

`npx supabase migration list --linked` ab **har local file par `local == remote`** dikhata hai.
Matlab `db push` ab **zero file** chalayega.

> **Skill `resellersos-env` §2 ab purana ho gaya.** Wo kehta hai "29 local migration remote
> tracking me nahi hain, push ~28 dobara chala dega". Wo 24 Aug se pehle sach tha. Ab drift 0
> hai. Skill update karna baaki hai — **par push karne se pehle `migration list` khud dekh lo**,
> doc ek hypothesis hai (CLAUDE.md §25.1).

`20260817210000_dunning_pre_due_comments` chalane se pehle verify kiya tha ki wo sach me
comments-only hai: sirf do `comment on column`, aur create/alter/drop/update/insert ka count
**0**. Header sach bol raha tha.

### Kya bana (sab test-backed, poora gate green)

| Cheez | File |
|---|---|
| Schema — transcript, loops, handover flag, composite FK | `supabase/migrations/20260824120000_ai_sales_agent.sql` |
| Reasoning (pure) — prompt, validation, handover rules | `src/lib/ai/sales-agent.ts` · **37 test** |
| Follow-up decisions (pure) — nudge karein ya na karein | `src/lib/ai/sales-loops.ts` · **13 test** |
| Server side — catalogue, thread, Gemini call | `src/lib/ai/sales-agent.server.ts` |
| Ek inbound message ka poora safar | `src/lib/ai/run-sales-agent.ts` |
| Reply / quote / handover bhejna | `src/lib/ai/actions/quote-dispatcher.ts` |
| Follow-up cron (ghante-ghante, 9–19 IST, Mon–Sat) | `src/app/api/cron/ai-sales-loop/route.ts` |

Gate: `typecheck` 0 · `test` **4,203 pass** (227 file) · `lint` 0 · `build` 0 (274 route).
Teen mutation chala kar dekha ki naye test sach me kaatte hain (seat ceiling, money guard,
confidence floor — teeno red hue).

### 🔑 Teen faisle jo tumhe pata hone chahiye

**1. Daam kabhi code me nahi likhe.** Spec me Workspace Standard **₹750** likha tha; live
catalogue me **₹864** hai (wholesale ₹620). Agent har baar `items.msrp` se padhta hai. Agar
₹750 hardcode kar deta to har Standard deal **₹114/seat/year** kam quote hoti aur pakadne wala
koi nahi tha — `money-check.yml` isi wajah se bana tha.

**2. Kuch bhi apne aap nahi jaayega jab tak tum dial nahi ghumate.** `followup.send` `off` se
**`hold`** hua (feature ban gaya, to `off` jhooth ho gaya — wahi jo 23 Aug ko `reply.send` ke
saath hua tha). `reply.send` pehle se `hold` hai. Matlab abhi agent draft banata hai, lead ki
timeline par likhta hai, **bhejta kuch nahi**. Tum `/automation` se ghumaoge.

**3. `runAutoReply` ab koi nahi bulata.** Dono webhook branch ab sales agent bulate hain — ye
**badla gaya hai, joda nahi**: do drafter ek webhook par matlab ek customer ko do reply. Purani
file `src/lib/ai/run-auto-reply.ts` (aur `draft-reply.server.ts`) **19 Oct 2026 ko R-1606 me
hata di** — uske tests (`human-touch.test.ts`, `auto-reply.test.ts`) ab `run-sales-agent.ts` ko
jaanchte hain, jo asli me chalta hai.

### 🟡 Do cheezein jo maine jaan-boojh kar NAHI ki

- ~~**Migration prod par nahi lagayi**~~ — **ye line galat thi aur 24 Aug shaam ko hataayi
  gayi.** Isi block ka pehla hissa kehta hai "migration applied + tracked, verify alag run me
  kiya", aur wo sach hai (ledger me `20260824120000` maujood, `leads` par teeno column
  maujood — dobara naapa 24 Aug shaam). Ye bullet drafting ke waqt ka bacha hua tha aur do
  session ko ulta samajh me daal chuka tha. **Sabak: ek block ke andar bhi dono hisse ek
  doosre se check karo.**
- **39 SQL test nahi chalaye** — unke header me likha hai "dev/test DB par chalao, prod par
  nahi", aur mera connection prod par hai. Wo layer meri taraf se **unverified** hai.
  (Naye support test `ai_support_agent_tenant_isolation` is se alag hai — wo rollback-style
  likha hai, prod par chalaya gaya, aur do mutation se saabit hai.)

---

# 🔵 HANDOFF — 22 Aug 2026 raat. Naya session yahi se shuru karo.

> **Is block se "kya karna hai" lo. "Kyun" par bharosa mat karo** — 19 Aug ko is file ke
> teen me se teen kaaran galat nikle the aur ek me ₹8,165 chhupa tha. Har wajah dobara naapo.

**Branch:** `session/money-spine-hardening-jun1` · deploy **`anutech/deploy`** se hota hai,
`main` se NAHI (`cloudbuild.yaml` ka trigger wahi branch dekhta hai; session branch main se
166 commit aage hai).

### ✅ Deploy ka bakaya khatam — live ab HEAD par hai

ROAD-TO-TEN §5 step 1 ho gaya. Us doc ka **kaaran purana nikla**: usne likha tha ki 21–22 Aug
ka UI live par nahi hai, par live revision ka image tag pehle se `8f043d1` tha. `gcloud` ka
auth bhi chal raha hai — 21 Aug ka "expired" note laagu nahi hota.

Raasta: `git push anutech HEAD:deploy` → Cloud Build trigger → Cloud Run.

### 🔧 Aaj ke teen fix (self-healing loop se) — teeno naape hue

| Commit | Kya theek hua | Saboot |
|---|---|---|
| `79996f9` | Nightly backup transient failure par retry karta hai | 18 test · mutation se 8 red · **live par sweep chalaya: 3 tenants, 1,093,631 bytes** |
| `8b8d6c7` | Advance ki visibility naam ke substring se tay nahi hoti | 20 test · mutation se 5 red |
| (teesra) | WhatsApp ka config error 502 nahi, 409 hai | 7 test · mutation se 3 red |

**Backup ka asli nuksaan:** `backup.snapshots` me automated rows 17, 18, 19, 20 aur 22 Aug ki
hain — **21 Aug ki ek bhi nahi**. Us raat `JWT issued at future` aaya, kisi ne retry nahi kiya,
kisi ko bataya nahi gaya. Chhe me se ek raat, free plan par jahan PITR nahi hai.

**Advance ka bug latent tha, live leak nahi:** poore DB me ek hi advance row hai (`Darshan`,
₹2,000). 10 asli user par purana aur naya filter trace kiya — dono ka jawab same. Jo hataya wo
source me likha hua standing grant tha, jo doosre bande ka advance aate hi phat jata.

### 🟡 Do cheezein naapi gayin aur jaan-boojh kar theek NAHI ki gayin

- **`SENTRY_DSN` Cloud Run par set nahi hai.** Teen sentry config file hain, production me init
  hote hi nahi — yaani error tracking **band** hai. Aaj ke teeno bug Cloud Run ke raw logs se
  mile, Sentry se nahi. Ek env var ka kaam hai, par production env badalna faisla hai:
  `gcloud run services update --update-env-vars` use karna, **`--set-env-vars` kabhi nahi** —
  wo service ke saare gyarah var mita deta hai (`cloudbuild.yaml` me wahi likha hai).
- **`expenses` me employee ka koi link column nahi hai** — isi liye "ye advance kiska hai" naam
  se tay hota hai, aur ek hi first name wale do employee alag nahi kiye ja sakte. Asli fix ek id
  column hai: migration + faisla. Tab tak module header me stopgap likha hua hai.

### 🧪 Tester ke reports — chaar naape, teen band, ek baaki

Loop ne `feedback` table bhi scan kiya. **Teeno "fix" pehle se ho chuke the** — koi naya code
nahi likha, sirf saboot dhoonda aur `resolution_note` me darj kiya:

| Report | Asli haal |
|---|---|
| "Paid hone k bd bhi subscription nhi bna" (`Q-TEST-2026-27-0009`) | ✅ band — us quote par ab 1 payment, 1 subscription (`c398e832`), 1 invoice. `85a5d67`+`069617e`+`da19166` ne theek kiya |
| "Yaha domain automatically fill nhi hua" | ✅ band — `bb8cdec` (`lib/quotes/payment-domain.ts`), live revision ka ancestor, 6 test pass |
| "NOT JENERATED INVIOCE" (17 Aug) | ✅ band — **reporter sahi tha**: 17 Aug ko accepted+paid quote par koi money action hi nahi tha. Agle din `0df1e03` ne theek kiya |
| "Payment record kar di lekin subscription nhi bna" (`/subscriptions`, 08:04) | ⏳ **DB me theek hai, par row band nahi hui** — classifier ne wo ek UPDATE rok diya. Saboot: poore DB ke 51 quotes me ek bhi paid quote bina subscription nahi (control: 5 paid, 5 me subscription). Bas `feedback` row par `status='fixed'` + note lagana baaki hai |

### 💰 5 paid quotes par invoice baaki — ₹6,88,827 (code ka kaam NAHI)

Live ANUTECH tenant me 36 accepted+paid quotes hain, 5 par invoice nahi. **Ye bug nahi hai** —
`record_payment` jaan-boojh kar invoice nahi banata; wo ek button hai. Aur wo surface **pehle se
maujood hai aur achha hai**: `/invoices` par "pending generation" card, CGST §13(2)/Rule 47 ke
aging bucket (fresh/warn/urgent/overdue), total, checkbox aur bulk generate.

**Aging naap li — koi deadline paar nahi hui:** sabse purana 5 din ka (`Q-ADPL-2026-27-0002`,
₹4,39,994, first advance 17 Aug), baaki 0–1 din. 30-din ki limit se bahut andar.

Pardeep ka faisla (22 Aug): **invoice automatic nahi banegi** — sirf dikhegi, aur banana insaan
tay karega. Isliye koi code change nahi kiya. Button dabana baaki hai, 30 din ke andar.

### 🔴🔴 `create_project_direct_invoice` kabhi chala hi nahi — poora feature mara pada hai

**Naapa hua:** function `RETURNS TABLE(invoice_id text, project_id uuid)` hai, to body ke andar
`project_id` ek PL/pgSQL variable ban jata hai. Ye line plan hi nahi ho sakti:

```
select id into v_msid from public.project_milestones where project_id = v_pid order by seq limit 1;
ERROR 42702: column reference "project_id" is ambiguous
```

Yaani **har call fail hoti hai** — aur `create_project_quote` + `accept_project_quote` chal
jaane ke baad, to poora kaam roll back hota hai aur user ko aisi error milti hai jo na project
ka naam leti hai na milestone ka.

**Saboot ki ye kabhi chala nahi:** `project_sales` **0 rows**, `project_milestones` **0 rows** —
jabki UI isse migration 0160 se juda hua hai (`create-project-quote-dialog.tsx:46` →
`useCreateProjectDirectInvoice()`). Mahino se ek poora feature UI me maujood aur mara pada.

**Kisi ko pata kyun nahi chala:** wahi ek test jo is raaste ko chhoota hai, khud band pada tha
(deleted customer id), aur us se pehle wo assert kuch bhi nahi karta tha. Test theek karte hi
pehle run me bug saamne aa gaya.

**Fix likh di, apply nahi ki** —
[20260822200000_fix_project_direct_invoice_ambiguous_column.sql](production/supabase/migrations/20260822200000_fix_project_direct_invoice_ambiguous_column.sql).
Sirf ek line badli hai (`pm` alias). **Ye surakshit hai** — jo function aaj hamesha throw karta
hai wo chalne layak ho jata hai, aur migrate karne ko koi data hi nahi hai kyunki iske through
kuch bana hi nahi. Due-date wale se alag: **isme koi business faisla nahi hai.**

```
cd production
node scripts/apply-migration.mjs supabase/migrations/20260822200000_fix_project_direct_invoice_ambiguous_column.sql
```

### 🔴🔴 Har invoice usi din due ho jati hai, aur ek asli customer chase hua

**Naapa hua:** `generate_invoice` due date aise banata hai —
`v_today + coalesce(v_quote.payment_terms_days, 0)`. Fallback **0** hai, **30** nahi. Migration
0163 net-30 kehta hai aur test bhi wahi assert karta hai (par wo test CI me nahi hai).

**Nateeja:** 53 quotes me `payment_terms_days` null hai, aur **DB ki saari 41 invoices me
`due_date = invoice_date` hai.** Yaani is business ki har invoice bante hi due thi.

**Aur isse ek asli customer chase hua:** `INV-3BBD-2026-27-0002` — CLIENT B PROJECTS
PRIVATE LIMITED, ₹55,885, 18 Aug ko bani. `invoice_dunning_log` me 19 Aug par "reminder"
(`days_overdue = 1`) aur 21 Aug par "retry" (`days_overdue = 3`).

**Migration likh di hai, apply NAHI ki** —
[20260822190000_invoice_due_date_net30_fallback.sql](production/supabase/migrations/20260822190000_invoice_due_date_net30_fallback.sql).
Body live function se `pg_get_functiondef` se li gayi hai aur **theek ek expression** badla hai
(0 → 30); haath se dobara likhna wahi galti hoti jisse `record_payment` ke teen guard gaye.
Apply karna aapka faisla hai kyunki ye tay karta hai ki customer ko kitne din milte hain:

```
cd production
node scripts/apply-migration.mjs supabase/migrations/20260822190000_invoice_due_date_net30_fallback.sql
```

### ✅ Aur usi khoj me ek doosra bug — jo maine theek kar diya

`invoice_dunning_log` ki wo do rows `status = 'sent'` kehti hain, par **koi email nahi gayi** —
us customer ka `contact_email` null hai aur route sirf address hone par bhejta hai. Status
`isEmailConfigured() ? 'sent' : 'stubbed'` se aata tha, yaani "Resend set up hai kya" ka jawab
"customer tak pahuncha kya" ki jagah likha ja raha tha.

Ye zyada khatarnak hai kyunki **galat value tasalli deti hai**: reseller padhta hai "do baar
yaad dilaya, phir bhi paisa nahi aaya" aur samajhta hai customer taal raha hai. Ladder bhi aage
badh jata hai, to invoice "customer ko poora reminder sequence mil gaya" wale escalation ki taraf
badhti hai — ek aise bande ke baare me jise kabhi kuch nahi bheja gaya.

Fix: [dunning-log-status.ts](production/src/lib/invoices/dunning-log-status.ts) — pehle recipient
dekhta hai, phir provider; naya status `no_recipient`; aur cron ke response me `no_recipient`
counter, taaki jis raat kisi tak kuch na pahuncha wo raat normal na dikhe. **9 test, mutation se
5 red.** AGENTS.md **L12**.

> Ek sudhaar jo maine session me kiya: pehle maine kaha tha "do dunning email sach me bheji
> gayi". Wo galat tha — log ne wahi jhooth bola tha jo ab theek hua hai. Code padhne par pata
> chala ki kuch nahi bheja gaya.

### 🔴 Sandbox tenant ka naam badal gaya hai — ab "Client C"

Naapa hua, 22 Aug: tenant `7e57e57e-0000-4000-8000-000000000001` ka `name` ab
**`Client C`** hai. Ye wahi tenant hai jo jaan-boojh kar
`ZZ TESTING SANDBOX — not a real company` naam se banaya gaya tha, aur wajah is file me hi
likhi hai: *"company jaisa naam wala tenant company jaisa hi padha jata hai"* — usi galti ne
ek "Client A" tenant me do din ka asli kaam aur ₹21,240 ka payment chhupa rakha tha.

Ab wo bachaav **hat gaya hai**. Sirf `doc_code = 'TEST'` bacha hai jo batata hai ki ye asli
nahi hai — aur `doc_code` kisi report ya screen par nahi dikhta. Isi tenant me ₹32,400 MRR aur
24 Aug ka asli renewal email baitha hai (upar #2), to ise asli customer samajh lena aasan hai.

Maine naam **wapas nahi badla** — ho sakta hai tester ne jaan-boojh kar likha ho, aur ye live
tenant ka data hai. Faisla Pardeep ka: naam wapas bhadda karna hai ya nahi.

### 🧪 SQL suite ka FINAL state — 38 me se 32 PASS, 6 FAIL

Suite pehli baar poori chalayi, phir theek ki, phir dobara chalayi. **Ab har failure ek naam
wale defect par jaati hai — koi mystery nahi bachi:**

| Failing test | Defect | Kiska faisla |
|---|---|---|
| `zero_amount_guards` | #27 guard `record_payment` me nahi hai | migration + money → Pardeep |
| `customer_dedup` | 0064/0065 email-dedup nahi hai | migration + money → Pardeep |
| `record_payment_one_off_guard` | 0157 one-off guard nahi hai | migration + money → Pardeep |
| `create_direct_invoice_recurring` | **wahi** 0157 defect, doosra swatantra saboot | ↑ |
| `generate_invoice_payment_terms` | due-date fallback 0 hai, 30 chahiye | migration likhi hai · **business faisla** |
| `create_project_direct_invoice` | ambiguous `project_id` — kabhi chala hi nahi | migration likhi hai · **koi faisla nahi, surakshit** |

**6 failure = 5 defect** (0157 do test se pakda gaya). Ek bhi failure aaj ke code ne nahi todi.

**Kya badla (sab mutation se sabit):** saat file jo live tenant ke asli books me chalti thin,
dobara likhi gayin — apna tenant, apna customer, asli assertion, aur end me dikhne wala
`select 'PASS'`. Do "test-side" failures (`credit_card_liability`,
`portal_customer_users_no_self_update`) bhi theek — dono ab poore run me pass hain.

**🔴 Aur usme sabse badi baat:** `portal_customer_users_no_self_update` **green tha aur kuch
bhi sabit nahi kar raha tha**. Wo `set role authenticated` ke **baad** id padhta tha, RLS use
NULL kar deta tha, aur exploit wala UPDATE `where auth_user_id = NULL` ban jata tha — zero rows,
policy se koi lena-dena nahi. Ek cross-customer escalation test, hara, khokhla. Ab teen setup
guard hain (auth.uid() milta hai · user ko apni 1 row dikhti hai · phir exploit), aur purana
order wapas daalne par test **pass hone se inkaar** karta hai. AGENTS.md **L14**.

### 🧪 Pehli baar chalane par kya mila tha (record ke liye)

`production/supabase/tests/` **na CI me hai, na Stop hook me** — to yahan ke claim chup-chaap
purane pad jate hain. Aaj chalayi (pehli baar poori). Teen theek kar diye, teeno
**mutation se sabit**:

| Test | Kya tha | Ab |
|---|---|---|
| `sandbox_tenant_isolation` | "sandbox tester 8 live customers padh sakta hai" — **jhoothi alarm**: assertion bina tenant filter `count(*)` kar raha tha aur tester ke apne 8 rows ko doosre ka bata raha tha | ✅ PASS. Sab counts `tenant_id <> v_sandbox` par scoped. Mutation: tester ko live tenant me daala → `can read 26 customer(s) belonging to another tenant` |
| `hierarchy_peer_isolation` | **Aaj pehli baar chala** (header khud kehta tha "NOT YET RUN"). Asli auth id "borrow" karta tha; ek id tester ki thi → `users_pkey` duplicate, ek bhi assertion chala hi nahi | ✅ PASS. Ab apne synthetic auth users banata hai (sibling test ka idiom). Mutation: role switch hataya → `expected own + unowned, got [A,B,NULL]`. **Migration `20260818150000` Section 3b pehli baar sabit hua** |
| `renewal_and_subscription_creation` | "monthly-flex sale creates NO subscription" — aaj ke `85a5d67` ne wo jaan-boojh kar badla, test stale tha | ✅ PASS. Naapa: `n=1, term=1, mrr=3900, renewal=start+1 month`. Mutation: 3900→325 → red |

**Poori suite ka final aankda: 38 me se 27 PASS, 11 FAIL.** Gyarah do tarah ke hain:

**(a) 6 fixture-toote** — `accrue_referral_commission`, `create_direct_invoice`,
`create_direct_invoice_recurring`, `create_project_direct_invoice`,
`generate_invoice_payment_terms`, `record_payment_billing_cycle_decouple`,
`record_payment_one_off_guard`. Sab `Customer not found` ya FK violation (23503) par girti
hain — apni pehli assertion tak pahunchti hi nahi. Ye purane seed data par likhi thin jo ab DB
me nahi hai. Inka code se koi lena-dena nahi.

**(b) 4 asli assertion failures.** Ek ka poora diagnosis ho gaya:

**🔴 `zero_amount_guards` — bug #27 ka guard function me MAUJOOD NAHI hai.**
Test kehta hai ki ₹0 quote par payment reject hona chahiye (migration 0060/0061). Naapa:
`record_payment` me guard hai par **galat cheez par** — line 92 `p_amount <= 0` yaani *payment*
ka amount check karta hai, *quote* ka total (`v_quote.amount`) kahin check nahi hota. To ₹0
quote par ₹5,000 ka payment aaram se chala jata hai. Function 26,000 char ka hai aur kaafi baar
dobara likha gaya — guard usi me kho gaya lagta hai.

**Nuksaan abhi ZERO hai, aur ye bhi naapa hua:** DB me ₹0 amount ka **ek bhi quote nahi** (0
rows), ₹0 ka koi payment nahi. To ye khatra hai, ghatna nahi.

**Maine test ko "theek" nahi kiya, jaan-boojh kar.** Use reality se match karana ek money guard
ko chupchaap retire kar dena hota. Red rehna hi sach hai. Guard wapas laane ke liye
`record_payment` badalna padega = migration + money-code faisla → Pardeep ka call.

**Ek aur cheez jo isi khoj me nikli aur bug NAHI hai** (taaki agla session isse na chase kare):
ek active subscription ka `mrr = 0` hai — `6fb7a892`, "AB corprotion", Standard Support
(Yearly), quote `Q-ADPL-2026-27-0003`. Wajah sahi hai: us quote ki support line par
`rate: 0, list_rate: 9996` — support **muft diya gaya** hai, aur `list_rate` discount dikhane
ke liye bacha hua hai. ₹0 line ka MRR 0 hi hona chahiye.

**Baaki 3 ka bhi triage ho gaya — 11 me se ek bhi ab "pata nahi" nahi hai:**

**🔴 `customer_dedup` — DOOSRA guard bhi `record_payment` me nahi bacha.** Test kehta hai (0064/
0065) ki same-email customer pehle se ho to reuse karo, duplicate na banao. Function me
(line ~188) lead se **bina koi lookup** naya customer insert hota hai — `contact_email` par
koi `select` hi nahi hai. Naapa: nuksaan abhi zero (12 emailed customers, 12 distinct). Par ek
alag kinara bhi mila: **35 me se 23 customers ka email hi nahi hai**, to email-wala dedup
do-tihai par kabhi kaam hi nahi karta tha. Ye bhi migration + money faisla = Pardeep ka call.

**🟢 `credit_card_liability` — test-side, product theek hai.** `bank=0` ka matlab "₹5,000 galat
kat gaya" nahi, "koi row mili hi nahi" hai. `bank_account_current_balance` SECURITY DEFINER aur
`current_tenant_id()` se scoped hai, aur test sirf `{"role":"service_role"}` set karta hai —
koi `sub` nahi, to koi tenant nahi. Test ka message hi gumraah karta hai.

**🟢 `portal_customer_users_no_self_update` — test-side, aur iski security assertions PASS hui.**
Exploit ne 0 row update kiye aur `customer_id` nahi badla — deewar khadi hai. Sirf
`portal_touch_login()` ne `last_login_at` stamp nahi kiya, kyunki wo `auth.uid()` par chalta hai
jo us session me set nahi hai.

**11 failures ka final hisaab:** 7 fixture-toote (purana seed data) · 2 test-context (tenant/
identity set nahi) · **2 asli gayab guard** (`record_payment` me #27 aur 0064/0065). Yaani
**ek bhi failure aisi nahi jo aaj ke code ne todi ho.**

**Ek trap jo darj karna zaroori hai** (AGENTS.md L7 me poora hai): is folder me **do
convention** hain. 31 file `rollback;` par khatam hoti hain aur pass par exit 0 deti hain. Baaki
**7 file `raise exception 'TESTRESULT >> …'`** par khatam hoti hain — wahi exception unka
rollback hai, to wo **pass hone par non-zero exit** deti hain. Naadaan runner un 7 ko "broken"
batayega, aur koi unka `raise` hata kar "theek" karega to unka test data **prod me commit ho
jayega**.

### 📓 AGENTS.md me naya section

`# Learned Guidelines` — **L1–L43**, aaj ke kaam se nikle niyam: har cron par retry/alert ·
pehle classify phir retry · jo retry jaan-boojh kar mana kiya · naam ke substring se
authorization mat karo · ek `as any` poore insert ka checking band kar deta hai · config error
5xx nahi hota · aur **L7**: isolation ka zero-assertion doosre tenant par scoped hona chahiye,
warna security test jhooth bolne lagta hai · aur **L8**: jis guard ka test koi nahi chalata, wo guard ab aapke paas nahi hai · **L9**: `record_payment` do guard kho chuka hai, migration ke bharose mat raho, live function body grep karo · **L10**: tenant-scoped function 0 de to pehle missing context par shak karo, logic par baad me. Naya session ise padh kar shuru kare.

### Purana record (17–22 Aug) — neeche waisa hi hai

### Aaj kya hua (sab naapa hua, commit ke saath)

| | |
|---|---|
| `069617e` | Monthly subscriptions renew hote hain — ladder ab `term_months` se chunti hai, `billing_cycle` se nahi |
| `8f043d1` | Split-billing cron schedule hua (`subscription_billings` me 0 row thi — kabhi chala hi nahi tha) |
| `da19166` | Rebuild path MRR ka dasva hissa deta tha; ab `lib/subscriptions/rebuild-term.ts` me ek jagah, 10 test |

**Backfill ho chuka:** `Q-TEST-2026-27-0009` → subscription `c398e832`, MRR ₹32,400, term 1,
renewal 2026-08-27. Verify alag run me kiya gaya.

### Khule faisle — ye Pardeep ke hain, khud mat kar dena

1. **`Q-TEST-2026-27-0008` (ITBUZZ, ₹2,54,361) ka backfill Pardeep ne mana kiya** — "test data hai".
   Chhedna mat jab tak wo dobara na kahein.
> ### 🔴 SUDHAAR (22 Aug raat): ye email **23 Aug subah 09:00 IST** ko jayega, 24 ko nahi.
>
> Neeche "24 Aug" likha hai. Wo annual ladder ke T-3 par maana gaya tha. Par ye subscription
> **monthly** hai (`term_months = 1`) aur monthly ladder ki pehli rung **T-7** hai
> (`MONTHLY_CADENCE_TRIGGERS` — T-7 · T-3 · T-0). Renewal 27 Aug hai, to T-7 already paar ho
> chuki hai, aur cadence "jo rung paar ho chuki" me se aakhri leti hai.
>
> Ab tak kuch gaya nahi (`reminder_count 0`, `renewal_state pending`, `renewal_email_log` 0)
> **sirf isliye** ki subscription aaj 16:16 IST par bani — aaj 09:00 ka cron use dekh hi nahi
> paya. Agla run kal 09:00 IST hai aur wahi `notice_sent` bhej dega.
>
> Rokna ho to: `update subscriptions set auto_renew = false where id = 'c398e832-0b58-4d78-a5b7-a2fdd1871fc9';`
>
> **Aur ye ek email ka mamla nahi hai.** Usi sandbox tenant (`Client C`) me `auto_renew`
> wali paanch aur subscriptions asli lagne wale email par baithi hain —
> `itadmin@clientj.com` (CLIENT J PVT LTD, ×3), `user4@clientk.co.in`
> (DCM NOUVELLE SPECIALTY CHEMICALS), `ceo@prop.guide` (NS PROPERTY GUIDE ADVISORS),
> `printer.test@yahoo.com` (a printer shop). Ye `example.com` jaise nakli address
> nahi hain. Unki renewal 2027 ki hai, to jaldi nahi — par ek test tenant me live Resend key
> ke saath khade hain. Memory me yahi darj hai: *test tenant se asli email jata hai.*

2. **~~24 Aug~~ 23 Aug 09:00 IST ko `ankit@xyz.com` ko asli renewal email jayega** — `RESEND_API_KEY`
   Cloud Run par live hai aur renewals cron seedha Resend use karta hai. Rokna ho to us ek
   subscription ka `auto_renew` band karna kaafi hai. Pardeep ne abhi tak faisla nahi diya.
   **22 Aug raat ko DB se dobara confirm kiya — ab bhi armed hai:** subscription `c398e832`,
   `auto_renew = true`, renewal `2026-08-27`, `reminder_count = 0`. Aur ek baat jo pehle darj
   nahi thi: iska `tenant_id` **`7e57e57e-…0001` hai, yaani ZZ TESTING SANDBOX** — nakli data,
   par Resend key asli. 22 Aug ka deploy is behaviour ko **nahi** badalta (`send-now` sirf
   manual button hai; nightly cron ke paas `term_months` pehle se tha).
3. **`INBOUND_EMAIL_SECRET` transcript me poora chhap gaya** (22 Aug). Rotate karna hai ya
   nahi — Pardeep ka faisla.
4. **Backup sweep ko per-night idempotent banana** (ek migration). Ye scheduler par
   `--max-retry-attempts` lagane ka **enabler** hai, jo maine jaan-boojh kar nahi lagaya:
   `/api/cron/backup` partial failure par bhi 500 deta hai aur Cloud Scheduler dono me farak
   nahi kar sakta — to bahar ka retry un tenants ke duplicate snapshot likhta jinka ban chuka
   hai, aur `backup._take` sirf 30 rakhta hai, yaani asli purane restore point shelf se gir
   jaate. Poori wajah AGENTS.md **L3** me darj hai.

### Goal ka doc

[docs/ROAD-TO-TEN.md](docs/ROAD-TO-TEN.md) — 22 Aug ko live DB par naap kar likha. §1 me wo
teen cheezein darj hain jo maine yaad se galat batayi thi aur code ne mana kar diya.

Monthly 10/10 ke liye jo baaki hai: quarterly/half-yearly cadence, monthly renewal ka email
template, aur ek asli monthly cycle apni aankh se chalta hua dekhna.

---

### ⌨️ Tooltip me keyboard shortcut (21 Aug 2026) — ✅ DONE, local par verify

`<TooltipContent shortcut="report-bug">` — sirf **id** deni hai, keys `SHORTCUTS` se aati hain. Prop ka type registry se nikalta hai, to **galat id compile hi nahi hoti** (`"report-bugg"` par tsc ne khud sahi naam suggest kiya). Commit `e06401f`.

**Do shortcut mile jo bane hue the par kahin darj nahi the** — jabki `shortcuts.ts` ki pehli line kehti hai "every keyboard shortcut in the app, in one place": `Ctrl+Shift+B` (sirf `global-bug-reporter.tsx` me) aur workspace tab keys (`Alt+1–8`, `Ctrl+Alt+←/→`, `Ctrl+Alt+W`). Dono cheat sheet me nahi the, yaani kisi ko pata nahi tha. Ab registry me hain, aur bug-reporter ka handler keys **registry se padhta hai** (`matchesShortcut`).

**`Ctrl+Tab` / `Ctrl+W` jaan-boojh kar nahi daale** — provider khud kehta hai browser inhe rakh leta hai. Cheat sheet me likhna matlab aisa waada jo chalta nahi, aur ek jhoothi line poori list ka bharosa tod deti hai.

**Ulti galti bhi theek ki:** `quote-builder` me `title="Add item (Alt+A)"` haath se likha tha; ab `shortcutText("add-quote-item")` se aata hai.

**Dono galtiyan aage se band:** test ab **saari `.tsx` scan karta hai** — `title=` ya tooltip ke andar keys likhi ho to red (wahi tareeka jo `route-map.test.ts` ka hai). Dono mutation se sabit, aur scan khud assert karta hai ki 100+ file mili — warna wo "kuch scan na karke" green ho sakta tha.

> **Ek seekh likh rakhi hai:** registry `as const` karne se `keys` bhi literal tuple ban gaya aur har purana `keys.includes(str)` toot gaya. Har call site par cast lagana matlab **ek type-safety ka faayda barah chhote chhed** me badalna — to const tuple andar rakha, `SHORTCUTS` widened export kiya.

### ✅ ~~gcloud ka auth EXPIRE ho chuka hai~~ — 22 Aug ko khatam, ab trigger se deploy hota hai

> **PURANA. Neeche ka sab 21 Aug ka hai aur ab laagu nahi hota.** 22 Aug ko Cloud Build
> GitHub trigger lag gaya (`cloudbuild.yaml`, repo root). Deploy ab `git push anutech
> HEAD:deploy` hai — na `gcloud auth login`, na `deploy.sh`, na koi key jo expire ho.
> Purana text neeche isliye chhoda hai ki 21 Aug ka record na toote.

<details><summary>21 Aug ka purana note</summary>

### gcloud ka auth EXPIRE ho chuka hai — deploy se pehle isko theek karna padega

21 Aug: `gcloud run services describe` ne `Reauthentication failed. cannot prompt during non-interactive execution` diya. Yaani **main deploy nahi kar sakta** jab tak ye theek na ho, aur live revision bhi query nahi kar sakta (isliye "live par kaun sa build hai" ye TASKS.md ke 19 Aug ke record se maana ja raha hai, naapa hua nahi).

Theek karne ka rasta (Pardeep ko ek baar chalana padega, browser khulega):

```
gcloud auth login
```

Account pehle se do hain, active `pardeep@anutech.in` (doosra `Pardeep@example.test` — purana). Deploy script `production/deploy.sh` hai.

</details>

**Ye ab zyada maayne rakhta hai** kyunki tester chalu ho gaya hai: aaj ke chaar guard (invoice ka GST guard dono raaste, tooltip shortcut) live par nahi hain — tester ke liye wo cheezein maujood hi nahi hain.

### 🧪 TESTING KE LIYE TAIYAARI — 21 Aug 2026 (Pardeep ke teen faisle par kaam hua)

Sawaal tha *"app testing ke liye perfect hai kya"*. Jawab naap kar: **nahi thi, ab kaafi behtar hai** — teen cheezein ho gayin, ek baaki hai.

**🔴 Pehle ek sudhaar jo poore doc par asar daalta hai.** Kal tak jo aankde "live tenant" ke naam se likhe gaye (15 customers · 27 quotes · 22 invoices · 24 payments · 30 subscriptions) wo **poore DB ke** the, ek tenant ke nahi. Asli per-tenant ginti:

| | ANUTECH (live) | Client A | ZZ TESTING SANDBOX |
|---|---|---|---|
| items | 25 | 21 | **25** |
| customers | 14 | 1 | 0 |
| quotes | 25 | 2 | 0 |
| invoices | **21** | 1 | 0 |
| payments | **23** | 1 | 0 |
| subscriptions | 28 | 2 | 0 |
| leads | 19 | 0 | 0 |

Ye galti khud ek assertion ne pakdi — `create-test-tenant.sql` ka pehla run `FAIL: live tenant now has 21 invoices, expected 22` par ruk gaya, kyunki maine **global aankda per-tenant guard me** likh diya tha. Wahi purani `counts-must-add-up` wali galti, par is baar commit hone se pehle pakdi gayi.

**1. ✅ Ek self-inconsistent quote se ab invoice nahi ban sakti.** `Q-2026-9776` me subtotal ₹45,360 par 18% GST hai par `amount` bhi ₹45,360 — **₹8,165 GST gayab** (migration `20260817100000` kabhi chali nahi). Quote **accepted** hai, aur `generate_invoice` wahi amount GST document par chipka deta — jo baad me badla nahi ja sakta. Public payment route customer se **kam paisa** le leta.

Dono raaste ab mana karte hain, `grossAmount()` se (wahi helper jisme ye ganit pehle se hai), ₹1 ki rounding chhoot ke saath. **Naapa pehle, guard baad me: 27 me se 26 quotes exact match hain**, to ye sirf tooti row rokta hai, kisi asli kaam ko nahi. 4 test, jisme wahi ₹8,165 ka gap aur dono tolerance kinare. Message §24 ke hisaab se — kya/kyun/aage kya; customer wale message me reseller ka ganit nahi khola gaya.

> **Ye wo business faisla nahi leta** — ₹45,360 GST-sahit tha ya nahi, wo ab bhi Pardeep ka call hai. Ye sirf itna karta hai ki wo faisla **galti se** na ho jaye.

**2. ✅ `0231` aur `0232` lag gayin** — jo `migrations-archive/` me padi thin jahan se koi command inhe chalati hi nahi. Dono **sirf jodti hain**: 3 table (`task_collaborators`, `task_comments`, `task_kudos`), 7 column (`tasks.delegated_by`, `salary_payments.performance_points`, `expenses.channel`, `leads.utm_source/medium/campaign`, `leads.gclid`), 8 index, 10 policy, teeno par RLS. **Alag run me verify** (§25.6), phir `migration repair` se ledger me darj — **279 → 281**. Repair ka yahi sahi istemaal hai: object pehle sabit, phir ledger.

Ab wo screens *"migration missing"* nahi, **khaali** dikhayengi — jo alag baat hai aur sahi hai: 19 me se 0 lead par UTM tag hai, aur 1 Marketing expense (₹4,000 Facebook) untagged hai. CAC/ROAS dekhna ho to us expense par channel tag karna padega.

**3. ✅ Testing sandbox tenant ban gaya** — `ZZ TESTING SANDBOX — not a real company` (`7e57e57e-0000-4000-8000-000000000001`, doc_code `TEST`). Usme **sirf item catalogue** hai (25 rows live tenant se copy, naye id `TST-` prefix ke saath). Customers/quotes/invoices/payments **jaan-boojh kar nahi** — money spine banana hi wo cheez hai jo test honi chahiye; banaya hua data dekar wo poora hissa skip ho jata aur banane me chhupe bug bhi.

Naam jaan-boojh kar bhadda hai. §4a ka sabak: company jaisa naam wala tenant company jaisa hi padha jata hai — aur usi galti ne ek "Client A" tenant me do din ka asli kaam aur ₹21,240 ka payment chhupa rakha tha. Script deewar ko **maanti nahi, assert karti hai**: sandbox me 0 customer/quote/invoice/payment, aur copy ke baad live tenant bilkul waisa hi. [create-test-tenant.sql](production/supabase/maintenance/create-test-tenant.sql)

**⏳ 4. Jo baaki hai — tester ka email.** `team_invites` me us tester ka **theek wahi address** daalna hai (columns: `tenant_id`, `email`, `role`). Callback ki pehli branch invited address ko **usi tenant** me daalti hai — isliye Google sign-in sandbox me girega, live tenant me **nahi ja sakta**. Password kisi ko dene ki zaroorat nahi.

**✅ 4a. Invite lag gaya — par `pratik@anutech.in` par NAHI, aur wajah maayne rakhti hai.** Pratik ka `public.users` row live tenant me **12 Aug se** hai. Callback ka pehla check `if (existing) return redirect(next)` hai — jiska users row pehle se hai, uske liye invite wali branch tak pahuncha hi nahi jaata; aur ek doosri branch purane profile ko naye auth UID se **wapas jod** deti hai. Us address par invite ek **no-op** hota jo fix jaisa dikhta. **Yahan ek email = ek tenant hai.**

Invite gaya: **`testing@anutech.in`** (teeno jagah khaali tha), role `owner`, sandbox par pinned. [add-test-tenant-invite.sql](production/supabase/maintenance/add-test-tenant-invite.sql)

Do baatein isko chalati hain: **`anutech.in` live tenant ka verified domain hai**, to bina invite koi bhi @anutech.in signup live tenant par jaakar `join_requests` me park hota — invite usko override karta hai, aur ye design hai ([domain.ts:129](production/src/lib/auth/domain.ts:129): *"an invite is a decision someone already made"*). Aur `/api/auth/signup` me `email_confirm: true` hai, to **us address par mailbox hone ki zaroorat nahi**, na koi password share karna padta.

**~~⏳ Signup baaki hai~~ ✅ ho gaya** (Pratik office me nahi tha). Uske liye teen step: `/signup` → email `testing@anutech.in` → naam + apna password. Company ka naam kuch bhi — invite ki wajah se naya tenant banega hi nahi.

**✅ 4c. SIGNUP HO GAYA aur asli login par isolation naap liya (21 Aug, 08:23 IST).** `testing@anutech.in` → naam "tester", role `owner`, tenant **ZZ TESTING SANDBOX**. `team_invites.accepted_at` usi pal stamp hua — yaani use wahan **invite ne** rakha, sanyog se nahi.

**Sabse saaf saboot: tenants ab bhi 3 hain.** Koi naya tenant nahi bana — yaani invite ne `anutech.in` ke verified-domain raste ko sach me override kiya (warna signup live tenant par jaakar `join_requests` me park hota).

Us **asli session** ki seat par baith kar ginwaya (synthetic user par nahi): leads · customers · quotes · invoices · payments · subscriptions · expenses · vault · live teammates — **sab 0**. Control case bhi pass: usi session ko sandbox ke apne **25 items** dikhte hain, to zero "session tooti hai" ki wajah se nahi hain. 10 check + control, ek bhi skip nahi (`checked <> 10` par vacuous-guard).

**Live tenant chhua nahi gaya:** 10 users · 19 leads · 14 customers · 21 invoices · 23 payments — signup se pehle jaisa tha waisa hi.

**Ab tester kaam shuru kar sakta hai.** Sandbox me 25 items hain aur baaki sab khaali — lead → quote → pay → invoice → renewal khud banana hi test hai. Screen par "Report Bug" button hai (Ctrl+Shift+B bhi), aur uski report seedha `/admin/feedback` me triage ho kar aati hai.

**✅ 4b. Deewar ab sabit hai, Pratik ke signup ka intezaar kiye bina.** [sandbox_tenant_isolation.test.sql](production/supabase/tests/sandbox_tenant_isolation.test.sql) — live prod par chalaya, **5 me se 5 PASS**, poora transaction rollback me. Synthetic sandbox owner banaya, uski seat par baith kar RLS se ginwaya: live tenant ke **0 customers · 0 quotes · 0 invoices · 0 payments · 0 subscriptions · 0 leads · 0 expenses · 0 teammate rows**. Deewar dono taraf hai — live owner ko sandbox ke 25 items aur uska user **nahi** dikhte.

**Case 2 filler nahi hai, wahi is file ki jaan hai.** Case 1 ka har aankda 0 hai — aur 0 wahi hai jo ek tooti session bhi deti hai. Isliye usi session se wo cheezein padhi jaati hain jo **dikhni chahiye** (sandbox ke 25 items, apne tenant ka 1 user). Iske bina file kuch sabit nahi karti.

**Do cheezein likhte waqt hi pakdi gayin:**
- Case 3 ka insert pehle `customers.email` par tha — wo column hai hi nahi (`contact_email` hai). Insert missing column se fail hua, aur assertion ne use **RLS block maanne se inkaar** kar diya. *"Insert nahi hua"* wala test muft me pass ho jaata hai agar insert kabhi valid hi na tha.
- Asli block **RLS se nahi, document-numbering trigger se** aata hai (`Cannot allocate a customer number for another tenant`) — wo RLS se pehle bol deta hai. Do aazaad deewarein, aur bahar wali ka message behtar hai. Ab assertion dono maanti hai, par **sirf** ye do — "koi bhi error" maanna hi upar wali typo ko security-pass bana raha tha.

**Aur ye red bhi hota hai — mutation se sabit:** tester ko live tenant me daala → `FAIL 1: can read 14 customer(s) of the live business` · session hi bina-tenant kar di → `FAIL 2: sees NO items at all — the zeros above prove nothing`. Aaj green ka matlab do baar kuch nahi nikla, to teesri baar bina tod kar dekhe nahi maana.

**Aur do baatein tester ko batani chahiye:**
- **Live app 19 Aug ka build hai.** HEAD us se aage hai, par app code me sirf vault ki error-screen wali file badli hai. Deploy hone tak tester ko vault ki purani error screen milegi.
- **Vault ka PIN bhool gaye to reset ka rasta nahi hai** — DB se hataana padta hai. Tester ko bata do, ya wo screen abhi chhod de.

**Backup:** aaj ka le liya — **102 tables / 974 rows**, exit 0 (19 Aug: 96/933). Free plan par PITR nahi hai, isliye testing shuru hone se pehle ek aur le lena samajhdari hai.

### 🔐 Owner Private Vault (`/vault/personal`) — ✅ DONE (19 Aug 2026, DB applied · **deployed** rev `resellersos-00297-728` · isolation **re-proven on live DB 20 Aug, 8/8**)

**Do cheezein goal se alag ki gayi hain, dono jaan-boojh kar:**

**1. `/vault` par nahi bana — `/vault/personal` par bana.** `/vault` pehle se ek chalta hua feature hai: customer console ka Password Vault, jisme encryption, access log aur reveal API hai, aur **manager ko bhi chahiye**. Use replace karna ek live feature mitana hota; use owner-only karna manager ko customer passwords se kaat deta. Isliye private vault uske neeche baitha hai, aur dono ka na table prefix milta hai na policy. Table prefix bhi `vault_*` nahi hai (wo password vault ka hai) — `personal_*` hai.

**2. 🔴 RLS `tenant_id` par nahi, `auth.uid()` par hai — aur yahi is poore feature ki jaan hai.** Goal ka hard rule #3 kehta hai "har query me tenant_id + current_tenant_id() RLS". Baaki har table ke liye wo sahi hai. **Yahan wahi rule, akela, ek data breach hai.** Naapa hua: ANUTECH tenant me **teen** log `role = 'owner'` hain — Pardeep, Deepak, aur `info@clientd.example`. Tenant-scoped ya role-scoped policy ek owner ka bank balance, ghar ka kharcha aur net worth baaki do ko de deti.

> Teeno account sahi hain — Client D wala ANUTECH ka apna Workspace console id hai (Pardeep ne 19 Aug ko confirm kiya). **Phir bhi kuch nahi badalta**, aur wajah likhna zaroori hai: khatra kabhi ye tha hi nahi ki koi ajnabi ho. Pardeep aur Deepak dono asli director hain, dono ko company ka poora data dekhna chahiye — aur **kisi ko doosre ka bank balance nahi**. "Personal" ka matlab ek insaan hai, ek company nahi. Upar se shared console address wo account hai jisme ek se zyada log login kar sakte hain.

**Isliye policy hai `tenant_id = current_tenant_id() and owner_user_id = auth.uid()`** — tenant wala bahari daayra hai, `auth.uid()` wala asli kaam karta hai. Kisi bhi policy me `role` ka zikr nahi hai: role doosra owner badal sakta hai, aur "owner hona" aur "yahi insaan hona" do alag baatein hain.

**Suraksha sabit ki gayi hai, maani nahi:** [personal_vault_owner_isolation.test.sql](production/supabase/tests/personal_vault_owner_isolation.test.sql) — **live prod DB par chalaya, 8 me se 8 PASS**, poora transaction rollback me. Case 2 hi asli hai: *ek doosra owner, usi tenant me, usi role ke saath, ZERO rows dekhta hai.* Baaki: staff zero dekhta hai · owner B, owner A ke vault me row daal nahi sakta (RLS error) · A ki holding badal nahi sakta · A ka account delete nahi kar sakta · A ka PIN hash overwrite nahi kar sakta · aur A apna kaam kar sakta hai (over-block nahi hua). Write wale case "0 rows affected" par pass nahi hote — wapas owner A banke value **padh kar** milaya jaata hai, warna galat id se bhi test pass ho jaata.

**PIN ke baare me saaf baat, aur wo UI par bhi likhi hai.** Ye **screen ka lock hai, encryption nahi**. Kis se bachata hai: khula laptop, kandhe se dekhta banda, screen share. Kis se nahi: koi bhi technical banda jiske paas live session hai — wo PostgREST se seedha padh sakta hai. Ye khaayi mehnat se band nahi hoti: 4 digit = 10,000 possibilities, uske neeche encrypt karna jhoothi tasalli hai, aur PIN bhool jaane par data hamesha ke liye chala jaata. **Isliye asli suraksha RLS hai, aur PIN ko utna hi bataya gaya hai jitna wo hai.** Phir bhi wo *bura* lock na ho: server-side salted scrypt hash (browser tak kabhi nahi jaata), timing-safe compare, 5 galat koshish par 15 minute lockout (counter lock lagne par reset **nahi** hota, warna har 15 minute me 5 nayi koshish milti rehti), aur 1234/0000/1212 jaise PIN mana hain.

**🔴 Ek asli bug jo sirf app chalane se mila:** `pin.ts` `node:crypto` import karta tha aur client components usse `PIN_LENGTH` le rahe the — webpack ne poora `/vault/personal` route **500** kar diya (`UnhandledSchemeError`). **Typecheck, lint aur 3150 tests — teeno green the.** Ye theek wahi cheez hai jiske liye CLAUDE.md §25.2 build ko gate me rakhta hai. Fix: [pin-rules.ts](production/src/lib/vault/personal/pin-rules.ts) (crypto-free, client-safe) aur [pin.ts](production/src/lib/vault/personal/pin.ts) (server-only) me baant diya.

**Chaar screen:** Overview (net worth + is FY ka cash flow + allocation) · Banking (savings/current/card/FD/RD/PPF/cash/wallet) · Drawings & Expenses · Wealth (MF, stock, property, gold/SGB, LIC, PPF, EPF, NPS…).

**Teen design faisle jo test me locked hain:**
- **Credit card ka balance positive store hota hai aur ghataya jaata hai.** Ulta karte to sign convention har form aur report ko yaad rakhna padta, aur pehli bhoolne wali jagah ₹80,000 ka karza ₹80,000 ki jaayedaad bana deti — ₹1.6L ki galti, galat taraf.
- **Har value haath se likhi hai — koi market feed nahi.** Isliye `valued_on` hi is screen ki poori imaandari hai: purani ya bina date wali value kitne rupaye ki hai, wo total ke **bagal me** likha jaata hai. March ka aankda aaj ka bata dena bina aankde se bura hai, kyunki uspar faisla hota hai.
- **Yahan drawing likhne se company ki books me kuch nahi hota** — ek tarfa deewar, aur screen par likhi hui. Warna ek aadmi ki yaaddasht chup-chaap company ke accounts badal deti, bina bank line, bina approval.

**Browser me sach me verify hua:** account add kiya → DB me `owner_user_id = pardeep@anutech.in`, 420000 whole rupees · PIN route ka poora chakkar (weak PIN 400, galat format 400, set 200, galat verify 401 "4 koshish baaki", sahi verify 200) · DB me PIN nahi, 64-char hash + 32-char salt, `leaks_pin: false` · lock screen aaya, unlock hua · **net worth ₹9,80,000 = 4,20,000 + 6,40,000 − 80,000** (card ghata), allocation 100% MF, gain +₹1,40,000 (+28.0%), Indian formatting sahi. **Saara test data aur PIN baad me hata diya** — vault ab bilkul khali hai (0/0/0/0).

**Gate:** typecheck 0 · **162 files / 3150 tests** (3088 → +62) · lint 0 errors, vault files me 0 warnings · **`npm run build` exit 0** — chaaron vault route bane. Migration `20260819170000` prod par lagi + alag run me verify (4 tables, 4 policies, chaaron me `auth.uid()`), ledger **278 → 279**. `db push` nahi chalayi.

**Baad me jodi gayi verification (19 Aug, session ke aakhir me — DB ka darwaza band ho jaane ke baad):**

- **19 naye screen tests** ([vault-screens.test.tsx](<production/src/app/(app)/vault/personal/vault-screens.test.tsx>)) — chaaron screens ko asli jaisi rows dekar assert kiya jaata hai. Sabse zaroori: card ka ₹80,000 **ghataya** jaata hai (₹7,70,000 aata hai, ₹9,30,000 nahi). Saath me: band account total se bahar, kharche rupaye se rank hote hain count se nahi, income spending bucket me nahi girti, null valuation par staleness warning total ke bagal me. Suite 3150 → **3169**. Ye browser me ek baar dekhne ki jagah nahi leta — ye us dekhne ko **dobara chalne wala** bana deta hai.
- **Live anon probe (curl, prod PostgREST, public anon key se):** chaaron `personal_*` tables → **401, zero rows**, message `permission denied for function current_tenant_id`. Do baatein isse sabit hoti hain: (a) **tables prod me maujood hain** — error `42P01 relation does not exist` nahi hai, yaani migration lagi hui hai; (b) **bina login koi kuch nahi padh sakta**. Ye wahi message hai jo vault screen par "session khatam ho gaya" banta hai — poora chakkar milta hai.

> **✅ 20 Aug 2026: ye kami band ho gayi — `personal_vault_owner_isolation.test.sql` live prod DB par dobara chala, 8/8 PASS.** Pichhle handoff ka andaza ("DB ka raasta band ho gaya") is session me galat nikla: **dono darwaze khule the** — CLI ne `SUPABASE_DB_PASSWORD` maanga hi nahi (`env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked`, exit 0), aur MCP `supabase-db` bhi authorized tha (read-only). Rasta: `cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked -f supabase/tests/personal_vault_owner_isolation.test.sql` → ek row `PASS`. **Wo ek row hi 8/8 ka saboot hai:** har case fail hone par `raise exception` karta hai, jo poora transaction abort kar deta hai — to aakhri `select 'PASS'` fail hone par dikh hi nahi sakta. Yaani **Case 2 phir sabit hai**: usi tenant ka doosra owner, usi `role = 'owner'` ke saath, chaaron `personal_*` tables me **zero rows** dekhta hai — saath me staff zero, aur B ka insert/update/delete/PIN-overwrite chaaron blocked, aur A apna kaam kar sakta hai. **Rollback alag connection se verify kiya:** synthetic tenant 0, synthetic users 0 (`auth.users` me bhi 0), asli ginti waisi hi — 2 tenants / 11 users, vault 0/0/0/0. **Sabak:** "DB ka raasta band hai" ek andaza hai, haalat nahi — naye session me pehle `env -u` wala probe chalao, tabhi maano.

**Baaki:** company ke drawings se link nahi hai (jaan-boojh kar — ek tarfa deewar) · koi market feed nahi · PIN bhool jaane par reset ka rasta nahi hai (abhi seedha DB se hataana padega).

### ⏰ Attendance check-in / check-out reminder — ✅ BUILT (19 Aug 2026, DB applied · **awaiting deploy**)

**Pehla kaam jo naye triage system ke directive se hua.** Report: *"Kuch Aisa kar do ki Computer ko open karte hi user ko attendance ka popup mil jaye … iske saath hi 6 baje (ya time set karne ka option) ek Check Out Popup Reminder hona chahiye."* Triage ne ise `feature` (filed as bug), sev 35, screen `/attendance/me` bataya — sab sahi nikla.

**Report sach me valid thi, aur saboot screen par hi tha:** `/attendance/me` ke "Recent record" me Pardeep ke **teen me se teen** din — 18 Aug, 12 Aug, 10 Aug — sab par *"check-out reh gaya"*. Jo problem report hui thi wo har record kiye gaye din ho rahi thi.

**Popup punch nahi karta, sirf bhejta hai.** Asli check-in selfie, DPDP consent, rotating presence code aur face match maang sakta hai (tenant setting par). Dialog me "Check in" button daalne ka matlab hota ya wo saara logic dobara likhna (doosra check-in path jo pehle se drift karega), ya use chupke se bypass karna — yaani ghar baithe attendance lagane ka rasta. Isliye dialog samjhata hai aur `/attendance/me` par le jaata hai; guards ek hi jagah rehte hain.

**Faisle jo test me lock hain** ([reminders.ts](production/src/lib/attendance/reminders.ts), 28 tests):
- **Sab kuch IST me.** `my_attendance_today` "aaj" Asia/Kolkata me decide karta hai, to client bhi wahi kare. Browser ka local midnight use karte to doosre timezone wala laptop us din ka check-in maangta jo DB band kar chuka hai — aur ye "reminder toota hai" jaisa dikhta, ek ghante ki galti jaisa nahi.
- **Padha na ja sakne wala time = koi popup nahi.** `00:00` par fallback karte to aadhi raat ko popup aata aur sab ise ignore karna seekh jaate.
- **Din khatam hone ke baad check-in ka nag band.** 19:00 baje "aapne check-in nahi kiya" nudge nahi, taana hai.
- **Check-in ka dismiss check-out ko chup nahi karata** — dono alag nudge hain; subah wala band karne se shaam wala kho jaana theek wahi punch khota jiske liye ye feature hai.
- **Snooze us din ka hai.** 23:50 ka snooze agli subah 00:05 par bhi dabaye rakhta, agar din se na bandha jaata.

**Setting `users` par hai, `employees` par nahi** — reminder us insaan ki cheez hai jo browser par baitha hai, aur wo `users` row hai. Bina login wale employee ko popup se pahuncha hi nahi ja sakta. Dismiss/snooze **localStorage** me (per-device scratch, expire hona chahiye), par **time DB me** — reporter ne "time set karne ka option" maanga hai, aur phone par kholne par reset ho jaane wali setting tooti hui lagti hai. Default 18:00 reporter ka apna suggestion hai; poore schema me koi shift/office-hours column hai hi nahi (check kiya), to virasat me lene ko kuch tha nahi.

**Ek lint warning ne behtar code diya:** pehle memo ki dependency me ek bump-counter tha taaki localStorage badalne par dobara chale. Chalta tha, par dependency jhooth bol rahi thi — `exhaustive-deps` isi ke liye hai. Ab dismissal state khud React me hai, dependency asli hai.

**Verify:** settings card browser me render hua aur save round-trip **prod DB tak** gaya (`19:45:00` likha, phir 18:00 par reset kiya) — RLS + `users_privileged_columns_guard` dono ke through. Popup khud browser me **nahi** dekha ja saka: us waqt 02:39 IST tha, jo 06:00 window se pehle hai, to sahi behaviour kuch na dikhana tha — aur wo suppression live verify hui. Render ke liye 12 component tests hain (jsdom, ghadi 10:00 aur 18:30 IST par freeze karke), kyunki subah ka intezaar test nahi hota.

**Gate:** typecheck 0 · **160 files / 3088 tests** (3048 → +40) · lint 0 errors. Migration `20260819150000` prod par lagi + alag run me verify, ledger **277 → 278**.

**Report jaan-boojh kar `open` chhodi hai** `/admin/feedback` me — code ban gaya, par live 18 Aug ka revision hai, to Hitesh ke liye abhi kuch nahi badla. "Fixed" mark karna use ye batana hota ki ho gaya jabki wo use kar hi nahi sakta.

### 🤖 Feedback Triage & Agent Directive Engine (`/admin/feedback`) — ✅ DONE (19 Aug 2026, DB applied + browser-verified end-to-end)

**Ye pehle se aadha bana hua tha, aur jo bana tha usme ek chup-chaap data-loss bug tha.** `feedback-dialog.tsx` + `global-bug-reporter.tsx` (Ctrl+Shift+B) already existed. Par:

```ts
const { error } = await supabase.from("support_tickets").insert({...});
if (error) console.warn("… saving to local feedback store:", error);   // koi local store nahi tha
toast.success("Thank you! Your testing report … have been submitted.");
```

Insert fail hone par report **gayab** ho jaati thi aur reporter ko "thank you" mil jaata tha. Feedback box ki sabse buri kharabi yahi hai: banda maan leta hai ki problem ab pata hai, isliye dobara kabhi nahi bolta, aur koi dekh bhi nahi raha. **Ab har write throw karti hai**, dialog khula rehta hai aur likha hua text bacha rehta hai.

**Naapa hua, likhne se pehle:** `support_tickets` me **4 rows hain aur chaaron internal bug report hain** — ek bhi asli customer ticket kabhi aaya hi nahi. Yaani SLA clock (`20260817170000`) aur tier allowance (`20260817180000`) galat cheez gin rahe the. Sabse bada body **214,531 characters** ka tha — ek PNG, base64 me, text column ke andar.

**Chaar asli report ne design decide kiya (inhi ko test fixture banaya gaya hai):**

| # | Report | Kya sikhaya |
|---|---|---|
| 1 | `NOT JENERATED INVIOCE` · /quotes/Q-ADPL-2026-27-0002 | Typo-heavy. "INVIOCE" ke bina koi target file nahi milti — observed misspellings alias list me hain, fuzzy matcher nahi (chhote domain words par fuzzy confident bakwaas deta hai). |
| 2 | `Camera is not opening. There is no error where the problem is.` | Ek line me **do** kharabi — camera, aur khamoshi. Dono alag file par jaati hain. |
| 3 | `Allow the user to see his attendance History with Selfies.` | Filed as **bug**, hai **feature**. |
| 4 | `Kuch Aisa kar do ki … popup mil jaye jisse wo attendance miss na kare …` | Poora Hinglish, aur sabse lamba/detailed report. English-only lexicon isko "no signal" bata kar dafan kar deta. |

**Teen niyam jo isi data se nikle:**
1. **Reporter ka dropdown saboot nahi hai.** Chaaron "bug" file hue, do sach me feature the. `inferred_type` **text** padhta hai; `reported_type` bagal me rehta hai aur dono ka farak khud ek information hai (UI par "filed as bug" chip).
2. **Khamoshi faisla nahi hai.** Text me kuch na mile to reporter ki choice hi rehti hai — report #1 exactly yahi case hai.
3. **Hinglish first-class hai**, guess nahi. Har lexicon me dono hain.

**Severity 0–100, aur cap hi asli baat hai.** `feature` cap 35, `ui_improvement` cap 30, bug 0–100. Invariant jo test lock karta hai: **sabse kamzor money bug (low + money = 37) sabse strong feature request (35) se upar rehta hai.** Warna koi bhi "Critical" tick karke apni farmaish ko galat invoice total ke upar bitha sakta tha. Gemini ko **score badalne ki ijazat nahi hai** — sirf summary aur extra file leads; type badalne par engine **dobara** chalta hai taaki cap phir bhi lagey.

**Prompt injection — ye feature isi ka natural target hai.** Report ka text ek agent ke prompt me jaata hai. Isliye: fence tag text me se **strip** hota hai (andar se band nahi kar sakte, lowercase copy bhi), directive khud kehti hai ki block symptom hai instruction nahi, aur instruction-jaisi wording `notes` me ⚠ ke saath dikhti hai. Teeno tested.

**🔴 Ek asli bug jo live run me hi pakda gaya:** pehle AI ke suggest kiye file paths seedha `target_files` me merge ho rahe the. Asli run me Gemini ne `src/components/attendance/ReminderPopup.tsx` aur `src/lib/attendance/client-reminders.ts` diye — **dono repo me hain hi nahi**, ye sirf "agar feature banta to naam ye hota" hai. `plausibleRepoPath` sirf shape dekhta hai, existence nahi. Ab AI ke guesses `notes` me quarantine hote hain ("NOT verified to exist"), `target_files` me nahi — kyunki `triage.test.ts` har emitted path ka disk par hona assert karta hai, aur merge chup-chaap wahi invariant tod raha tha.

**Live nateeja (prod DB, Gemini se, browser me click karke):**

| Sev | Type | Summary (Gemini ne likha) | Screen |
|---|---|---|---|
| **57** | bug | An invoice was not generated from a quote. | `/quotes/[id]` |
| **47** | bug | The camera fails to open …, and no error message is displayed to the user. | `/attendance/me` |
| 35 | feature *(filed as bug)* | …attendance popup reminder … and a configurable check-out popup reminder | `/attendance/me` |
| 35 | feature *(filed as bug)* | Users cannot view their attendance history along with associated selfies. | `/attendance/me` |

**⚠️ "Run AI Auto-Fix" jo karta hai, poora yahi hai:** directive banata hai, clipboard par copy karta hai, aur row ko `agent_queued` + kisne/kab stamp karta hai. **Code khud nahi badalta** — ye app Cloud Run par hai, uske paas repo ka checkout, git credentials ya shell kuch nahi. Screen par bhi yahi likha hai, kyunki "queued" ko owner "ban raha hai" samajh le to wo chase karna band kar dega. Asli value directive me hai (sahi files + repo ke niyam + gate), button aakhri 5% hai.

**Files:** [triage.ts](production/src/lib/feedback/triage.ts) · [directive.ts](production/src/lib/feedback/directive.ts) · [route-map.ts](production/src/lib/feedback/route-map.ts) · [queries/feedback.ts](production/src/lib/queries/feedback.ts) · [api/feedback/triage](production/src/app/api/feedback/triage/route.ts) · [admin/feedback/page.tsx](<production/src/app/(app)/admin/feedback/page.tsx>) · migrations [20260819120000](production/supabase/migrations/20260819120000_feedback_triage.sql) + [20260819130000](production/supabase/migrations/20260819130000_backfill_feedback_from_tickets.sql).

**`route-map.ts` khud stale nahi ho sakta:** 118 routes ka committed table hai (client se fs padha nahi ja sakta), par `route-map.test.ts` `src/app` ko **khud scan karke** compare karta hai — nayi page add karke ye file bhoolna suite red kar dega. Is repo ne stale directory-listing ki keemat pehle bhi di hai. Matcher literal segment ko dynamic se upar rakhta hai (`/customers/groups` ≠ `/customers/[id]`), aur na milne par **null** deta hai — galat file par bhejna khali jawab se mehnga hai.

**DB:** dono migration prod par lagi + alag run me verify (2 tables, 6 policies, 4 indexes, RLS on), ledger **276 → 277**. `db push` **nahi** chalayi. Chaaron report backfill ho gayi (body 214,531 → max 295 chars); **`support_tickets` ko haath nahi lagaya** — copy hai, move nahi, kyunki ticket band karna Pardeep ka faisla hai. Screenshots purani ticket rows me hi hain (base64 ko SQL se storage me nahi bheja ja sakta) — naye screenshots `documents` bucket me `<tenant_id>/feedback/<id>/` par jaate hain, **naya bucket nahi banaya** (usi bucket ki chaar tenant policies pehle se sahi hain).

**Gate:** typecheck 0 · **158 files / 3048 tests pass** (2926 → +122) · lint 0 errors, naye files me 0 warnings. **`npm run build` jaan-boojh kar nahi chalayi** — port 3000 par doosre session ka dev server chal raha hai aur build uska `.next` uda deta. **Deploy se pehle build chalani baaki hai** (§25.2: typedRoutes ki galtiyan sirf build pakadta hai).

**Baaki:** `/admin/feedback` par screenshot re-attach karne ka rasta nahi hai · duplicate detection nahi hai (do log ek hi bug file karein to do rows) · `support_tickets` ki 4 purani rows ka kya karna hai — band karna Pardeep ka call.

### 🔴 HANDOFF — padho pehle (22 Aug 2026)

Branch `session/money-spine-hardening-jun1`, sab commit (`16b0872` tak). ✅ **22 Aug ko DEPLOY HO GAYA** — revision **`resellersos-00301-l75`**, 100% traffic. Remote par push nahi ki (branch bahut aage hai) — wo alag faisla hai.

**22 Aug ko kya gaya live:** partial payment par quote `accepted` (`record_payment` ki ek line) · subscription card par **"Paid"** · **Lifetime paid** clickable → `/payments?customer=<id>` (naam se nahi, **id se** filter — is book me "AB corprotion" aur "abc corporaton" saath-saath hain) · transaction categorisation Phase 1/2/4 · aur ek **open redirect ka fix**.

> **🔴 SECURITY — jo mila aur theek hua (22 Aug).** Login page `window.location.href = searchParams.get("next")` karta tha, **bina validation, bina origin prefix**. `/login?next=https://evil.com` sign-in karte hi operator ko bahar bhej deta — theek us page se jahan usne abhi password daala. Wahi string OAuth `redirectTo` me bhi jaati thi.
>
> Ab **ek hi checker**: [`lib/safe-path.ts`](production/src/lib/safe-path.ts), jo login, middleware, OAuth callback aur push — chaaron use karte hain. **Push ki purani private copy me gap tha**: wo `//` par rukti thi aur `/\evil.com` nikal jaata tha, kyunki browser backslash ko slash bana deta hai. **`//` par rukne wala checker poora dikhta hai aur nahi hota.** 10 test, jisme ye bhi ki query string aur fragment **allow** hone chahiye — over-blocking wahi link tod deta jisse ye shuru hua.

**🟢 Categorisation (docs/AI-CATEGORISATION-PLAN.md) — Phase 1, 2, 4 done, AI ka ek bhi call nahi.** Asli coverage: **22 of 39 lines**, 5 seeded rules se. Phase 3 (bache 17 par AI) baaki hai. Do baat yaad rakhne layak:

- **`suggestCategory` pehle se maujood tha** (`lib/queries/expenses.ts`) — 18 category, English+Hinglish keywords. Main uske bagal me doosri list banane wala tha. Wo ab fallback layer hai; tenant rules pehle.
- **`neft`/`rtgs` us keyword list me Bank Charges hain** — typed note ke liye sahi, bank narration ke liye tabaahi: har transfer "Bank Charges" ban jata. Rail guard isliye hai. Uski keemat: khaali `NEFT CHARGES` line ab null deti hai — **miss sasta hai, galat jawaab mehnga**.

> **🔧 Aaj teen baar ek hi shakl ka jaal mila: bytes alag, screen par same.** (1) Shell ne `\b` ko asli **0x08 backspace byte** bana diya — regex kabhi match nahi hua, aur **grep/reader dono backspace ko render karke pichhla character mita dete hain**, to line har baar sahi dikhti thi. (2) Control-character range literal likhne par file **binary** ban gayi. (3) `middleware.ts` CRLF hai, `login/page.tsx` LF — `\n` wala anchor ek me **zero baar** mila. **Sabak: backslash ya control char wale edit shell se mat karo — script file se karo, aur assert karo ki anchor mila.**

> **🔧 Mutation jo apply na ho, wo "test kamzor hai" jaisa dikhta hai.** Chaar me se do mutation sed ke escaping se lagi hi nahi thi aur maine "coverage gap" samajh liya. Ye vacuous loop ka ulta roop hai. **Mutation script ko assert karna chahiye ki anchor theek ek baar mila.**

**⚠️ Meri chaar galtiyan is session me — sab stale doc/yaad se, code se nahi.** `statement AI nahi hai` (hai), `AI sirf drafting karta hai` (money-guard + audit trail bhi hain), `Razorpay P0 missing` (11 files, dono halves configured, sirf `mode: test`), `0231/0232 anaath hain` (usi din apply ho chuki thin). **`LAUNCH_READINESS.md` bina code khole quote mat karo.** Poora hisaab: [docs/ROAD-TO-TEN.md](docs/ROAD-TO-TEN.md) §1.

**Aage ka kram (ROAD-TO-TEN §5):** Razorpay live → GST e-Invoice (ekmatra P0 jo check me tika: `invoices.gst_irn` column hai, **22 invoice, 0 IRN**, koi IRP code nahi) → **ek aur reseller ko ek mahina** (asli Tier 1, code se nahi hota) → phir Phase 3 / GST mismatch / reconciliation.

---

### HANDOFF — 21 Aug 2026 (purana, reference ke liye)

Branch `session/money-spine-hardening-jun1`, sab commit (`90f6db5` tak). ✅ **21 Aug ko DEPLOY HO GAYA** — revision **`resellersos-00299-pqj`**, 100% traffic. Ab live: web push notifications, attendance reminder ka cron, quote ka in-place draft editor, lead ke saath do-tarfa email, aur approvals queue. Branch remote par **push nahi ki** (ab 34+ commits aage) — wo alag faisla hai.

> **🔴 `NEXT_PUBLIC_*` ko Cloud Run env var mat banao — wo browser tak nahi pahunchta.** `next build` use bundle me *substitute* karta hai, isliye sirf runtime par diya value browser me `undefined` aata hai. Notifications card theek yahi var padh kar batata hai ki push set up hai ya nahi — to "sahi" tareeke se karne par production har user ko *"Push is not set up on the server yet"* dikhata, jabki server ke paas dono key hoti aur cron chal raha hota. **Koi error kahin log nahi hota.** Isliye VAPID ka **public** key `Dockerfile` me `ENV` hai (Supabase anon key ke saath), aur sirf `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` Cloud Run par hain.
>
> **`gcloud run services update` par hamesha `--update-env-vars` — kabhi `--set-env-vars`.** Doosra poora set **replace** karta hai; chup-chaap `SUPABASE_SERVICE_ROLE_KEY` aur `CRON_SECRET` samet nau var uda deta. Baad me gina: 11 var, purane nau salaamat.

**🔴 EK COMMAND BAKI HAI — partial payment par quote accepted karne wali migration likhi aur test ki hui hai, par APPLY NAHI HUI.** Auto-mode classifier is machine par DDL rokta hai. Pardeep ko `production/` folder me ye chalana hai:

```bash
env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked -f supabase/migrations/20260821210000_accept_quote_on_first_payment.sql
```

Phir test (kuch likhta nahi, rollback me khatam hota hai) — `PASS` aana chahiye:

```bash
env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked -f supabase/tests/quote_accepted_on_first_payment.test.sql
```

Aakhir me ledger me darj karo: `npx supabase migration repair --status applied 20260821210000`.

> **Kya badla:** `record_payment` me **ek line** — `when v_is_fully_paid and status in (...)` → `when status in (...)`. Migration live `pg_get_functiondef` se **generate** hui hai, haath se likhi nahi, aur script assert karta hai ki sirf wahi ek line badli. **`delete_payment` chhua nahi** — padh kar dekha ki wo pehle se ulta kar deta hai (`v_remaining <= 0 and status = 'accepted'` → `'sent'`), isliye maanga gaya kaam se change **chhota** nikla, bada nahi. **Renewal roll-forward jaan-boojh kar full payment par hi hai** — aadhe paise par saal bhar ki service aage badhana labelling nahi, muft dena hai.
>
> **Test pehle RED saabit hua**, phir likha gaya: current prod function par chalaya to theek wahi galti mili jo Pardeep ne dekhi — `CASE 1 FAIL: partial payment left the quote at "sent" instead of accepted`. TypeScript ke 3284 test is RPC ko chalate hi nahi, isliye green suite ka yahan matlab **kuch nahi**.

**⏰ Scheduler par ab 11 job hain.**

> **🔴 `/api/cron/billing` mahino se likha pada tha aur use koi bulata hi nahi tha.** Wo split-billing karta hai — monthly/quarterly/half-yearly subscription ke har instalment ka ek tax invoice. Code achha hai, idempotent hai (`subscription_id, term_start, period_index` par keyed), aur Scheduler me **iska job tha hi nahi**. Saboot: `subscription_billings` me **0 row**, jabki do quarterly subscription teen mahine se chal rahi hain.
>
> Ye Pardeep ke ek sawaal se nikla — *"yearly commitment monthly payment me payment reminder har mahine aayega ya nahi"*. Jawaab: **haan, par renewal cadence se nahi** — har mahine ka invoice ye cron banata hai aur uska peechha `invoice-dunning` karta hai. Do alag machine, aur ye wali band padi thi.
>
> Ab `resellersos-billing` roz **08:00 IST** chalta hai — **dunning se pehle (09:15)**, taaki din ke invoice bante hi chase ho sakein. Dry run se pehle jaancha: 45 me se **0 invoice** banega — 43 yearly hain (`not_split_billed`) aur 2 ka poora term pehle hi wasool ho chuka hai (cron khud kehta hai *"Instalment invoices would bill it twice"*). Asli run bhi chalaya: invoices 36 → 36, billings 0 → 0. **Koi backdated batch nahi nikla**, jiska dar tha. Naya: `resellersos-attendance-reminders` — `*/30 9-20 * * *` **Asia/Kolkata** (baaki job bhi IST me hain, UTC me nahi). Itni baar chalana safe hai kyunki `attendance_reminder_log` par `(user_id, work_date, kind)` ka unique index hai — Scheduler ka retry, overlapping deploy, aur half-hourly schedule teeno bekaar ho jaate hain, ek aadmi ko din me ek hi baar (per kind) jaati hai. Header wahi `CRON_SECRET` hai jo renewals job me chalता hai (naap kar milaya — galat header wala job hamesha chup-chaap 401 deta rehta aur pata hafton baad chalta).

> **Deployed cron ko `?dry=1` se naapa (kuch likhta nahi):** IST 20:44 par 7 log dekhe, 1 due (Hitesh, check_out), 6 asli wajah se skip — 4 "past the end of the working day with no check-in", 2 "already checked out". Yani deployed route apne env ke saath theek chal raha hai.

> **Deploy ke baad ke verification ne ek purani kami pakdi, aur wo usi waqt theek karke dobara deploy hui.** `curl` se dekha to `/dashboard` sahi 307 de raha tha par **`/vault` aur `/attendance/me` bina session ke 200** de rahe the — middleware ki `PROTECTED_PREFIXES` me dono the hi nahi. Data kabhi nahi khula (RLS bina `auth.uid()` ke kuch nahi deta), par signed-out visitor ko Password Vault ka shell dikhna apne aap me galat hai. `/vault` ye kami shuru se leke chal raha tha. Ab chaaron 307 dete hain. **Sabak: deploy ke baad sirf `/login` check karna kaafi nahi — jo route abhi bane hain unhe bina session ke curl karo.**

**19 Aug ke session ne 4 kaam kiye, aur teeno me handoff ka andaza galat nikla — isliye har cheez naap kar hi maano:**

| # | Kaam | Nateeja |
|---|---|---|
| 1 | Trigger verify | ✅ **PASS** — ab test-verified hai, reasoned nahi. "Do session chahiye" wali baat galat thi. |
| 5 | ₹0 subscription | Subscription **theek hai** (support muft diya gaya). Kharabi renewal me hai — 2027-08-02 ko ₹0 ka quote customer ko email ho jayega. |
| 5b | **DB backup** | 🔴 **6 din se chup-chaap toota tha.** Theek kiya, chala kar verify kiya (96 tables / 933 rows). |
| 4 | Migration drift | ✅ 28 repair ho gayin. Par **2 migrations kabhi chali hi nahi**, aur ek me **₹8,165 GST atka hai**. |

**🔴 Teen cheezein jo agla session shuru me hi jaan le:**

1. **`supabase db push` ab bilkul mat chalao** jab tak GST ka faisla na aaye — wo theek wahi 2 pending files chalayega, jinme paisa badalne wali bhi hai. (Item 4 padho.)
2. **`Q-2026-9776` par ₹8,165 GST gayab hai**, aur quote **accept ho chuka hai** — ye Pardeep ka business faisla hai, code ka nahi.
3. **Backup ab CLI se chalta hai, MCP se nahi.** Dump chhota aaye to ghabrao mat, par maano bhi mat — dusre connection se `count(*)` milao. (Item 5b.)
4. **~~🔴 `0231` aur `0232` anaath hain~~ ✅ HO GAYA (21 Aug 2026) — `360eaf5`.** Dono `migrations-archive/` se nikal kar `migrations/` me timestamp naam se aa gayin (`20260821090000_performance_points`, `20260821090100_marketing_attribution`), prod par chalin, aur ledger me darj hui (279 → 281). **Naap kar confirm (21 Aug):** paanchon object maujood — `task_kudos`, `task_collaborators`, `leads.utm_source`, `expenses.channel`, `salary_payments.performance_points` — aur `npm run migrations:verify` dono ko "all present" (20 aur 5 object) kehta hai, poore repo me **0 MISSING**. Archive me ab `0230` ke baad seedha `0233` hai, isliye `migrations-archive/README.md` ka *"every one of them ran against the production database"* wala dawa in do ke liye **ab galat nahi** — files hi wahan nahi hain.

**Naye tools jo ab maujood hain:** `npm run migrations:verify` (git ki migration DB me lagi hai ya nahi) · `.claude/skills/resellersos-env` (is machine par kaun sa Supabase raasta chalta hai, aur rollback-test ka pattern) · `supabase/tests/users_privileged_columns_owner_only.test.sql`.

Jo baaki hai, ghatte kram me:

**1. ~~Trigger lag gaya par sabit nahi hua.~~ ✅ SABIT HO GAYA (19 Aug 2026)** — [users_privileged_columns_owner_only.test.sql](production/supabase/tests/users_privileged_columns_owner_only.test.sql), live DB par chalaya, ek row: `PASS`. Paanch cheezein sabit: support apna role owner nahi kar sakta · kisi teammate ka `manager_id` nahi badal sakta · apna `full_name` ab bhi badal sakta hai · owner ab bhi teammate ka role badal sakta hai · bina `auth.uid()` wala server path ab bhi guzarta hai (OAuth callback zinda hai). Transaction rollback — DB me kuch nahi bacha (11 users, jaise the).

> **Jo rukawat thi wo galat maan lena tha, access nahi.** Migration ke "HOW TO VERIFY" me likha tha ki asli test "do session maangta hai aur superuser connection se nahi ho sakta" — isliye kaam insaan par chala gaya aur ek din pada raha. Sach: superuser carve-out sirf isliye leta hai kyunki uske paas `auth.uid()` nahi hota, aur `auth.uid()` sirf `request.jwt.claims ->> 'sub'` hai — jo `set_config(..., true)` set kar deta hai; upar se `set local role authenticated` RLS wapas laga deta hai. **`portal_customer_users_no_self_update.test.sql` ye pehle se kar raha tha.** Test "0 rows changed" par pass nahi hota, function ka apna message maangta hai — warna trigger drop hone ke baad bhi green rehta.

**2. ~~📋 REPORTING LINES~~ ✅ LAG GAYI (20 Aug 2026) — Pardeep ne dono naam bataye, TREE A prod par apply ho gaya.**

**Faisla (Pardeep, 20 Aug):** Darshan → **Ananya** · Hitesh → **Pardeep**. (Ananya → Pardeep link pehle se tha, chhua nahi.)

```
Pardeep Sharma (owner)
├── Ananya Sharma (manager)
│   └── Darshan (Sales) (sales_senior, 15 leads)
└── Hitesh Baghel (manager, 1 lead)
```

**Kaise laga:** ek transaction ne dono `manager_id` likhe, phir **usi transaction me** har bande ki seat par baith kar (`request.jwt.claims` → `auth.uid()`, role `authenticated`) RLS se leads ginwaye aur expected se milaye — koi ginti galat hoti to `raise exception` transaction abort kar deta, yaani **galat tree commit ho hi nahi sakta tha.** Saath me cycle check (recursive chain, 0 cycles). Script repo me hai: [set-reporting-lines-2026-08-20.sql](production/supabase/maintenance/set-reporting-lines-2026-08-20.sql), aur uska read-only jodidaar [verify-reporting-lines.sql](production/supabase/maintenance/verify-reporting-lines.sql) — jab bhi shak ho, wo dobara chala kar live asar naapa ja sakta hai (kuch likhta nahi).

**🔴 Aur assertion ne sach me ek cheez pakdi: leads ab 18 nahi, 19 hain.** Pehla run `FAIL: Pardeep sees 19 leads, expected 18` par abort hua — kuch likhe bina. Naapa: naya lead **20 Aug ka hai aur Pardeep ka apna** hai (owner-wise aaj: Darshan 15 · Pardeep 3 · Hitesh 1 · unowned 0). Expectation 19 ki, phir apply. **Sabak: pichhle session ka naapa hua aankda bhi ek tareekh ka hai — assert karo, warna chup-chaap purane number par bharosa ho jayega.**

**Alag connection se verify (committed state par, 6 me se 6 assertion pass):**

| Kaun | Role | Reports to | Direct reports | Apne leads | Dikhte hain | Pehle |
|---|---|---|---|---|---|---|
| pardeep@anutech.in | owner | — | **2** | 3 | **19** | 18 |
| deepak@anutech.in | owner | — | 0 | 0 | **19** | 18 |
| **ananya@anutech.in** | manager | pardeep | **1** | 0 | **15** | **0** 🔴→✅ |
| hitesh@anutech.in | manager | **pardeep** | 0 | 1 | **1** | 1 |
| sales@anutech.in (Darshan) | sales_senior | **ananya** | 0 | 15 | **15** | 15 |
| pratik@anutech.in | support | — | 0 | 0 | **19** | 18 |

**Teen baatein jo lagne ke baad bhi sach hain — inhe kami na samjho, ye is tree ke seedhe natije hain:**

1. **Hitesh ab bhi sirf 1 lead dekhta hai.** Wo manager hai jiske neeche koi nahi — Tree A me Darshan Ananya ke neeche gaya. Manager hone ka fayda tabhi milta hai jab neeche koi ho. Agar Hitesh ko bhi pipeline chahiye to **uske neeche kisi ko lagana padega** (role badalne se kuch nahi hoga).
2. **Pardeep ke apne 3 leads kisi ko nahi dikhte** — wo sabse upar hai, aur visibility neeche ki taraf chalti hai. Ananya 15 par ruk jaati hai, 19 par nahi jaati. Un 3 ko team ko dikhana hai to **owner_id badalna** padega; tree se ye kabhi nahi hoga.
3. **Support/delivery ke chaar log (Pratik, Ranjeet, Pawan, Abhishek) poore 19 leads dekhte hain.** Rok sirf `sales`, `sales_senior`, `manager` par hai. Ye niyam ke hisaab se sahi hai par ek **faisla** hai — nahi chahiye to niyam badlega, tree nahi.

**Quotes aur customers par ab bhi koi asar nahi** — `quotes.owner_id` aur `customers.account_manager_id` khaali hain, aur khaali rows sabko dikhti hain. Hierarchy filhaal sirf **leads** par kaam karti hai.

**✅ Support/delivery bhi lag gaye (20 Aug, Pardeep ka faisla): chaaron Hitesh ke neeche.** Pratik · Ranjeet · Pawan · Abhishek → `hitesh@anutech.in`. Ab ANUTECH me **sirf teen** log bina manager hain, aur wo teeno owner hain — poora org-chart bhar gaya. Script: [set-support-delivery-lines-2026-08-20.sql](production/supabase/maintenance/set-support-delivery-lines-2026-08-20.sql).

```
Pardeep Sharma (owner)
├── Ananya Sharma (manager)          → dekhti hai 15
│   └── Darshan (Sales) (sales_senior, 15 leads)
└── Hitesh Baghel (manager, 1 lead)  → dekhta hai 1
    ├── Pratik Sharma (support)      → dekhta hai 19
    ├── Ranjeet Raj (support)        → 19
    ├── Pawan Kumar (delivery)       → 19
    └── Abhishek Sharma (delivery)   → 19
```

**🔴 Is badlav ne ek bhi ginti nahi hilai, aur yahi iska poora matlab hai.** Hitesh ke ab **4 direct reports** hain, par wo **ab bhi sirf 1 lead** dekhta hai — kyunki chaaron ke paas 0 leads hain. Aur chaaron neeche wale ab bhi poore 19 dekhte hain, kyunki support/delivery par rok hai hi nahi. Yaani: **org-chart me kisi ko manager ke neeche daal dena visibility nahi deta — dena hai to uske neeche kisi ke paas leads hone chahiye.** Pehle yahan “nau me se nau assertion pass” likha tha — **wo daawa galat tha** (khaali loop), neeche SUDHAAR padho. Ab `verify-reporting-lines.sql` sach me naapta hai aur poore tenant ko cover karta hai.

**Ek baat aage ke liye:** agar kabhi Pratik/Ranjeet/Pawan/Abhishek ko leads dene lage, to Hitesh ko wo **apne aap** dikhne lagenge — ye tree ab live hai, sirf sajaawat nahi.

**📊 [dashboard.html](dashboard.html) me naya `Org` tab hai** — wahi tree, par padhne layak: har naam ke saath role, "apne leads" aur "dikhte hain", upar **"naapa gaya 20 Aug 2026"** ka badge, aur neeche wahi verify command. Data file ke andar likha hai kyunki dashboard `file://` se khulta hai aur DB se query nahi kar sakta — isliye tareekh **data ka hissa** hai, sajaawat nahi: purana aankda naye jaisa hi dikhta hai. Tree badle to numbers **aur** `ORG_AS_OF` dono badalna.

**🔴 Usi file me ek chalu landmine mila aur band kar diya: dashboard TASKS.md ko chup-chaap kaat sakta tha.** `parseTaskMarkdown()` sirf `## section` aur `- [ ] task` samajhta hai, aur `toMarkdown()` file ko **sirf unhi se** dobara likhta hai — yaani is file ki **775 line** (85 `###` heading, 101 table row, 8 code block, 573 line prose — ye ginti khud badalti rehti hai, banner har baar load par naapta hai) ek write me chali jaatin. Aur wo write maangni bhi nahi padti thi: `markChanged()` **500ms baad `autoSave()`** chala deta hai, to ek card khisakana kaafi tha. Ab guard **load par** chalta hai — save-time par poochhne se pehle hi nuksaan ho chuka hota: file me kuch bhi aisa ho jo board dobara na bana sake to save **band**, aur ek banner asli ginti ke saath wajah batata hai. Board-jaisi saadi file par kuch nahi badalta — teen case par test kiya (asli TASKS.md → band · saadi file → khuli · `# Tasks` ke alawa koi h1 → band, kyunki wo sach me mit jaata hai).

**🔴 SUDHAAR (usi din, 20 Aug): jo "9/9 assertion pass" likha tha, wo khaali loop tha — ek bhi assert chala hi nahi tha.**

`for r in select id, email from public.users ...` loop **`set local role authenticated` ke baad** rakha tha. Us waqt tak koi JWT set nahi hota, to `auth.uid()` null hota hai, RLS `public.users` ki **saari row chhupa deta hai** — loop **zero baar** chala aur file ne "sab pass" bol diya. Naapa hua: `begin; set local role authenticated; select count(*) from public.users;` → **0**.

**Kya asli tha aur kya nahi, saaf-saaf:**

| | Haal |
|---|---|
| Tree A ke chaar number (Ananya 15 · Hitesh 1 · Darshan 15 · Pardeep 19) | ✅ **asli** — `set-reporting-lines` me har banda hardcode UUID se likha tha, loop nahi tha. Isi liye pehla run `18 vs 19` par phata tha. |
| Support/delivery ka org-chart hissa (4 direct reports · 3 rootless · no cycle) | ✅ **asli** — wo block role switch se **pehle** hai, privileged connection par. |
| "9/9" aur "6/6" visibility assertions | ❌ **vacuous** — kuch bhi naapa nahi gaya tha. |

**Pakda kaise gaya:** naye `npm run org:sync` ne **doosri jagah se naap kar** ulta jawab diya (`no measurement for: <saare 10 log>`). **Ek vacuous test khud kabhi red nahi hota** — usse pakadne ke liye doosra rasta chahiye. Yahi is script ka sabse bada fayda nikla, chart to baad ki baat hai.

**Ab dono jagah do badlav:** (1) roster `authenticated` par utarne se **pehle** padha jaata hai aur GUC me le jaaya jaata hai; (2) loop **apni iteration ginta hai** aur poore roster se kam par `VACUOUS RUN` phenkta hai. Doosra pehle se zyada zaroori hai — wo "kisi ko naapa nahi" ko pass se **fail** bana deta hai, chahe aage koi jaise bhi ye galti dobara laaye.

**Aur ab ye sach me chalta hai, kyunki red hona bhi sabit kiya:** expected `15 → 99` karke → `MISMATCH: ananya@anutech.in sees 15 leads, expected 99`; aur purani bug wapas daal kar → `VACUOUS RUN: measured 0 people, expected 10`. Dono baar exit 1.

**Asli, naapa hua nateeja (chaaron file ab imaandar hain) — 10 me se 10 log:** Pardeep 19 · Deepak 19 · Client D 19 · Pratik/Ranjeet/Pawan/Abhishek 19 · Ananya **15** · Darshan 15 · Hitesh **1**. Leads 19, owned 19, unowned 0. **Jo aankde pehle bataye the wo sahi the — kami saboot me thi, ginti me nahi.**

**📊 [dashboard.html](dashboard.html) ka `Org` tab ab generate hota hai:** `cd production && npm run org:sync` ([org-chart-sync.mjs](production/scripts/org-chart-sync.mjs)) live DB se naap kar `>>> ORG DATA` markers ke beech ka block khud likhta hai — tareekh, tenant ka naam, poora tree, aur dono number. `--check` sirf batata hai (exit 2 = purana), aur wo **tareekh ko nazarandaz karta hai**, warna har naye din jhoothi warning aati.

**Markers ke bahar ka sab kuch haath se likha hai aur usme koi number nahi hai** — chaaron note apne aankde data se khud nikaalte hain, isliye tree badalne par prose apne aap sahi rehta hai. Ek note isi wajah se bakwaas bol raha tha ("sabse zyada 19 tak pahunchta hai, 19 tak nahi") — kyunki wo *sabhi* neeche walon ko gin raha tha, jabki support/delivery poora pipeline **tree ki wajah se nahi** dekhte. Ab wo sirf un logon ko ginta hai jinpar rok hai → sahi jawab **15**.

**Script khud likhne se pehle jaanchti hai:** poora inline script parse hota hai, `renderOrg()` ek stub DOM par chalaya jaata hai, aur har bande ka naam output me hona zaroori hai — warna kuch likha hi nahi jaata. Manager kisi doosre tenant me ho, ya chain me cycle ho, ya koi bhi aadmi chart me na aaye, to **error** aata hai — chup-chaap chhoot nahi jaata.

**🧪 Dashboard ke dono naye hisse ab suite me hain — 17 test, [tests/dashboard.test.ts](production/tests/dashboard.test.ts).** Suite **3169 → 3186**, files 163 → 164. `vitest.config.ts` me `tests/**` jodna pada: `dashboard.html` app ka hissa nahi hai (na build, na import) — uska logic inline `<script>` me hai, jise nikaal kar `node:vm` me chalaya jaata hai. Use `src/` me rakhna matlab ye maan lena ki app ise ship karta hai.

**Test kisi ginti par nahi tike hain, invariant par tike hain** — kyunki ORG block generate hota hai. "Ananya 15 dekhti hai" pin karte to kal ka sahi `org:sync` suite ko red kar deta, aur jo test bina wajah red hota hai wo hata diya jaata hai. Jo hamesha sach rehna chahiye, wahi assert hota hai: har aadmi render hota hai · bachche apne hi parent ke *baad* aate hain · koi duplicate email nahi · koi bhi `own`/`sees` tenant ke kul se zyada nahi · partition note ka ganit (`a + b + c = N`) khud jod kar milaya jaata hai · aur save guard ki ginti test **apne hisaab se dobara** nikaalta hai, taaki wo code se sirf haan-me-haan na mila de.

**🔴 Aur mutation testing ne mere pehle test ko fail kar diya — ye likhne layak hai.** Teen jagah code jaan-boojh kar todi gayi:

| Mutation | Nateeja |
|---|---|
| Guard ka lock hataya (`saveBtn.disabled = false`) | ✅ 2 test red |
| Chart se children render band | ✅ 2 test red |
| Note 3 ka purana bug wapas (sab descendants gino) | ❌ **17/17 pass — pakda hi nahi** |

Wajah samajhne layak hai: us bug se note **contradiction bolta nahi, chup ho jaata hai** — sab descendants ginne par sabse zyada = kul = 19, aur note ki apni `best >= total` shart use skip kar deti hai. Aur **gayab note ko wo test dekh hi nahi sakta jo sirf maujood notes padhta hai.** "Koi ulti baat na ho" assert karna kaafi nahi tha; **"jo baat honi chahiye wo ho"** assert karna pada — data se: agar root ke paas apne leads hain aur uske neeche kisi rok wale ko kul se kam dikhta hai, to panel ko ye **bolna hi padega**, aur wahi aankda bolna padega. Ab mutation dobara lagayi to: `pardeep@anutech.in withholds 3 lead(s) from its team and the panel is silent`.

**Sabak, aur ye aaj doosri baar hua:** green test ka matlab kuch nahi hai jab tak wo red hote hue **dekha** na ho. Subah ye khaali loop ki shakal me mila (upar wala SUDHAAR), shaam ko ek aise test ki shakal me jo galat cheez naap raha tha. Dono baar pakad ne wala tareeka ek hi tha — jaan-boojh kar tod kar dekho.

**Gate:** typecheck 0 · **164 files / 3186 tests pass** · lint 0 errors (6 purani warning, chhui hui file me ek bhi nahi) · `npm run build` **nahi** chalayi (doosre session ka dev server chal raha hai, aur aaj ka koi badlav Next route ko chhuta hi nahi — deploy se pehle chalani zaroori hai).


**3. ~~`info@clientd.example` kaun hai~~ ✅ JAWAB MIL GAYA (19 Aug 2026) — ye ANUTECH ka apna hi email hai.** Pardeep ne confirm kiya: yahi login Google Workspace sales console ka user id bhi hai. Chaar baar pooche jaane ke baad ye sawaal **band**. Role `owner` sahi hai, koi badlav nahi chahiye — aage ke session isko dobara flag na karein.

> Ek baat phir bhi yaad rahe: ye ek **shared console address** hai, yaani ek se zyada log ismein sign in kar sakte hain. Company data ke liye theek hai. Par kisi bhi *vyaktigat* (personal) data ke liye ye maayne rakhta hai — isiliye Owner Vault ki RLS `role = 'owner'` par nahi, `auth.uid()` par tiki hai.

**4. 🔬 JAANCH LI (19 Aug) — 30 files untracked hain, aur "sirf tracking drift hai" wali baat SACH NAHI NIKLI. 2 migrations kabhi chali hi nahi, aur ek me ₹8,165 GST atka hua hai.**

Naapa hua: `migrations/` me **30** files hain (29 nahi), sab 16–18 Aug ki; remote ledger me 247 records hain jinme sabse naya **10 Aug** ka — yaani teeso untracked. Nayi jaanch: **`cd production && npm run migrations:verify`** ([migration-drift-check.mjs](production/scripts/migration-drift-check.mjs)).

| | |
|---|---|
| **26 schema migrations** — har object (table/column/function/trigger/policy/index) DB me maujood | ✅ **repair sahi hai** |
| **4 data/comment migrations** — inka koi object hota hi nahi, isliye tool ne inhe pass nahi kiya, **"insaan padhe"** bola | haath se padhi |

Chaaro haath se padhi aur **unka asar data me** dhoonda — yahi asli sawaal hai, kyunki `create table` na ho to "chali ya nahi" schema se pata hi nahi chalta:

- ✅ `20260816112000_backfill_quote_total_cost` — 0 quotes pending. **Chal chuki.**
- ✅ `20260817160000_support_tier_skus` — 12 SUP-* items maujood (6 × 2 tenants). **Chal chuki.**
- ❌ `20260817210000_dunning_pre_due_comments` — **kabhi nahi chali.** Ye sirf do `comment on column` karti hai, jinme koi shart nahi hai — to "shayad skip ho gaya" ka bahana bhi nahi. `invoice_dunning_log` par sirf `action_taken` ka comment hai (kisi purani migration se); `dunning_step` aur `days_overdue` dono khaali.
- 🔴 `20260817100000_fix_missing_gst_on_onboarded_quotes` — **asar nahi hua, aur usme paisa hai.** Poore DB me ek quote is haalat me hai:

  > **`Q-2026-9776` — CLIENT B PROJECTS PRIVATE LIMITED · status `accepted`** · subtotal ₹45,360 · tax_rate 18 · **amount ₹45,360 jabki ₹53,525 hona chahiye — ₹8,165 GST gayab.** Na invoice bani hai, na payment aayi hai (isliye abhi sudharna surakshit hai).

**Iska matlab kya hai:** handoff ki baat 26 files ke liye sahi thi, par **saari 30 par `migration repair` chala dete to do na-chali migrations "chal gayi" mark ho jaatin — aur ye ₹8,165 wali GST hamesha ke liye dab jaati.** Ledger jhooth bolne lagta aur agla banda usi par bharosa karta. `db push` ab bhi khatarnak hai (28 already-lagi files dobara chalayega).

**Kya ho gaya:**
1. ✅ **28 files `repair --status applied` ho gayin** (26 schema + 2 data jinka asar sabit hai). Ledger 247 → **275**, aur dono na-chali versions jaan-boojh kar **bahar** rakhi gayin. Verify: `select count(*) from supabase_migrations.schema_migrations` → 275.

**Kya baaki hai:**

> ### ⚠️ `supabase db push` ab **theek wahi 2 files chalayega** — aur unme se ek paisa badalti hai
>
> Repair se pehle push khatarnak tha kyunki 28 already-lagi files dobara chalti. Ab wo khatra gaya, par ek naya banna hai: push ab `20260817100000` (GST) aur `20260817210000` (dunning comments) dono laga dega — yaani **GST wala faisla bina liye hi lag jayega.** Jab tak neeche wala jawab na aaye, **push mat karo.**

2. **Dunning comments wali (`20260817210000`) surakshit hai** — sirf do `comment on column`, koi data nahi badalta. Classifier DDL rokta hai, isliye ye ek permission rule maangti hai ya alag se chalani padegi.
3. **🔴 GST wali Pardeep ka faisla hai, meri marzi nahi.** Quote **accept ho chuka hai** ₹45,360 par. Use ₹53,525 karna matlab customer ke accept karne ke **baad daam badalna**. Do hi soorat hain: ya to quote galti se GST ke bina bana tha (to sudhar sahi hai, aur customer ko batana padega), ya daam GST-sahit tay hua tha (to `tax_rate` galat hai, `amount` nahi — aur tab ye migration is quote par chalni hi nahi chahiye). **Ye business call hai, aur dono ka jawab alag hai.**

**5. ~~Ek ANUTECH support subscription "about ₹0" dikhata hai~~ 🔍 JAANCH LI (19 Aug 2026) — subscription theek hai, uske aage ka raasta toota hai.**

Handoff ka andaza galat tha: **matching quote line hai.** `Q-ADPL-2026-27-0003` (AB corprotion, accepted, ₹4,28,198) ki doosri line —

```
name: "ANUTECH DIGITAL PVT LTD Standard Support (Yearly)"   qty 1
rate: 0        list_rate: 9996        cost: 0
```

Yaani support **muft diya gaya** 35-seat Google Workspace deal ke saath. `mrr = 0` uska sahi hisaab hai, bug nahi. Quote ka ganit bhi milta hai: subtotal ₹3,62,880 = 35 × 10,368 (support ne ₹0 jodha), amount = +18% GST.

**Approval gate bhi sahi chala, dhoka nahi hua.** [approval-economics.ts](production/src/lib/quotes/approval-economics.ts) discount `list_rate` bनाम `rate` se nikalta hai (`discount_pct` se nahi — wo galti pehle hi soch li gayi thi). Blended discount = 9,996 ÷ 3,72,876 = **2.68%**, jo 10% ki auto-approve limit se neeche hai. Margin 28.2%. To `approval_status: not_required` sahi hai — ₹3.6L ke deal me ₹9,996 ka freebie sach me chhota discount hai.

**⚠️ Asli kharabi renewal me hai, aur wo paisa aur customer dono chhuti hai.** [create-renewal-quote.ts:103](production/src/lib/renewals/create-renewal-quote.ts:103) renewal ka amount `mrr × 12` se banata hai. Is subscription ka mrr 0 hai, aur wo `status: active` + `auto_renew: true` hai. Renewals cron ([route.ts:158](production/src/app/api/cron/renewals/route.ts:158)) sirf `status=active` + `auto_renew=true` par chunta hai — **mrr ka koi filter nahi.** Natija: `renewal_date` 2027-08-17, to T-15 par **2027-08-02 ko customer ko ₹0 ka renewal quote email ho jayega** (`amount: 0`, [route.ts:312](production/src/app/api/cron/renewals/route.ts:312)). Company ke naam se zero-rupee quote bahar jayega.

Aur us line par `list_rate` set hi nahi hota, to renewal quote par discount hamesha `null` — approval kabhi nahi lagega, chahe rate kuch bhi ho.

**Ye ek pricing faisla maangta hai (Pardeep ka), par ek technical guard dono jawab me sahi hai:** agar support hamesha muft hai to quote bhejne ki zaroorat hi nahi; agar aage se chargeable hai to quote par asli daam hona chahiye. Dono soorat me **₹0 ka quote auto-send nahi hona chahiye** — usse rok kar insaan ko dikhana chahiye. Abhi bandh nahi kiya kyunki pehli aag 2027-08-02 hai, aur behaviour Pardeep ke jawab par nirbhar hai.

**5b. 🔴→✅ DB BACKUP CHHUP KAR TOOTA HUA THA — 6 din (13–19 Aug), ab theek.** Safai karte hue mila, dhoonda nahi tha. `npm run backup:db` MCP server par chalti thi jise `SUPABASE_ACCESS_TOKEN` chahiye — aur wo var is machine par kharab hai. To har run `Unauthorized` laata tha, aur script use `rows(...).map is not a function` bana deti thi. **Free plan par PITR nahi hai, automatic backup nahi hai** — yaani poora safety net ek 13 Aug ki purani file thi, aur kisi ne bataya tak nahi. Ab transport CLI par hai (token chahiye hi nahi) aur **har parse failure throw karti hai** — pehle `[]` lautati thi, jisse ek baar "0 tables wala backup" likha ja chuka hai. Chala kar dekha: **96 tables / 933 rows, exit 0**. Rows 1210 → 933 giri, jo aadha-adhoora backup jaisa hi dikhta hai — isliye maana nahi, **dusre connection se har table ka live `count(*)` milaya, sab exact match**; kami asli test-data deletion hai. [docs/BACKUP.md](docs/BACKUP.md)

**5c. Safai (19 Aug) — poori ho gayi:** purani global skill `resellersos-builder` **archive** kar di (`~/.claude/backups/skills-archive/`, mitayi nahi) — wo 27 May ki thi, path galat batati thi, aur "4 users, 3 Client A me" kehti thi jabki asli me 11 users / 2 tenants hain. Uski jagah repo ke andar [.claude/skills/resellersos-env](.claude/skills/resellersos-env/SKILL.md) — sirf access/machine ki sachchai (code patterns `production/CLAUDE.md` me hi rahenge). **`.mcp.json` hata di** (Pardeep ki haan par) — usme sirf ek server tha jo `"${SUPABASE_ACCESS_TOKEN}"` ki wajah se hamesha `Unauthorized` deta tha; kaam ka server `supabase-db` user-scope me hai aur chalta hai.

> Naye teammate ko Supabase MCP chahiye to wo **apne user-scope me asli PAT ke saath** joḍe. Repo me token nahi jaana chahiye, aur `${VAR}` `.mcp.json` me expand hota hi nahi — yahi is file ki maut thi.

**6. Environment (dekho [docs/WORKING-ENVIRONMENT.md](docs/WORKING-ENVIRONMENT.md)):** token theek ho gaya par **explorer restart baaki** hai, to purani windows me abhi bhi galat copy hai. Defender exclusion baaki (Tamper Protection command ko rokta hai — GUI se karna hoga).

**7. Bahut purana, user par ruka:** GitHub Team plan → branch protection wapas · `gh auth login -s workflow` → `money-check.yml` commit · teen developer usernames → `CODEOWNERS`. **Developers ko invite mat karo jab tak branch protection wapas na aaye.**

**Jo is session me poora hua:** hierarchy visibility (paanchon step, RLS live — 9 restrictive policies), /team ka "Reports to" picker, sidebar me role, keyboard system, billing engine, poka-yoke forms. Gate: 2926 tests / 155 files, typecheck + lint clean, build exit 0.


### 📢 Marketing & Advertising OS (Pardeep, 13 Aug 2026) — 🟡 CHANNEL ECONOMICS DONE (29 tests). CAC/ROAS deliberately withheld — see below.

**Already existed, so the brief shrank:** `/campaigns` and `/coupons` pages · `/api/campaigns/ai-generate` (the Gemini copywriter — directive 3's generator, with a deterministic stub fallback) · `/api/campaigns/send` · `/api/public/coupons/validate` · and **`/accounting/saas-metrics` already computes LTV** as ARPC ÷ monthly churn rate, which is half of directive 6.

**`campaigns` is the wrong table for ad spend.** Its columns are `subject`, `body`, `body_html`, `audience_filter`, `recipients_count`, `sent_count`, `failed_count` — it is an email blast. Adding `impressions`/`clicks`/`actual_spend` to it produces a table where half the columns are always null. Paid channels need their own table.

**The measured reality, and why CAC/ROAS is withheld:**

| | |
|---|---|
| Total recorded marketing spend, ever | **₹4,000** (one Facebook expense, 9 Aug, in `expenses`) |
| Won lead value | **₹66,64,199** |
| Naive ROAS | **≈1,650×** |

That multiple is not impressive, it is meaningless — it measures the absence of spend records, not the ads. A dashboard rendering it invites a real decision ("pour money into Facebook") off one ₹4,000 row. So [channel-economics.ts](production/src/lib/marketing/channel-economics.ts) returns **CAC and ROAS as null with a stated reason** whenever recorded spend covers under 2% of won value, and reports them normally once spend is genuinely tracked (tested both ways).

**What DOES work today — real channel data, no new integrations:** `leads.source` holds 61 leads across 8 sources with genuine outcomes. WhatsApp leads 23/18-won/₹29.3L; referral 7/6/₹6.8L; buy-workspace-v2 7/6/₹5.1L; tele-calling 5/3/₹1.6L; email-inbound 2/0/₹0.

**`manual` and `csv` are not channels.** They are data-entry provenance, and they are **16 of 61 leads**. On raw won value `manual` (₹19.2L) outranks every real channel but WhatsApp — a ranking that included it would imply "manual" as somewhere to invest. They are reported as a separate *unattributed* bucket rather than dropped, because the size of that bucket is the most useful number on the page: the share of pipeline whose origin nobody knows.

**Done:** [channel-economics.ts](production/src/lib/marketing/channel-economics.ts) + [tests](production/src/lib/marketing/channel-economics.test.ts) — **29 tests**, suite 698 → **727, 0 failed**, typecheck + lint clean. Win rate divides by CLOSED deals (dividing by all leads punishes a channel for having a full pipeline) and stays null under 5 closed deals. `notes` is an **array**, not a string — the first test to hit a channel with two problems at once (no spend AND too few closed deals) proved a single string hid one of them, and half an explanation is worse than none.

**Blocked on credentials, not code:** `GEMINI_API_KEY` absent → the AI copywriter runs in stub mode · `RAZORPAY_KEY_ID` + webhook secret absent → coupons cannot link to a checkout that reconciles · WhatsApp has **zero** credentials → instant brochure dispatch cannot deliver. **A/B testing is gated behind all of this**: splitting variants across buckets is meaningless while the send path logs instead of sending, because there is no CTR to measure.

**Follow-up DONE (Pardeep: "1, 2 dono karo, jo app ki behtri ke point of view se sahi ho"):**

- **Ad spend stays in `expenses`, with one new `channel` column — NOT a separate ad-spend table.** This was the judgement call. Marketing spend already lands in `expenses` (the ₹4,000 Facebook row), flows into the P&L, and is reconciled against the bank statement. A separate table would be a *second* place spend lives, and that second place **bypasses bank reconciliation** — producing marketing spend that shows on a dashboard and never appears in the bank, with CAC disagreeing with the accounts while both look authoritative. `impressions`/`clicks` deliberately omitted: without the Google/Meta APIs they would be hand-typed, they add nothing to CAC or ROAS, and empty columns invite a dashboard that reports zero as if it were measured.
- **`leads` gets the 5 UTM columns; NO touchpoint table yet.** Nothing in the app records a second touch, so `lead_touchpoints` would be created empty and stay empty — built, looks configured, does nothing. First-touch-at-creation is available on a write path that already runs, so that is what was built.
- [utm.ts](production/src/lib/marketing/utm.ts) + [tests](production/src/lib/marketing/utm.test.ts) — **26 tests**. Two privacy decisions: `landing_page_url` keeps path + utm params only (real landing URLs carry `?email=`, `?phone=`, session tokens — a marketing table is the last place anyone looks for personal data, DPDP), and `referrer_url` keeps origin + path (a referrer query string leaks search terms and, from some apps, a token). Both are tested against an actual `?email=pardeep@anutech.in&phone=…` URL. **Self-referrals are discarded** — otherwise every internal click counts as an arrival and this site becomes its own top channel. `utm_medium=cpc` upgrades `google-organic` → `google-ads`, because only one of the two has a CAC.
- **The Referer header IS the landing page** on a same-origin form POST, so utm capture works today with **no change to any form**. `request.url` is the API path and is useless for attribution. Only the browser knows the pre-landing referrer (`document.referrer`); a form may send it as `pageReferrer`, and when absent `referrer_url` stays null rather than being filled with our own page.
- Wired into **all four** public lead-creating routes (`enquiry/general`, `enquiry/workspace`, `trial/workspace`, `checkout/workspace`) — not two of four.
- [20260821090100_marketing_attribution.sql](production/supabase/migrations/20260821090100_marketing_attribution.sql) — `expenses.channel` + partial index, `leads` × 5 UTM columns + partial index, separate verify block. ✅ **Applied 21 Aug 2026** (was `0232`, renamed on the way out of `migrations-archive/`).

**Two self-inflicted bugs caught here, both worth remembering.** Writing a control-character regex as *literal* control characters put a **NUL byte** in `utm.ts` and turned the file binary; the first repair left `[-]`, which silently stripped **hyphens** — that would have folded `google-ads` into `googleads` and split one channel into two, with spend booked against one and leads against the other. Replaced with a codepoint filter that neither mistake can mangle, and the first test in the file now locks hyphens in. Separately, a typo in a test fixture (`reselleros.in`, one 's' short) exposed that self-host matching is **exact** — correct behaviour, but it means an incomplete `selfHosts` list lets internal navigation through as a channel; now documented and tested.

Suite 727 → **753, 0 failed**. Typecheck + lint clean.

**Still not built:** multi-touch first/last attribution (needs a touchpoint table, and a second touch to put in it) · `/marketing` page · backfilling `channel` on the one existing Facebook expense row.

### 🧠 Employee Mastery OS (Pardeep, 13 Aug 2026) — 🟡 LEVELS + BURNOUT PROTECTION DONE (41 tests). 4 of 6 directives blocked on measured grounds.

**Built, test-verified:**
- [levels.ts](production/src/lib/mastery/levels.ts) (23 tests) — L1–50 on a closed quadratic curve (a 50-row table is 50 chances to fat-finger a number that decides a pay band), 4 tiers with 1.0/1.1/1.2/1.3× multipliers, and `allocatePool`. **The multiplier is safe here only because payout is pool ÷ share** — total cost stays the pool the owner typed. On a ₹-per-point rate the same multiplier would raise the wage bill by an amount nobody approved. It is however **zero-sum**: a Master's larger share comes out of everyone else's, and the UI must say so. `allocatePool` uses **largest remainder**, so shares sum to EXACTLY the pool — rounding each share independently drifts by a few rupees on ₹50,000, which is exactly small enough to stop a payroll run balancing. Corrupt XP (NaN/Infinity) resolves to **level 1, never 50** — bad data must fail downward, not promote someone into the top pay band.
- [quiet-hours.ts](production/src/lib/mastery/quiet-hours.ts) (18 tests) — burnout protection with a real target: `resellersos-birthday-greetings` is scheduled `1 21 * * *` Asia/Kolkata = **21:01 IST**. Emails are stubbed today, so the day `RESEND_API_KEY` lands this app starts mailing people at 9pm and nobody decided that. **Suppression is deferral, never deletion** — a swallowed renewal notice is a money bug, because the cadence records it as sent while the customer hears nothing. `transactional` and `security` are exempt (a payment receipt at 3am is what the payer is refreshing for; an OTP is useless tomorrow). Friday-night mail correctly queues to **Monday** 09:00, not Saturday.

**Measured blockers on the rest — none of these are guesses:**

| Directive | Why it cannot work today |
|---|---|
| Quest 1 "Create & send quote **via WhatsApp**" | `GUPSHUP_API_KEY`, `WHATSAPP_TOKEN`, `META_APP_SECRET` all absent. Unfinishable. |
| Quest 2 "Match 3 bank feeds **via Setu AA**" | `SETU_CLIENT_ID` absent → simulation only; live needs FIU registration with an RBI-licensed AA. **But manual reconcile works** — 28 of 39 bank lines are already hand-matched, so re-point the quest there. |
| Quest 3 "Use Ctrl+K 10 times" | No usage tracking exists anywhere. Needs new instrumentation + a table. Genuinely worth doing — it drives adoption of the palette work from earlier today. |
| Streak "3 completed tasks/day" 🔥 | **Total tasks completed ever = 3**, all on 2026-08-01. The counter would read 🔥0 for everyone, indefinitely. A mechanic that always shows zero teaches the team the system is fake. |
| Personal Best (beat last month) | Only **one** month of collection data exists (2026-08). No baseline to beat. |
| Team Co-Op "₹50L monthly renewal collection" | See the `is_renewal` finding below. |

**`is_renewal` investigation — NOT a bug (and this corrects yesterday's badge work).** `is_renewal: true` is set correctly at [create-renewal-quote.ts:138](production/src/lib/renewals/create-renewal-quote.ts:138) and [create-extension-quote.ts:135](production/src/lib/renewals/create-extension-quote.ts:135), reached from the renewals cron, `/api/renewals/send-now`, and `/api/subscriptions/[id]/generate-renewal-quote`. It is empty on all 52 quotes because **no renewal quote has ever been created**: `renewal_quote_id` is null on 54 of 54 subscriptions and `renewal_state` is `pending` on all of them. The nearest `renewal_date` is **2027-07-23 — 344 days out**, so the T-15 trigger first fires **2027-07-08**. The machinery is correct and will populate itself in ~11 months. Consequence: the co-op renewal target **and the Renewal Guardian badge I added yesterday** are dormant until then, not broken.

**Decided with Pardeep:** no revenue share for Master tier — the 1.3× multiplier stays inside the pool, so cost stays bounded; a revenue share is an unbounded commitment and nobody is near L41 anyway.

**Not built:** `/mastery` page — deliberately not started, because `/performance` and `/scorecard` already exist and a third performance page is the duplication trap that cost real work earlier today. Also open: quest event instrumentation, streak engine (pending a reachable target), personal-best baselines, and wiring `quietHoursDecision` into `lib/email/send.ts` (the single chokepoint).

### 🎮 Gamified tasks + Performance Points (Pardeep, 13 Aug 2026) — 🟡 KUDOS + BADGES + WEEKLY BOARD DONE (test-green, typecheck+lint clean). Migration ✅ **applied 21 Aug 2026**. Sharing/comments UI pending.

> **Two corrections to my own analysis, both found by checking rather than assuming — recorded so the next reader does not repeat them.**
>
> **1. `users.employee_id` already exists**, populated for 6 of 8 logins — including `sales@anutech.in`, which I had claimed "could never become a bonus". `usePerformance` has been reading it all along to join attendance. My draft of `0231` added a reverse `employees.user_id`; that would have created two links that can disagree — the exact second-source-of-truth flaw I was criticising the brief for. **Removed from the migration.** The real gap is data: `ranjeet@anutech.in` has an employee record (Ranjeet Raj) but no `employee_id` on his login — one UPDATE in HR, not a migration.
>
> **2. `/performance` and `/scorecard` already exist**, and [performance.ts](production/src/lib/queries/performance.ts) already scored outcomes against `PERF_WEIGHTS`, already floored the score at zero, already showed a per-person breakdown, and already converted score to cash by **splitting a bonus pool proportionally**. The outcome-based architecture I "recommended" was already the architecture. I had written a parallel engine (`points.ts` + `incentive.ts`, 52 tests) — **deleted**, because two scoring systems deciding pay is the failure, not the feature.
>
> **On the ₹ rate.** Pardeep set 1,000 pts = ₹1,000. Measured against real data (30 days: 52 payments, ₹69,55,963 collected, 54 qualified leads) the brief's scale yields **4,376 points ⇒ ₹4,376 for the whole team**, ~₹600 each — too small to change behaviour. It is also insensitive: 3× the revenue only reaches ₹5,767, because the flat per-payment component dominates. The existing **pool ÷ share** model was kept instead: the payout is bounded by what the business decided to spend.
>
> **⚠ Still-open gaming vector, flagged not fixed** (weights are Pardeep's call, documented in `PERF_WEIGHTS`): `paymentRecorded: 5` pays per payment ROW, and staff choose how to record a collection. One payment of ₹1,00,000 scores 25 pts; the same ₹1,00,000 as 10 × ₹10,000 scores 70 — **2.8× for identical rupees**, and score splits cash. `paymentRecorded: 0` closes it at no other cost, since `revenuePerRupees` already rewards collecting.

**Already existed, so the brief shrank:** `0121_salary_incentive.sql` is applied and already delivers directive 5's DB half — `salary_payments.incentive` plus `pay_salary(..., p_incentive)` folding it into earned/net and booking the Salaries expense. The work is feeding a number into that parameter, not building it. And `pay_salary` is run by a human, so **an approval gate already exists** — points can never auto-pay.

**The flaw that had to be fixed first.** The brief awards points for completing tasks, and points become cash. But `tasks.kind` is only `call · email · meeting · followup · custom` — none of the money-bearing types (Lead Qualified, Quote Sent, Payment Recovered, Project) are tasks; they are events the system already records. Self-created + self-completed + converts to cash = **self-issued salary**: create "Payment Recovered — ₹5,00,000", mark it done, earn real money with nothing collected. **Decision: the money tiers derive from the ledger** (`payments.recorded_by` — 52/52 attributed · `quotes.owner_id` · `leads.owner_id` / `lead_activities.created_by`). A payment cannot exist without money landing. Tasks still earn, but only the 10-point tier.

**The blocker for directive 5.** `employees` had **no** `user_id`; tasks belong to `users`, payroll pays `employees`, and the only join was a nullable email. Measured: 6 of 10 employees matched a login. **4 staff (KESHAV MALIK, PRASHANT, Darshan, Deepak Sharma) had no login → could never earn a point.** `sales@anutech.in` (role `sales_senior` — exactly the target user) had **no employee record → points could never become a bonus.** `0231` adds the column; the rows still need populating.

**Four design corrections, agreed with Pardeep:**
- **Lateness removes the reward, never creates a debt** (floor 0). The brief's −10%/day with no floor is −300% at 30 days, which eats other earnings and pushes a month's incentive negative — a Payment of Wages Act §7 problem, not just a UX one.
- **"Payment Recovered" bounty replaced.** Paying for *recovery* pays more the longer an invoice rots. Applying lateness instead means a 7-month-old collection scores zero, so nobody chases old debt. Rule adopted: **early collection earns +20%, late collection earns full base.** (My first implementation applied lateness to payments, contradicting its own comment — the test `is never reduced for lateness` caught it.)
- **Kudos are budgeted per giver** (10/month). Uncapped, two colleagues awarding each other 10/day print 300 points of cash a month each. Self-kudos rejected in code *and* by a DB constraint; RLS allows insert only with `awarded_by = auth.uid()`.
- **Ultimate Teammate needs kudos from 3+ different people** — a bare count is earnable by one friend clicking five times.

**Deliberately NOT built as specified:** `tasks.assignee_id` (duplicates `owner_id`; added `delegated_by` instead — the fact actually missing) · `collaborators uuid[]` (an array can't be FK'd or carry per-collaborator kudos → `task_collaborators`) · `tasks.performance_points/bonus/penalty` (a second source of truth that drifts from the engine and can be edited to mint points; derived instead, and **frozen only at payout** via new `salary_payments.performance_points`) · `kudos_count` (a counter that drifts from the rows it counts).

**Delivery reality:** `GUPSHUP_API_KEY`, `WHATSAPP_TOKEN`, `META_APP_SECRET` are all absent → "instant WhatsApp alert on task share" would be the 5th feature in this repo that logs and never sends. In-app bell works. Supabase Realtime is used **nowhere** in the codebase; TanStack Query polling gives ~95% of a live thread at a fraction of the risk.

**Done — added INTO the existing system, not beside it:**
- [gamification.ts](production/src/lib/performance/gamification.ts) — peer kudos with a **per-giver budget** (10/period; uncapped, two colleagues awarding each other 10/day print 300 pts of cash a month each), self-kudos rejected, order-independent tally, and 4 badges. `Ultimate Teammate` requires kudos from **3+ different people** — a bare count is earnable by one friend clicking five times.
- [gamification.test.ts](production/src/lib/performance/gamification.test.ts) — **21 tests**. Suite **657 passed, 0 failed**. Typecheck + lint clean.
- [performance.ts](production/src/lib/queries/performance.ts) — extended: `scope: "month" | "week"` (weekly board is always *this week*; a month holds 4–5 weeks so the month picker cannot narrow it), kudos folded into score + breakdown, `renewalPayments` joined via `quotes.is_renewal` **by flag not by date** (a payment this week can settle a quote raised months ago), badges per row. `PerfRow` additions are optional so `/scorecard` compiles untouched. `task_kudos` read is error-checked so the page still renders **before** 0231 is applied.
- [performance/page.tsx](production/src/app/(app)/performance/page.tsx) — week/month TabBar, badges on each card, kudos in the summary line, weights footnote updated. Month picker hidden in weekly view rather than left as a control that does nothing.
- [database.types.ts](production/src/lib/supabase/database.types.ts) — `task_collaborators`, `task_comments`, `task_kudos` types.
- [20260821090000_performance_points.sql](production/supabase/migrations/20260821090000_performance_points.sql) — ✅ **applied 21 Aug 2026** (was `0231`) — `tasks.delegated_by/at`, `task_collaborators`, `task_comments`, `task_kudos` (one-per-giver-per-task + no-self-kudos as DB constraints; RLS insert requires `awarded_by = auth.uid()`, because kudos are cash), `salary_payments.performance_points`, 10 RLS policies, separate verify block.

**Not done yet:** ~~apply `0231`~~ (done 21 Aug) · set `employee_id` on `ranjeet@anutech.in` · task share/delegate modal · comment thread with @mentions · a way to actually award kudos in the UI (the tally and schema exist; the button does not) · wire the pool split into `pay_salary`'s `p_incentive`.

**Two tiers from the brief cannot be scored at all, for measured reasons:** `quotes.owner_id` is empty on **0 of 52** quotes, so "Quote sent +30" has no one to credit (the existing `quotesSent` metric is therefore always 0 for everyone); and `project_milestones` has **no actor column**, so a completed milestone records nobody. Both need a data/schema change before they can pay.

**Delivery reality:** `GUPSHUP_API_KEY`, `WHATSAPP_TOKEN`, `META_APP_SECRET` all absent → "instant WhatsApp alert on task share" cannot deliver; it would be the 5th feature here that logs and never sends. Supabase Realtime is used **nowhere** in the codebase, so a live thread means either adopting it or polling with TanStack Query (~95% of the value, a fraction of the risk).

### 🗺️ 14-day 4-phase plan (Pardeep, 13 Aug 2026) — AUDITED AGAINST CODE BEFORE COSTING. 5 of 11 already built · 1 no-op · 3 credential-blocked

Every line below was verified against the repo, `.env.local` key presence and the live health endpoint — not estimated from the brief. §25.1: docs are hypotheses, code is truth.

| Phase item | Verified status |
|---|---|
| Envelope encryption AES-256-GCM | ✅ **built** — `src/lib/crypto/vault.ts` + `tenant-secrets.ts` + 2 test files. Only `SECRETS_MASTER_KEY` is missing, so secrets sit in clear. **One env var, not a 3-day build.** |
| RLS / SECURITY DEFINER audit | ✅ **done** — all 110 SECURITY DEFINER functions audited in prod; one real cross-tenant leak fixed and prod-verified (`0226`). The brief's `auth.jwt() ->> 'tenant_id'` premise would break **150 live policies**; isolation runs on `public.current_tenant_id()`. |
| GitHub Actions CI | 🟡 **exists** — typecheck + test + lint + no-auth Playwright smoke. Real gaps: no feature-branch trigger, lint/e2e are `continue-on-error`, and **70 auth-gated e2e tests self-skip** for want of `NEXT_PUBLIC_SUPABASE_ANON_KEY` + seeded tenants. |
| Google / Microsoft CSP adapters | ❌ not built, **blocked** — needs an approved Google Cloud Partner reseller agreement and Microsoft Partner Center MPN + admin consent. Not obtainable by a developer. |
| ClearTax / NIC e-Invoicing (IRN + QR) | ❌ not built. `CLEARTAX_API_KEY` absent. **Applicability unconfirmed** — mandatory only above ₹5 cr aggregate turnover. Awaiting Pardeep's figure. |
| Setu AA live reconciliation | ✅ **built** — `src/lib/aa/setu.ts`, `/api/aa/setu/{consent/init,callback,fetch/[connectionId]}`, plus a simulate-approval page. `SETU_CLIENT_ID` absent → simulation mode. Going live needs **FIU registration with an RBI-licensed AA** — a regulated onboarding, not code. |
| Cloud Tasks / QStash migration | ⚠️ **premature** — Cloud Scheduler already runs 6 jobs (verified 200). Cloud Tasks solves per-item fan-out with retries, a different problem. At 5 tenants / 54 subscriptions it adds failure surface for no gain. |
| Sentry standardisation | ✅ **done** — CLAUDE.md §22; `lib/sentry.ts` imported from the `supabase/server.ts` chokepoint, plus `global-error.tsx` and `(app)/error.tsx`. |
| PgBouncer connection pooling | ❌ **no-op** — there is no direct Postgres client in this codebase; everything is PostgREST over HTTPS. PgBouncer pools direct PG connections. It would do nothing. |
| Onboarding wizard + sample seeder | 🟢 **genuinely missing and worth building.** `/setup` exists but there is no 5-step wizard and no in-app seeder. Directly useful: the seeder is what the test-data reset needs. |
| Portal self-serve + Razorpay checkout | ⚠️ portal exists (`pay-invoice-button.tsx`), but `RAZORPAY_KEY_ID` and the webhook secret are absent — the **collect-without-reconcile** critical state. Checkout on top of that means money moves and the app never learns. |
| Sub-50ms Ctrl+K palette | ✅ **done this session** — `src/lib/search/keywords.ts` + palette keywords. Measured: a server round trip is 70–118ms, so sub-50ms is only reachable client-side, which is what was built. |

**The plan's biggest hole: `RESEND_API_KEY` is not in it.** The live health endpoint returns `email-not-configured` at **critical** severity right now — *"a renewal can lapse with the app showing that the customer was reminded six times."* Fourteen days of security, CSP, queue and portal work were scheduled around the one env var that makes a renewals business function.

**Revised order** — Day 0 (30 min, zero code): `RESEND_API_KEY` + `SECRETS_MASTER_KEY`, both of which switch on code that is already written and already tested; best value-to-effort in the whole plan. Day 1: CI feature-branch trigger + seed test tenants → unlocks the 70 skipped e2e tests (`scripts/setup-e2e-tenants.mjs` already exists). Day 2–4: onboarding wizard + sample seeder. Day 5–6: Razorpay **reconciliation first**, checkout second. Put the CSP / GSP / FIU **paperwork** on the critical path today and write those adapters when credentials arrive — a fourth unverifiable integration would repeat the pattern. Drop PgBouncer and Cloud Tasks.

### 📋 Subscriptions page — the information that was on screen vs the information that exists — ✅ DONE (localhost, test-green + browser-verified, awaiting deploy)

Pardeep: *"subscription se related jo bhi jaruri information hai jo yaha dikhni chahiye wo sab show karo."*

**Measured first** (prod, tenant `fbb976f1-9090-…`, 54 rows, 13 Aug 2026) instead of guessing which columns to add:

| Field | Reality across all 54 rows |
|---|---|
| `status` | all `active` |
| `auto_renew` | all `true` |
| `renewal_state` | all `pending` |
| `reminder_count` / `outstanding_amount` / `used` / `is_urgent` | all `0` / `false` |
| term (`start_date`→`renewal_date`) | all **12 months** |
| renewal horizon | all **181–365 days out** |
| `domain` | **9 rows empty** |

Two real defects fell out of that, both on the mobile/tablet card (`xl:hidden`):

1. **The day-count never rendered.** The `Xd` badge was gated at `dl <= 30` and nothing is inside 30 days — the page's own "Expiring 30d" tab reads **0**. So the card showed a bare `23 Jul 2027` and left the reader doing date arithmetic on a phone. The whole T-30/15/12/9/6/3/0 cadence turns on that number.
2. **`₹1,350 /mo` implied monthly billing** on a subscription that is annual. The money that actually changes hands at renewal is **₹16,200**, and it appeared nowhere on mobile.

Fixed, plus five fields that were unreachable from this page on **mobile *and* desktop** (`auto_renew`, `renewal_state`, `reminder_count`, `suspended_at`, `written_off_at`).

**Deliberately conditional, not always-on.** Those five are identical on all 54 rows today, so rendering them unconditionally = 54 identical badges = noise. They render only on deviation — free today, loudest thing on the row the day one goes wrong. `auto_renew: false` leads, because nothing else catches a subscription the cron will silently lapse to `expired`.

**Two things deliberately NOT shown** (same rule — don't assert what isn't measured):
- **Seat utilisation** is gated on `used > 0`. `used` is 0 on every row because seat counts aren't synced from the vendor yet, so "0 of 5 in use" would claim idle licences that are probably fine.
- **Margin** is not on the card at all. `estimateMargin()` is `mrr * 0.83` — a hardcoded heuristic that returns **17% for every subscription that has ever existed**. I put it on the card, saw 54 identical "17% margin" badges in the browser, and removed it. It is a fabricated constant dressed as data.

Files: [subscriptions/page.tsx](production/src/app/\(app\)/subscriptions/page.tsx) · new [lib/subscriptions/exceptions.ts](production/src/lib/subscriptions/exceptions.ts) · new [lib/subscriptions/renewal-display.ts](production/src/lib/subscriptions/renewal-display.ts)

**Why the logic sits in `lib/` and not in the component:** none of the exception branches fire against today's production data, so a bug in any of them would look exactly like silence on screen — this repo's signature failure mode. And `term().months` multiplies MRR into a rupee figure the operator reads, so misreading a quarterly term as annual would overstate the renewal by 4×. Both are now test-backed: **35 new unit tests, suite 601 → 636, 0 failed.** Typecheck + lint clean. Card and table both browser-verified in a tab opened after the last edit (zero console errors).

**Still open, needs Pardeep's call (money display, so not changed silently):** the header KPI reads **`MARGIN (ARR) ₹7.1L (17%)`** and **`SEATS IN USE 0 / 731`**. Both come from the same untracked sources — the 17% is the hardcoded heuristic, and 0/731 asserts that 731 licences sit idle. Options: label them as estimates, hide until real cost/seat data syncs, or leave as-is.

### ✅ SECURITY: cross-tenant read in `bank_account_current_balance` — FIXED & VERIFIED IN PROD (0226)

Found by auditing all **110 SECURITY DEFINER functions** in prod (read-only MCP).

**The audit's good news first:** every one of the 110 sets `search_path` — **zero** missing. That part of an enterprise hardening checklist is already 100% done, and `0145`'s deny-by-default EXECUTE posture is holding (`record_payment` is not anon-callable).

**The one real hole:** `bank_account_current_balance(p_account_id uuid)` is `SECURITY DEFINER` — so **RLS does not apply inside it** — and it took an arbitrary account UUID with **no ownership check at all**. EXECUTE is granted to `authenticated`, so any signed-in user of any tenant holding or guessing a `bank_accounts.id` could read another tenant's balance. The only protection was UUID secrecy: obscurity, not isolation.

**Impact today is nil** — exactly one tenant has bank accounts (2 rows). It is a **latent** hole that goes live the moment a second tenant adds one, and prod already hosts other real tenants (Client C). `0226_bank_balance_tenant_guard.sql` scopes **both** halves (account row *and* its transactions — filtering only the account row would still leak, because a foreign id would then sum ITS transactions). Grants stay `authenticated`-only; **not** granted to service_role, since `current_tenant_id()` is null there and it would return a silent 0 — a wrong number is worse than a missing one. Both callers are authenticated client reads, so no app change is needed.

**Also worth a look, not fixed:** `accept_project_quote(uuid)` has no tenant scoping. Its sibling functions (`create_project_quote`, `raise_project_milestone_invoice`) both scope by `current_tenant_id()`, and in the normal flow it only ever receives a project id created moments earlier in the same transaction — but called directly with a foreign id it would accept another tenant's quote. Worth an explicit guard.

**⚠️ Correction to the brief:** it specifies tenant checks via `auth.jwt() ->> 'tenant_id'`. **That would break every policy in this database.** `tenant_id` is not in the JWT here — isolation runs through `public.current_tenant_id()`, which reads `public.users`, and **150 live policies** depend on it. `0226` uses `current_tenant_id()` accordingly.

### 🟡 Pipeline features (Pardeep's 5) — #1 already existed · #3 + #5 DONE · #2 + #4 pending

**#1 WhatsApp 1-click — already built, nothing to do.** Kanban card has a WhatsApp button (`getLeadWhatsAppUrl`), list rows have the icon, and the mobile card has a left-swipe → WhatsApp gesture with a pre-filled message. **46 buttons live** on /deals.

**#3 Hot/Warm/Cold + #5 Stale warnings — DONE, on all three surfaces.** The features themselves were small; the actual work was that **four conflicting definitions of "hot"/"stale" already existed**:

| Where | Old rule |
|---|---|
| `lib/leads/heat.ts` | `priority==='high' \|\| stage in demo/trial/quote` |
| `lead-card.tsx` (kanban) | `(quote\|trial \|\| ≥₹1L) **&&** priority==='high'` — stricter, so a lead read Hot in the list and plain on the board |
| `lead-card.tsx` stale | `created_at` + 7d — measured the lead's **AGE, not neglect**: a lead created 30 days ago but worked on yesterday showed "30d" |
| `leads/page.tsx` ×2 + `swipe-lead-card` | `updated_at > 14d` |

All four now route through `lib/leads/heat.ts`. Added there: `daysSinceTouch` · `intentTier` · `intentMeta` · `staleWarning`, with **19 tests** (suite 234 → **253**).

Two decisions worth keeping:
- **Cold outranks Hot.** A ₹2L deal untouched for 3 weeks is *at risk*, not on fire — calling it Hot is how it keeps getting ignored.
- **Stale fires at 7d, Cold at 10d** — deliberately different, so the nudge arrives while there is still a window to save the deal. A test asserts `STALE_DAYS < COLD_DAYS`.

`daysSinceTouch` returns **null** (not "stale") when there's no usable timestamp, so a freshly imported lead isn't scolded on day one. It prefers a real `lead_activities` timestamp when the caller has one, else `updated_at`.

**Browser-verified** on /deals: 48 leads, every row carries exactly one intent badge (13 Hot / 35 Warm in the table). **Cold + stale render 0 today because every lead in prod has a recent `updated_at`** — those paths are covered by unit tests, not by eye. typecheck clean, lint 0 errors.

**#4 Loss reason — code DONE, ⚠️ BLOCKED on the migration (Pardeep must apply it).**

- **`0225_lead_loss_reason.sql`** (written, **not applied** — read-only MCP): `lost_reason` (CHECK-constrained to 6 codes, matching how this schema already does small value sets) · `lost_note` · `lost_at`. `lost_at` is separate from `updated_at` because any later edit moves `updated_at`, so "lost in the last 90 days" would be unanswerable. **No backfill** — deals already sitting in `lost` genuinely have no reason, and inventing one would fabricate the very analytics this exists to make trustworthy; they report as "Not recorded".
- **`lib/leads/loss-reasons.ts`** — the 6 codes + `lossBreakdown()` rollup, **12 tests**. A test asserts the code list matches the migration's CHECK exactly, so the dialog can't offer something the DB rejects.
- **`LossReasonProvider`** (mounted globally, modelled on `ConfirmProvider`) — one tap saves; "Other" waits for a note; **dismissing cancels the move** rather than recording an unexplained loss.
- **`useChangeLeadStage()`** — the chokepoint. Stage was changed from **7 call sites across 3 components**; all now route through this hook, so the prompt exists in one place. Bulk moves ask **once** for the whole selection, not once per row.
- Moving a lead OUT of `lost` clears the fields, or a revived deal keeps a stale reason and quietly poisons the analytics.

Suite 253 → **265 green**, typecheck clean, lint 0 errors.

**#4 analytics surface — DONE.** `LossReasonsCard` on the Deals tab: reasons ranked by **value lost, not count** (one ₹5L competitor loss outranks five ₹10k price losses — count-sorting buries exactly that), with 90-day / 1-year / all-time windows. Un-recorded losses are shown, never dropped, and when they're the majority the card says *"not yet a reliable picture"* rather than letting the owner read a conclusion out of missing data. **7 component tests** (32 files / **300 tests** green).

✅ **Migration 0225 APPLIED & VERIFIED IN PROD (2026-08-13)** — `lost_reason, lost_note, lost_at` present (lead columns 29 → 32), CHECK constraint live with the 6 codes matching `loss-reasons.ts` exactly, partial index created. 7 lost deals now able to carry a reason.

**Why it took four attempts, recorded so it doesn't repeat:** the Supabase SQL editor runs a pasted script as **one transaction** — if any later statement fails, *everything* rolls back, including the `ALTER` that succeeded. Repeated "apply kar diya" reports were genuine; nothing survived. Running the statements in **small separate batches** worked first time. (My own diagnostic was also wrong once: I suggested `current_database()` to tell projects apart, but it returns `postgres` for every Supabase project — the project ref in the dashboard URL is the real discriminator.)

`database.types.ts` updated **by hand**, not regenerated: the file's own header says *"hand-maintained"* and it carries **112 hand-added convenience types** (`LeadPriority`, `LineCommitment`, …) that `supabase gen types` would wipe. The `as unknown as LeadUpdate` cast is gone. ⚠️ **Also not browser-verified:** the dev server came up on a new port, and Supabase keeps its session in `localStorage` (per-origin, port included), so the app was logged out. I won't enter credentials. No render errors on mount — only 401s from the missing session.

**After applying 0225:** regenerate `database.types.ts` and drop the one `as unknown as LeadUpdate` cast in `useUpdateLeadStage` (commented in place).

**#2 Inline-edit spreadsheet view — DONE.** Stage · Deal Value · Priority · Follow-up date are all editable in the row; the four fields a rep changes most no longer need the drawer. Two new columns added (Priority, Follow-up) with widths rebalanced so they still sum to 100% — no horizontal scrollbar.

**Deal Value feeds the Open Pipeline KPI, so the parsing is where the care went** (`lib/leads/inline-edit.ts`, **19 tests**):
- Accepts what a reseller actually types: `50,000` · `₹1,50,000` · `1.5L` · `2 Cr`
- **Rejects rather than guesses** — `abc`, `50k`, `-5000` fail with a reason and nothing is written. No silent coercion to 0/NaN.
- **Empty = cleared (null), not ₹0** — an unpriced deal must not count as a zero-value one in the pipeline total.
- Refuses anything over ₹100 Cr: an extra zero is far likelier than a real order, and it would visibly distort the KPI.
- Follow-up dates are stored verbatim as `YYYY-MM-DD` — converting to UTC is how "tomorrow" becomes "today" for an IST user. `2026-02-31` is rejected, not rolled forward.

**Interaction contract** (`InlineCell`, **9 component tests**): click/Enter/F2 to edit · Enter or blur saves · **Esc cancels and beats the blur that fires with it** (the classic bug where cancelling still saves) · invalid input keeps the cell open with the reason · **an unchanged value writes nothing at all**. Optimistic with rollback, and `useUpdateLead({ quiet: true })` so working down 50 rows doesn't fire 50 toasts.

Component tests run under a per-file `@vitest-environment jsdom` directive — the global config stays `node` so the rest of the suite keeps its speed.

Suite 265 → **293 green**, typecheck clean, lint 0 errors.

⚠️ **Not browser-verified.** Each dev-server restart lands on a new port, and Supabase keeps its session in `localStorage` (per-origin, port included), so the app was logged out and I won't enter credentials. The interaction is covered by the 9 component tests instead, which is repeatable in a way a manual click isn't — but a human should still click through it once.

### 🔴 UX / behaviour audit — "prevention is engineered, recovery is not". → [docs/UX-AUDIT.md](docs/UX-AUDIT.md)

Not a repeat of the layout rounds below (those were padding/max-width/mobile-cards). This asks what happens to a *person*: defaults, attention, and what they see when something breaks.

> **The finding in one line:** this app prevents errors beautifully (smart defaults, DB guards, atomic RPCs, styled confirms) and gives you **nothing** when one happens. §24 is the project's own rule — *"reason + next step + button"* — and it is followed **1 time out of 278**.

| # | Finding | Sev |
|---|---|---|
| **G1** | 🟡 **money spine FIXED.** Built `lib/errors/toast-error.ts` — branches on message **TEXT, not error code**, because our guards raise good copy *with* a technical errcode attached (a code-based rule would have destroyed it). 7 plumbing patterns → plain English + a "why"; everything else passes through. **54 sites migrated** (money-spine query modules + `quotes/[id]`); raw dumps **208 → 160**. Found while migrating: **the blocked-delete path on `quotes/[id]` was bypassing a dialog that already existed** — the very dialog §24 cites as its example — and toasting a bare reason instead. No grep would have caught that; only reading did. ⚠️ **Also corrected my own audit number: the "278" was `.tsx`-only; the true total is 452.** 160 remain in non-money modules, same mechanical pattern. | **P0** |
| ~~**G3**~~ | ~~`toLocaleString()` with **no locale** in 10 places → on an en-US browser money renders `₹1,560,000` instead of `₹15,60,000`.~~ **✅ FIXED** — 9 sites → `rupee()` (which never touches locale), 1 foreign-currency site pinned to `en-US` (that one was **persisted as an FX audit note**, so the same bill wrote a different note per machine). **Bonus bug fixed:** `rupee()` rendered −100…−999 as `₹-,500` (stray comma) — and negative ₹ is real, `gstPayable` can be a credit. **Coverage gap closed:** `rupee()` had 900+ call sites and **zero tests**; added 18. Suite 196 → **205 green**. | ~~P0~~ |
| **G2** | `record-payment-dialog` = **21 controls**, ~3 conditional. The 90%-of-the-time fields (amount/method/reference/date) carry the same weight as the 10% ones (TAN/TDS section/domain). People satisfice → a guessed TDS field becomes a wrong ledger row (`0150` posts it atomically). **Fix staging only — the defaults are the best thing on the screen.** | P1 |
| **G5** | 58 nav items / 11 sections. Role filtering + collapsible groups mitigate it, but the *owner* — who decides whether to pay — sees nearly all of it on day one. A first-run decision, not a bug. | P1 |
| **G4 / G6** | 3 files still on `window.confirm` (one is quote detail, a money screen) · 22 emoji-as-icons, 16 in `vendor-portal`, one in a money-dialog **label**. | P2 |

**Why the asymmetry exists (and why it inverts):** prevention is visible to whoever builds the feature; recovery only shows up when a real user gets stuck. So far the only real user is Pardeep, who can read a Postgres error. **The first paying customer will never notice the prevention and will only notice the recovery.**

**Order:** G3 first (10 call sites, wrong numbers, invisible locally) → G1 via a shared `toastError()` helper migrated by blast radius, money screens first (§7 of the doc has the approach) → G2 staging → G4/G6 bundled into a single `vendor-portal` cleanup pass.

**Verified STRONG, for balance:** only **12** hardcoded-colour occurrences in the whole authenticated app (§5 genuinely followed) · `useConfirm()` dialog used in **50** places · `rupee()` used **919** times · payment amount auto-locks to `remaining − TDS − credit` until hand-edited, killing a whole class of rounding disputes (`record-payment-dialog.tsx:237`) · success toasts report what's *still due*, not "saved".

⚠️ **Boundary:** code-measured only. **Screens were never viewed in a browser** (dev server stalled), so there is **no** judgement here on visual hierarchy, contrast, spacing or real mobile feel, and `design-critique` / `accessibility-review` (§0.9) were not run. Those are still owed.

*§6 of the doc lists 3 **false alarms** (things a quick grep makes look broken but aren't) — read it before filing new findings; grep consistently reads this codebase worse than it is.*

### 🟡 Off-database backup — first one taken, but NOT yet a real DR plan → [docs/BACKUP.md](docs/BACKUP.md)

Dashboard showed **`LAST BACKUP: No backups`** on a DB holding **₹57,30,703 of invoices and ₹52,08,253 of payments**. Free plan = no automatic backups, no PITR. The in-app snapshots (`0210`–`0212`) write to `backup.snapshots` — **a table inside the same database** — so they survive a bad UPDATE but not the loss of the database. An undo button, not a backup.

**Done:** `npm run backup:db` (`production/scripts/backup-db.mjs`) runs through the **read-only** MCP, so it can never write to prod. Output goes to `C:/dev/resellersos-backups/` — **outside the repo**, because the dump holds customer PII. Verified capture: 80 tables · 1,210 rows · 253 RLS policies · 126 function definitions · 46 triggers · 275 indexes · the applied-migration ledger. ~1.4 MB.

**Bug caught while building it:** the first version used `information_schema.triggers`, which only reports triggers on tables the caller owns — it returned **0** while **46** exist. A silently incomplete backup is worse than none, because you stop worrying. Now reads `pg_trigger`.

**Drift, finally quantified:** prod's migration ledger has **247** records; git has **194** files; **190 prod records have no matching file** (mostly Studio/MCP descriptive names for changes later folded into `0003`/`0146`). ⇒ **git alone cannot reconstruct prod** — which is why the backup dumps live schema rather than trusting the migration files.

**🔴 Restore rehearsal attempted — and it found a blocker before the rehearsal even started.** No Docker / psql / local Postgres here, so instead of asking anyone to install a stack, `npm run backup:check` asked the cheaper question first: *could a restore work at all?*

> **No. 11 tables exist in prod that git's migrations cannot create — 6 hold data, including `contacts` with 58 rows.** `contacts` is ALTERed by 6 migrations and **CREATEd by none**; `support_plans`, `campaign_templates`, `prepaid_advances`, `support_sync_outbox` aren't in git at all.

Same drift as `0003`/`0146`, now measured exactly. Backup also gained **430 constraints** the same day — without them it knew a table's columns but not its rules.

**✅ FIXED — `0224_capture_remaining_drift.sql` generated from the live catalog** (750 lines: 11 tables · 163 columns · 54 constraints · 41 indexes · 30 policies · 5 triggers · **9 functions**). Idempotent, so applying to prod is a no-op.

> **🟢 FAISLA (21 Aug 2026): apply NAHI karni — `baseline.sql` ne ise superseded kar diya. Ye file band samjho.**
> Teen cheezein naapi gayin, andaza nahi:
> 1. **Prod me kuch missing nahi** — 11/11 tables maujood (`to_regclass`). To apply karna sach me no-op hai, sirf kagaz par nahi.
> 2. **Rebuild ko iski zaroorat nahi** — `npm run db:rebuild` → `scripts/rebuild-db.mjs` sirf `baseline.sql` + `baseline-storage.sql` chalata hai, aur `baseline.sql` me **11/11 `CREATE TABLE` maujood hain**. Jo gap 0224 bharne ke liye likhi gayi thi (fresh DB me `contacts` ki 58 row rakhne ki jagah na hona), wo gap **band ho chuka hai**.
> 3. **Timeline se wajah saaf hai** — 0224 **13 Aug** ki hai; `baseline.sql` **15 Aug** ko prod se dobara dump hui, do din baad, wahi 11 tables uthate hue. Isliye redundant hai, galat nahi.
>
> ⚠️ **Yahan naapne ka tarika galti se chala tha, aur wo bachane layak hai.** Pehla grep `create table (if not exists )?(public\.)?"?x"?` tha aur usne kaha **11/11 baseline me NAHI hain** — theek ulta. Kyunki `baseline.sql` `CREATE TABLE IF NOT EXISTS "public"."x"` likhta hai, **schema bhi quote me**. Pakda tab gaya jab `quotes` par sanity-check chalaya — wo bhi "nahi mila", jo asambhav hai. **Sabak: schema ke grep ko ek aise object par tolo jiska hona pakka hai, warna false negative "kaam bacha hai" ban jata hai** — aur yahan wo 750-line ki bekaar prod DDL banti.

Two things the generation caught that a hand-written file would have missed:
- **The drift went past tables into functions.** 9 prod functions have no definition in git — 3 back triggers created here (§5 would have failed on a fresh DB without them) and two are money-adjacent RPCs the reimbursements feature calls: `settle_reimbursement`, `delete_reimbursement`. Verified none overlaps a git function, so nothing is overwritten.
- Generated with `format_type()`, not `information_schema.data_type`, which flattens enums to `USER-DEFINED` and arrays to `ARRAY` — `contacts.tags text[] default '{}'` would not have round-tripped.

**Verified:** `npm run backup:check` went from `in prod but NOT in git: 11` → **`0`**. Git can now rebuild the full prod schema. *(Third time this drift class has needed cleanup after `0003` and `0146` — the read-only MCP config exists so there isn't a fourth.)*

**⚠️ Still not covered:** no `pg_dump` (restore = rebuild schema + re-insert JSON in FK order, **never rehearsed**) · `auth.users` NOT captured (**8 FK references point at it**) · storage buckets (TDS certificates, receipts, logos) NOT captured · **manual, nothing scheduled** · no PITR.
**Real fix = Supabase Pro (~$25/mo)** for daily backups + 7-day PITR covering auth and storage — or `supabase db dump` (CLI installed v2.114.0, but project not linked; needs the DB password). **And rehearse one restore** — until then the backup's value is unproven.

### ✅ Prod verified via read-only Supabase MCP — F1 + F2 FIXED, two dead migrations removed (2026-08-12)

Read-only Supabase MCP is configured (`--read-only --features=database,docs`, so `apply_migration` doesn't exist). Everything below moved from **reasoned-only → measured**.

> ⚠️ **19 Aug 2026 — ye ab `.mcp.json` nahi hai.** Wo file `"${SUPABASE_ACCESS_TOKEN}"` likhti thi jo expand hota hi nahi, isliye wo server har call par `Unauthorized` deta tha; file hata di gayi. Read-only raasta ab user-scope wala `supabase-db` server hai, aur likhne ka kaam Supabase CLI se hota hai. Dekho [docs/WORKING-ENVIRONMENT.md](docs/WORKING-ENVIRONMENT.md) §3.

**Balance Sheet was overstating equity by ₹7,02,550.** Two errors, opposite directions, same statement — and the Equity plug meant it always "balanced":

| | Before | After |
|---|---|---|
| Trade receivables | **₹0** | **₹97,639** (accrual: unpaid invoices, project ones excluded) |
| Advances from customers | *(line didn't exist)* | **₹8,00,189** (12 payments — customer money that read as profit) |

Fixed in `useBalanceSheetAuto()` — query-layer only, **no migration**. Two pure helpers extracted (`computeTradeReceivables`, `computeCustomerAdvances`) + **8 tests**, including the double-count trap. Suite **226 → 234 green**.

⚠️ **I had F2's number wrong in the audit.** It implied ~₹7.82L was missing; ₹6,85,000 of that is project-milestone invoices `projectReceivable` already counts, so the naive fix would have **double-counted**. Real gap: ₹97,639. Corrected in the doc.

**F3 / F4 / F6 measured at ₹0** (no fixed assets, no open customer credits) — real design gaps, zero present impact, correctly deferred. This is exactly why the audit's step 1 was "run the query", not "fix the code".

**Two dead migrations deleted, not applied** → git and prod are now in sync at `0223`. Full reasoning in [supabase/migrations/README.md](production/supabase/migrations/README.md):
- `0224` granted EXECUTE to `anon`+`public` — the direct opposite of `0145`'s P0 security fix. The grants that matter (`authenticated`) were already live and verified.
- `0225` created a table the feature never uses — Employee Advances deliberately runs on `expenses` ("zero-migration compatibility"). It also used `NUMERIC(14,2)` where all money is `integer` ₹, and inlined its RLS tenant check instead of `current_tenant_id()` (**150 prod policies use the function**) — which would have silently kept single-tenant behaviour when multi-company lands.
- **My own error, recorded:** I first called this a P0 broken feature. All 4 "references" to that table were TanStack **cache keys**, not DB calls. Third time this session that grep pointed the wrong way — see [UX-AUDIT §6](docs/UX-AUDIT.md).

**Tenancy question SETTLED — my analysis held.** RLS is enabled on every core table (4–6 policies each) and `record_payment` is not anon-callable, so **no live cross-tenant leak** and the `.or()` fallbacks are **confirmed dead code**. But prod has **5 tenants** and `use-workspace.ts` is worse than described: `606a7ae7` is hardcoded as "Client A" and is actually **Client C — a real separate tenant with its own user, invoice and payment**; the real Client A (`13a364c7`) isn't in the hook at all, so its data displays under Anutech. All real business (34 customers / 62 leads / 39 quotes / 26 invoices / 8 users) sits in **one** tenant, Anutech Digital.

**Still open from this session:** off-database backup (dashboard shows **`No backups`**; the in-app snapshots live *inside* the same DB, so they're an undo, not a backup) · `tenants.doc_code = 'ET'` sits on **Anutech Digital**, and 4 of 5 tenants have `doc_code = NULL` — worth confirming GST invoice series are labelled with the right legal entity.

### 🔴 Financial statements audit — 3 P0s found. FIRST STEP IS A QUERY, NOT A FIX. → [docs/ACCOUNTING-AUDIT.md](docs/ACCOUNTING-AUDIT.md)

Controller-grade audit of the **statements** (the transaction spine was already green — different question, different failure modes). Books-lite design is fine; the plug hides errors:

> **Equity = Assets − Liabilities**, so the Balance Sheet can never fail to balance. In double-entry a non-balancing trial balance is the smoke alarm; here it's disconnected — any error flows silently into "retained earnings" and reads as profit.

| # | Finding | Sev |
|---|---|---|
| **F1** | Customer advances have **no liability line** — advance cash is an asset, revenue correctly unrecognised, but nothing offsets it → the plug reports it as earnings. Systematic, because annual-advance collection *is* the business model. | **P0** |
| **F2** | Balance-sheet receivable uses `subscriptions.outstanding_amount`; P&L + Aging use invoices (accrual). Unpaid **direct invoices** show ₹0 on the sheet; un-invoiced amounts get counted. Revenue ↔ receivables cannot be tied. | **P0** |
| **F3** | **No depreciation in the P&L** — it exists only as a manual Balance Sheet contra line with no P&L link. Net Profit + taxable income overstated. | **P0** |
| **F4** | `/accounting/assets` reads `useEmiPurchases()` only — a **cash-bought asset can't be recorded**; EMI cost never depreciates. | P1 |
| **F5** | GST payable is cumulative FY with **no `gst_payments` table** — already-remitted GST still shows as a liability; error grows toward March. | P1 |
| **F6** | `customer_credits` (open) missing from the sheet — money owed back to customers. | P1 |

**⚠️ Reasoned-only — code read, no live data, so magnitudes are unknown.** F1 could be ₹0 today. **§7 of the doc has copy-paste SQL that turns all of this into rupees — run that before changing any code.**

Then: **F1 + F6 are query-layer additions to `useBalanceSheetAuto()`, no migration** (cheapest fix, biggest correction) → F2 (definition decision: copy the project path's accrual rule) → F5 → F4+F3 **with the CA**, whose call the schedule and rates are.

**Explicitly NOT recommended:** converting to full double-entry. Textbook answer, wrong trade — it touches every money surface across 196 migrations for a business with no paying tenants yet.

**Also verified CORRECT** (audit is not a hit-piece): output GST uses the frozen per-invoice `tax_amount`, never a hardcoded 18%, so zero-rated exports aren't wrongly taxed · credit/debit notes net both revenue and GST · payroll posts exactly one expense row at **earned gross** (not net), linked for clean reversal, **no accrual/payment double-post** · employer ESI 3.25% booked separately · salary payable vs statutory dues correctly split · project receivable is accrual-correct.

*Bonus:* `customer_credits.amount` is documented `-- ₹, always positive` (`0141:11`) — evidence to finally close the rupee-vs-paise ambiguity (matrix #36) in favour of **₹**.

### 🔴 Multi-company (Zoho-Books-style) — decided, planned, BLOCKED on the isolation test suite. No DB change made.

> **✅ The fake switcher is GONE (2026-08-13).** Decisions settled earlier: **(A) real multi-company, one login** · **group/merged view dropped** (wrong accounting) · **billing per company, 3 companies = 3×**.
>
> **Removed:** `lib/hooks/use-workspace.ts` (deleted) · `filterEntity`/`getEntityBadge` from all 6 pages · the topbar switcher + its duplicated localStorage logic · two dead partners-page buttons that wrote a key nothing reads · both hardcoded-tenant `.or()` fallbacks in `leads.ts`/`customers.ts` · a second keyword badge hiding in `subscriptions/page.tsx` (`"anutech"` in the name ⇒ label) that only typecheck caught · and two `me?.tenantId ?? "fbb976f1…"` fallbacks (`add-subscription-dialog`, `feedback-dialog`) that would have tried to write another tenant's row into Anutech's books. **Net: +61 / −463 lines.**
>
> **Browser-verified** (after clearing a corrupted `.next` cache — `Cannot find module './5836.js'`, not a code fault): `/customers` renders **34 rows**, and prod says Anutech Digital has **exactly 34** customers. RLS alone produces the right set; the keyword filter had only ever *hidden* the tenant's own rows. Topbar switcher confirmed gone, **zero console errors**. 234/234 tests, typecheck clean, lint 0 errors.
>
> **Next action is still NOT the migration.** It's unblocking the cross-tenant Playwright suite (TC-1008/1009, stuck on service-role key rotation) — the only automated proof of tenant isolation, and `current_tenant_id()` (150 live policies) must not be touched while it's dark.

**Green first (done, working tree only, NOT committed):** unit suite was 185/189 → **196/196**; typecheck clean, lint 0 errors. Two tests had gone stale against deliberate code changes, so the *tests* were wrong, not the code:
- `nav.test.ts` — `SCREEN_TITLES` was re-sectioned (Workspace → Home/Sales/Revenue/…) up to `cadffc4`; test still expected `"Workspace"`. Updated + added a mid-path-id case (`/customers/[id]/edit`). Also swapped the "no `[id]` entry" case from `/contacts/abc123` to `/payments/abc123` — `/contacts/[id]` now exists, so that assertion no longer tested what it claimed.
- `inbound/status.test.ts` — labels were deliberately improved (`e85f997` renamed `appended_to_lead` → "Follow-up Reply"); test still expected the old copy. Updated to the shipped labels.
- **Stale crumb fallback fixed:** `getCrumb()` fell back to `["Workspace", "Dashboard"]`, a section that no longer exists in `APP_NAV`. Now `["Home", "Dashboard"]`, matching `/dashboard`'s own entry. Browser-verified live on `/platform` (a shell-rendered route with no `SCREEN_TITLES` entry): breadcrumb reads **Home / Dashboard**. *Correction to my first write-up: I claimed this "lost the crumb's link" — it did not. The breadcrumb section renders as a plain `<span>` (`topbar.tsx:133`) and was never a link; `getSectionPrimaryHref()` turns out to be **used nowhere in the codebase** — the linking feature its docstring describes was never wired up. The fix is label correctness only.*
- **🐞 Real bug found + fixed (mobile Back button dead-ends on deep links).** `topbar.tsx:116` called `getSectionPrimaryHref(pathname)`, but that function takes a **section name** (`"Home"`, `"Sales & CRM"`) — a pathname can never match, so it always returned `null` → `router.push(null as Route)` (the `as Route` cast hid it from tsc). This fires on any detail page on a phone when `window.history.length <= 1`, i.e. **the user deep-linked straight into a quote or invoice from WhatsApp/email** — the single most common entry path for this product. Back did nothing. Straight §24 dead-end.
  Fix: new pure `getParentListHref(pathname)` in `nav.ts` — walks up `SCREEN_TITLES` to the nearest real list page (`/quotes/Q-1` → `/quotes`, `/accounting/banking/<id>` → `/accounting/banking`, `/customers/<id>/edit` → `/customers`) and **can never return null** (falls back to `/dashboard`). Back now lands on the list, which is what a deep-linked user actually wants. Covered by 12 green `nav.test.ts` tests, including a guard asserting `getSectionPrimaryHref()` returns null for a pathname *and* for a crumb section (`"Sales"` ≠ `"Sales & CRM"`), so this misuse can't come back silently.
  ⚠️ **Not browser-verified:** the dev server never finished compiling `/customers/[id]` in that session, so the mobile Back click was not exercised in a real browser. Pure-function tests + typecheck only. Worth one manual phone check before deploy.
- Also noted, not touched: `getSectionPrimaryHref` is now dead code (delete or wire up the breadcrumb links — a decision, not a cleanup); `topbar.tsx:47-68` re-implements the workspace localStorage logic instead of using `useActiveWorkspace()`, with a `saved as any` cast (violates CLAUDE.md §2 "no `any`"); `npm run lint` reports 4 `unnecessary dependency: 'workspace'` warnings across the filtered pages — more symptoms of the switcher below.

**The finding.** `lib/hooks/use-workspace.ts` partitions Customers / Invoices / Quotes / Subscriptions / Leads / Contacts (6 pages) by **hardcoded tenant UUIDs** (`:95-99`) plus **company-name keyword matching** (`:122`):
```
if (identifier.includes("<name fragment>")) return true;
```
Verified against the DB, not assumed:
1. `leads` and `customers` each have exactly **4 RLS policies**, all `tenant_id = current_tenant_id()` (`0002_rls.sql:63-73, 99-109`). The only extra SELECT is portal-side `customers_select_self_customer` → `id = current_customer_id()` (`0016:68`), which is NULL for a reseller user. Partner/distributor cross-tenant reads go through `SECURITY DEFINER` RPCs (`0040`–`0044`), **never through policies**.
2. A user therefore belongs to exactly one tenant (`lib/auth/membership.ts` — no invite ⇒ new tenant, never joins another), and can only ever read **one** tenant's rows.
3. **⇒ The switcher is not switching tenants.** It re-filters a single tenant's rows by company name and badges them "Client A" / "Anutech Digital". A customer named e.g. "Excellent Traders" lands in the wrong workspace and gets the wrong badge. The last ~10 commits (`242aa2b` → `646f27b`) are all patches to this same mechanism — which says the *approach* is wrong, not that a bug remains.
4. **⇒ The hardcoded-tenant fallbacks are dead code.** `leads.ts:31` and `customers.ts:29` re-query with `.or("tenant_id.eq.A,tenant_id.eq.B,tenant_id.eq.C")` whenever the first query is empty/errored. Both queries pass through the same RLS, so the retry can never return a row the first one didn't — including when `current_tenant_id()` is NULL. It cannot help; it only hides *why* the screen was empty ("no data" vs "auth/tenant broken" become indistinguishable).

**Not a live data leak** — RLS is holding. The cost is wrong labels, wrong buckets, and a masked root cause.

**DECIDED by Pardeep (2026-08-12): (A) two real businesses, one login.** Genuine cross-tenant access. Plan below — **NOT APPLIED, awaiting approval before any DB change.**

#### Plan: change the chokepoint, not the 331 policies

`current_tenant_id()` is one line (`0001_init.sql:52-60`): `select tenant_id from public.users where id = auth.uid()`. Every RLS policy in the system — **331 references across 108 migration files** — funnels through it. So we change *only* that function's implementation and keep its meaning ("the tenant this request acts as"). Zero policy rewrites.

**Migration (one reviewable file):**
1. `user_tenant_memberships (user_id, tenant_id, role)` — PK `(user_id, tenant_id)`. RLS: read own rows; INSERT/DELETE owner + service_role only. **Explicit rows are the authorization — never name inference.**
2. `users.active_tenant_id uuid references tenants(id)`.
3. **Backfill:** one membership per existing user from their `users.tenant_id`, and `active_tenant_id = tenant_id`. ⇒ every existing user's visible data is **byte-identical** after the migration. It is a no-op until a second membership row is added by hand. That's the safety property that makes this reviewable.
4. Write-time trigger: `active_tenant_id` must have a matching membership row (rejects at UPDATE, so the read path stays cheap).
5. New body — write-time guard *and* a read-time check (defence in depth; both are PK lookups, and the function is `STABLE` so Postgres evaluates it once per statement):
   ```sql
   select case
            when u.active_tenant_id is not null
             and exists (select 1 from public.user_tenant_memberships m
                          where m.user_id = u.id and m.tenant_id = u.active_tenant_id)
            then u.active_tenant_id
            else u.tenant_id
          end
     from public.users u where u.id = auth.uid();
   ```
   Fail-safe by construction: a stale or forged `active_tenant_id` degrades to the home tenant. It can never *grant* access.
6. `set_active_tenant(p_tenant_id)` — validates membership, updates, returns the new tenant. The only way to switch.
7. `my_tenants()` — the caller's memberships + tenant names, for the switcher UI.
   Both RPCs: EXECUTE to `authenticated` + `service_role` only, per the `0145` deny-by-default idiom.

**App changes:**
- **Reads:** delete `filterEntity`/`getEntityBadge` calls from all 6 pages and both `.or()` fallbacks (`leads.ts:31`, `customers.ts:29`). RLS does the filtering now, so this is a **net deletion** — the pages get simpler, not more complex.
- **Writes:** 32 places across 27 files derive tenant via `select tenant_id from users` for inserts; they must read the *active* tenant. Centralize into one helper (`lib/tenant.ts` server-side + one client equivalent) so there's a single change point. **Fail-safe:** the existing `*_insert` policies are already `WITH CHECK tenant_id = current_tenant_id()`, so a site we miss does not write to the wrong tenant — it errors loudly. This migration fails loud, not silent.
- Also fix `topbar.tsx:47-68` (duplicated localStorage workspace logic + `as any`) by consuming the new hook.

**⚠️ Two things Pardeep must know before approving:**
- **"Group" mode → DELETE it, don't rebuild it (decided 2026-08-12).** RLS returns one tenant per request, so today's group mode is fake. But the Zoho Books comparison settled the question properly: **Zoho doesn't merge organizations either, deliberately.** Each GSTIN files its own GSTR-1/3B and each legal entity keeps its own books, so merging two companies' books is *wrong accounting*, not a missing feature. ~~Correct route later: an aggregate RPC~~ — no. Group view was never the goal. If cross-company *reporting* is ever wanted it's a separate read-only roll-up (like `get_partner_metrics`, `0044`), never a merged ledger.
  *(This also killed one of my own arguments for deferring the whole feature — "(A) doesn't even deliver group view" attacked a feature that shouldn't exist. Recorded so the reasoning isn't reused.)*
- **`0073` blocks this by design.** `team_invites_email_unique` on `lower(email)` is global — deliberately so one email can't be claimed by two tenants. Memberships must therefore be created owner/service-side, NOT through the invite flow, or that constraint needs a conscious revisit. Flagging rather than quietly working around it.

**Tests before any UI (following the existing 28-test SQL pattern in `supabase/tests/`):** membership grants access · non-member `active_tenant_id` falls back to home tenant (no access) · switching changes visible rows · insert into a non-active tenant rejected · `record_payment` + `generate_invoice` act on the active tenant · document series stays per-tenant across a switch. Plus the Playwright cross-tenant suite TC-1008/1009 — **currently blocked on service-role key rotation; that blocker has to clear first**, since it's the only automated proof of isolation.

**Sequencing:** branch → apply + test against a **restored copy of prod, not prod** → review → then UI. Unrelated but urgent: `session/money-spine-hardening-jun1` is **654 commits ahead of `master`**; a stray `master` deploy would drop the entire ERP layer. Worth settling before this lands.

**Alternative considered and rejected:** JWT custom claims for the active tenant (needs auth hooks, and a stale token keeps stale access); `set_config` session vars (don't survive PgBouncer pooling). The `users` column + membership check is the smallest correct change for this codebase.

#### Why this is a real product feature, not Pardeep's convenience (settled 2026-08-12)

Pardeep asked: "Zoho Books lets a customer create multiple companies — can't we?" Yes, and it's **table stakes for the category**, not a nice-to-have: Zoho Books / Tally / QuickBooks all do it, and an Indian SMB owner running 2–4 legal entities for tax reasons is normal. A reseller evaluating us against Zoho notices its absence immediately.

**The architecture is already ~80% there** — this was the surprise:

| Zoho Books concept | Already built here |
|---|---|
| "Organization" = one company | `tenants` row: `name, gstin, state, state_code, address, doc_code, logo_url, lut_number, lut_valid_upto` (`0001`, `0185`) |
| Each org gets its own gap-free invoice series | `document_series` PK = `(tenant_id, doc_type, fiscal_year)` (`0004:45`) |
| Org-tagged document numbers | `INV-ET-2026-27-0001` via `tenants.doc_code` (`0054` — whose own comment says "confirmed codes for the **two real tenants**") |
| Org switcher | ❌ **the only missing piece** |

**One tenant = one company is already true.** Per-company GST series, GSTIN, LUT, logo and doc code all work today. The only thing hard-wired is *a user to a single tenant* — which is exactly what the membership plan above unlocks. Also telling: `lib/platform.ts` already ships **two founder emails for one person** (`pardeep@anutech.in`, `pardeep@example.test`) — the two-identity workaround is already in the code.

**⏱ Also revised: deferring this gets more expensive, not less.** 32 JS write-sites need the active-tenant lookup today; at 196-migrations-and-counting velocity that number only grows. (I originally argued "defer"; the cost curve and the category-standard point both cut the other way. The one thing that did *not* change is the precondition below.)

#### Billing model — DECIDED: per company, 3 companies = 3× (2026-08-12)

Zoho's model, and Pardeep's call: each company is billed separately.

**Billing lives on `tenants`, NOT on the membership.** My first phrasing ("per-membership billing flag") was wrong thinking — here's the counter-example that kills it:

```
Client A (COMPANY — Growth ₹2,499/mo)      Anutech Digital (COMPANY — Starter ₹999/mo)
   ├── Pardeep     ← membership                          └── Pardeep  ← membership
   └── Accountant  ← membership
```
2 companies · 3 memberships · bill = **₹3,498/mo**. Billing per *membership* would charge Pardeep twice for himself and would raise the bill just for adding an accountant to a company you already pay for.

| Table | Job | Carries billing? |
|---|---|---|
| `user_tenant_memberships` | who may enter which company (a door key) | ❌ pure access row — keep it clean |
| `tenants` | one company | ✅ plan / status / period live here |

**Two consequences of "3 dega":**
1. **"+ Add company" becomes a paid action** — it cannot be a free button, or someone runs 10 companies on a Starter plan. Zoho asks for the plan at org-creation for exactly this reason.
2. **The paywall must check the ACTIVE tenant, not the user.** If Anutech's payment fails while Client A is paid, switching to Anutech must go read-only/blocked while Client A keeps working. A per-user check cannot express that.

**⚠️ Verified: this billing system does not exist at all.** No `plan`, `billing_status`, `trial_ends`, or subscription column on `tenants` anywhere in 196 migrations; `/pricing` is marketing only; there is no paywall. (The "billing status" mentioned in CLAUDE.md §17 is `api_keys.revoked_at` — unrelated to Model B.) So **"3 dega" is a decision about a system that must be built from zero, and it's a bigger piece of work than multi-company access itself.**

⇒ **Razorpay live is a PREREQUISITE for enforcing this, not a parallel task.**

**What this changes today: nothing to build — but one thing to protect.** Billing columns go on `tenants` (their natural home) and the membership table stays a pure access row. Get that right now and "3× per company" becomes enforceable the day Razorpay lands, **with no migration**. The only way to lose that is to let a billing flag creep onto the membership table.

**Independently of A/B, and safe:** delete both `.or()` fallbacks (dead code) and let an empty list be honestly empty. Deferred only because this repo has a documented history of prod-vs-git drift (`0146_capture_schema_drift_critical.sql`), so settle it against live prod first — as `Pardeep@…`, in Supabase SQL editor:
```sql
select current_setting('request.jwt.claims', true);            -- who am I
select public.current_tenant_id();                              -- my one tenant
select tenant_id, count(*) from public.customers group by 1;    -- what RLS actually lets me read
select relrowsecurity from pg_class where relname = 'customers';-- is RLS even on
```
If row 3 returns more than one `tenant_id`, my analysis is wrong and RLS is not doing what `0002` says — that would be a P0 and takes priority over everything above.

### 🎨 /customers world-class redesign (Pardeep: "deep study, logical+UX+psychological, world class banao") — ✅ DONE (localhost, typecheck+lint clean, desktop+mobile verified)
Deep 4-lens analysis then rebuilt `customers/page.tsx` as a book-of-business tool, not an accountant ledger:
- **Money-first StatStrip** (Customers · Active MRR · ARR · **Receivables due** in rose) — was a run-on subtitle sentence where receivables read as a tiny fragment.
- **Visible segment chips** with counts (All · Has receivables · With subscriptions · No subscription · Has credit) — was a hidden dropdown; debt chip count turns rose when >0.
- **Sortable table** (click Customer / MRR / Receivables / Credits headers, arrow shows dir) + a new **MRR column** (the value of each relationship — previously MRR was invisible on the list) + **colored avatars** for scannability. Contact merged (name+phone) to free space; receivables keep the rose left-border + loud amount.
- **Header**: 4 competing buttons → **Add customer** primary + a **More** overflow (Export / Import / Link domains).
- Enriched mobile cards (avatar + MRR + Owes/Credit). Master-detail, resizable columns, pagination, search all preserved. Money math untouched (layout/hierarchy only). Verified: sort-by-MRR reorders (Rakesh ₹3.0K/mo → top), chips filter, mobile clean.

### 🧭 Layout-flow deep audit — ROUND 2 (rest of the app: Purchases · Payroll/HR · Engage · Catalog+Settings · Public) — mechanical wins ✅ DONE (localhost, typecheck+lint clean)
5-agent parallel audit of the clusters not covered in round 1. ~55 findings; dominant themes: (a) §20 mobile breakages — many list pages lack a `md:hidden` card fallback + `<FAB>` (Engage campaigns/coupons/promos + WhatsApp inbox; Payroll employees/payroll/leave; Team; Lead-gen; portal invoices; reimbursements); (b) fixed `px-8` padding & ad-hoc max-widths; (c) dead "coming soon" buttons/tabs; (d) money-not-first / Hinglish copy on some pages.
Fixed the pure-mechanical, zero-judgment wins now:
- **max-width consistency**: vendors/reimbursements/business-loans 1400→1800; settings 1800→1240 (detail spec).
- **responsive padding** px-8 → responsive: settings, reports, lead-gen.
- **dead-ends removed**: PO "Export" (no onClick), Reports "This month"/"Export PDF" coming-soon buttons, Lead-gen "Import CSV" no-op, Performance dev-file reference ("tune in lib/queries…").
- **business-loans**: education banner now shows only when empty (money/KPIs read first) + translated to English.

**Round-2 — mobile sweep + buy-page trust (Pardeep approved both) ✅ DONE (localhost, typecheck+lint clean, mobile-verified):**
- **§20 mobile sweep** (via 3 parallel agents + me): added `md:hidden` card lists + `<FAB>` to campaigns/coupons/promos (Engage), employees/payroll/leave (payroll screens.tsx — + payroll headline promoted to a KPI tile), team (members + separate pending-invite cards), lead-gen recent-inbound, reimbursements; removed raw campaign/promo UUID sub-lines. Desktop tables untouched (gated behind hidden md:block).
- **Buy-page trust**: gated the fabricated logo-strip + testimonials behind `SHOW_SOCIAL_PROOF=false` (flip on when real consented content exists); removed the fabricated counts (1024 / 247) — kept honest claims (Premier Partner since 2014, GST); the founder + signed-refund card now renders on MOBILE too (was `hidden lg:flex` — the strongest trust signal was phone-invisible). Verified live on a 375px viewport.

**Round-2 remainder — for Pardeep's call (bigger / needs a decision), NOT done:**
- **Buy page "TEST MODE / Simulate payment" UI** shows whenever Razorpay isn't configured — will appear to REAL customers if the storefront is public before Razorpay live. Tied to Pardeep's Razorpay go-live task; hide/gate to non-prod as part of that.
- **Buy page not tenant-aware** (hardcoded Excel/Pardeep) + **M365/Zoho buy pages missing** — product decisions.
- WhatsApp inbox mobile single-pane; quote-accept confirm()→dialog; Items catalog restructure; Settings coming-soon tabs; Hinglish→English sweep; raw confirm()→shared dialog.
- **§20 mobile sweep** (biggest, M each): add `md:hidden` card lists + `<FAB>` to campaigns/coupons/promos, employees/payroll/leave, team, portal-invoices, reimbursements, lead-gen; WhatsApp inbox single-pane mobile.
- **Customer-facing / trust (needs decision)**: buy page conflicting social-proof (1024 vs 247) + placeholder testimonials + "TEST MODE / Simulate payment" UI visible if Razorpay unconfigured; founder/refund card hidden on mobile; buy page hardcoded to Excel/Pardeep (NOT tenant-aware); M365/Zoho buy pages don't exist though landing sells them.
- **Quote-accept**: native confirm() → in-app dialog (customer-facing money click).
- **Items catalog**: table buried under 4 KPIs + 3 tab-bars → restructure.
- **Payroll**: headline ₹ buried in filter → promote to KPI; add KPI bands to employees/leave.
- **Settings**: hide 2 "Coming soon" tabs (Notifications/Security); split pending-invites out of the members table.
- **Hinglish→English** copy sweep (partners, saas-metrics insights, purchases subtitles, etc.).
- **raw confirm() → shared dialog** across coupons/promos/purchases pages.

### 🏢 Customer Groups / Parent Accounts — ✅ DONE (localhost, browser-verified end-to-end)
Real case (Pardeep): one reseller/coordinator (X) routes work for several companies, each needing its own invoice in its own legal name + GSTIN. GST forbids billing multiple entities on one invoice → each company stays its own customer; a lightweight umbrella links them for relationship + reporting. Payment side stays simple (each company pays separately — no consolidated allocation needed, per Pardeep).
- **Migration 0168** (applied to prod DB): `customer_groups` table (tenant RLS + touch trigger) + `customers.group_id` FK `ON DELETE SET NULL` (deleting a group only un-links companies — verified: dummy's group_id went null, never deletes the customer/money history). Billing untouched.
- **Types + hooks**: `CustomerGroup*` types + `group_id` on Customer; `lib/queries/customer-groups.ts` (list/get/create/update/delete + `useSetCustomerGroup`).
- **UI**: `GroupFormDialog` (create/edit, RHF+Zod, `is_partner` flag → links to referrals); `/customers/groups` list (cards + FAB + empty state); `/customers/groups/[id]` detail (rollup KPIs: companies · total outstanding · total MRR, reusing `useOutstandingReceivables`+subscriptions; member table + mobile cards; edit/delete). Customer form "Parent account / group" picker (select existing or ＋New inline) in Other-details. Customer detail shows "Part of group: X →" link. Nav "Parent Accounts" under Sales + breadcrumbs.
- **Verified live**: created a group → assigned a customer via the edit form → group page showed it with the rollup → customer detail showed the group link. typecheck 0 errors, lint clean. Test group deleted after.
- **NOT deployed yet** (migration 0168 is on prod DB; app-code is localhost-only).

### 🧭 Layout-flow deep audit — 4-cluster study + clear-win fixes (Pardeep: "logical layout flow, jo sahi ho improve karo") — ✅ BATCH 1 DONE (localhost)
Ran a 4-agent parallel layout/flow audit (Navigation/IA · Revenue · Accounting · Sales/Dashboard) → ~46 findings. Verdict: IA + shared patterns genuinely strong; findings are mostly consistency-drift. Fixed the clear HIGH-confidence, low-risk wins (typecheck + lint clean; breadcrumb + mobile FAB browser-verified):
- **Breadcrumbs** (`nav.ts`): `/performance` → [Payroll, Team Performance] (was dead "Team/Performance"); added `/customers/new` (was "Profile") + `/customers/[id]/edit` crumbs; made `getCrumb` handle mid-path ids (…/[id]/edit); deleted 4 phantom entries (gst/output|input|summary + automations — no such routes).
- **Command palette** (`command-palette.tsx`): Pages list now role-filtered (was raw APP_NAV → sales users saw owner/accounting destinations) + href-deduped (Filing reused Accounting hrefs → 6 pages listed twice); "Add new customer" → `/customers/new` (was dumping on the list).
- **Mobile FABs** added on Subscriptions, Invoices, Tasks (header primary scrolled away on phone; §20). 
- **Responsive padding**: renewals + online-orders `px-8` → `px-4 md:px-8` (were 32px side-pad on phones).
- **GST empty states** → shared `<EmptyState>` (were 2 bare grey lines vs illustrated blocks everywhere else).
- **Dashboard** default right-column: renewals/trials now outrank the rank-of-one leaderboard (money-at-risk first).
- **English-only**: leads "today" empty-state Hindi copy → English.

**Batch 2 — Pardeep approved 3, ✅ DONE (localhost, typecheck+lint clean, browser-verified):**
- **P&L + Balance Sheet → Export CSV** (`pnl/page.tsx`, `balance-sheet/page.tsx`): new shared `src/lib/csv.ts` (`downloadCSV`/`csvEscape`); each report header now has an Export CSV button that hands the CA a spreadsheet-clean statement (raw ₹ integers). Verified: button renders, no console error on click.
- **Setup wizard reorder** (`setup/page.tsx`): Company → **Import** → Razorpay → Google CSP → Done, so first-value (import customers) comes before the two integration steps that can only be *started* here. Kept index-0=Company-save + index-3=finishSetup invariants; changed STEPS + the `step===N` component map together. Verified: stepper shows new order.
- **Quote-detail header** (`quotes/[id]/page.tsx`): collapsed 7 equal-weight buttons → **Preview · Download PDF · ⋯ More**; More menu = Copy link / Send email / Send WhatsApp / Duplicate & edit / ── / Delete quote (destructive, separated). The money next-step stays the clear primary in the status action bar. Verified: clean header + menu opens correctly.

**Batch 2 remainder — still open for a later call:** default report period differs per page (Bills/P&L=FY vs Expenses/GST=month — money-misread risk; but GST-monthly is arguably correct for India → needs a decision); P&L + Balance Sheet have no Print/Export (the CA-handoff reports); Payroll/GST tables lack mobile card fallbacks (L effort); Items catalog buries its list under 4 cards + 3 tab bars; Setup wizard sequences Razorpay/CSP before "import customers" (first-value last); Quote-detail 7 equal-weight header buttons (no clear primary, Delete fat-finger risk); shared `<ReportRangePicker>` + accounting eyebrow/period-position consistency. Full finding list from the 4 agents preserved in session notes.

### 🧠 Logical-flow audit — HIGH + money-adjacent 14 fixed (Pardeep: "har process ka flow logical hai?") — ✅ DONE (localhost)
Ran a 5-agent read-only audit of every flow; fixed the 14 highest-severity logical inconsistencies:
- **Dead buttons wired/relabelled**: subscriptions "Renew" (was no-onClick, phone icon) + expired "Action" → both now "Renew" (refresh icon) → `/renewals` · `subscriptions/page.tsx`. Draft-invoice "Send" (dead; no send flow) → "View" (opens preview) · `invoices/page.tsx`.
- **Customer-facing accept page**: expired/rejected quotes now show a "no longer available · request a fresh quote" screen instead of a working Accept button that only errors · reworded the "you'll get a GST invoice email" promise (never sent; invoice is post-payment) in 2 places · `quote-accept-view.tsx`.
- **Setup checklist** now derives status from REAL state (`useCurrentUser` GSTIN + `useCustomers` count) instead of hardcoded "done" ticks · `setup/page.tsx`.
- **Payroll**: "Unpaid" badge → "Awaiting reconcile" (you just clicked Pay); "Paid this month" → "Payroll this month" (it summed unpaid runs too); softened the Pay dialog copy · `payroll/screens.tsx`.
- **Lead → Deal**: post-save toast/route now STAGE-based, not plan-based (a raw lead no longer falsely claims "saved as Deal") · "Add Deal" on the pipeline now creates a NEW record straight in a deal stage via a `defaultStage` prop (was always stage=new → invisible on /deals) · `add-lead-form.tsx`, `leads/page.tsx`.
- **Renewals**: lapsed-but-in-grace subs (daysUntil < 0) now surface in the Urgent bucket (were vanishing from every bucket) · `renewals/page.tsx`.
- **Money-adjacent**: typed prospect now has an editable **Place of supply** state picker → correct GST split (CGST+SGST vs IGST) instead of silent intra-state · `quote-builder.tsx`. "Invoiced" badge shows `₹X due` + joins the Awaiting-payment worklist when a balance remains · `quotes/page.tsx`. "Output GST collected" → "Output GST (on sales)" (included unpaid invoices) · `gst/page.tsx`, `pnl/page.tsx`.
- Verified LIVE: prospect state picker renders, payroll label = "Payroll this month". typecheck 0 errors, lint clean.
- MED/LOW audit findings (~35) deferred.

### 💰 Prospect place-of-supply — persisted end-to-end (GST split correctness) — ✅ DONE (test-backed, DB applied)
The builder captured a typed prospect's state but never persisted it, so `record_payment`'s prospect branch created a **stateless** customer → `generate_invoice` defaulted every prospect to intra-state (CGST+SGST) even for an inter-state buyer. Wrong GST heads on a tax invoice = compliance defect. Same class of bug 0055 fixed for the lead path.
- **Migration 0167** (`0167_quote_prospect_place_of_supply.sql`, applied to prod): adds `quotes.prospect_state_code / prospect_state / prospect_country`; recreates `record_payment` so the typed-prospect branch stamps `state_code / state / country` onto the auto-created customer (2 audited edits vs the verbatim 0078 body).
- **App layer**: `quote-builder.tsx` createQuote payload now persists the 3 fields (only for no-lead + no-customer prospect quotes); `database.types.ts` QuoteRow + QuoteInsert updated.
- **Rolled-back RPC test (PASS)**: inter-state prospect (MH 27 vs tenant Delhi 07) → customer.state_code=27, invoice.inter_state=**t** (IGST); control intra-state prospect (Delhi 07) → inter_state=**f** (CGST+SGST). Everything rolled back, no leaked rows.
- **Browser proof**: saved a real prospect quote via the builder → DB row had prospect_state_code=27 / Maharashtra / India; builder also shows a live "Inter-state → IGST 18% will apply" hint. Test quote deleted after. typecheck 0 errors.

### 🎯 Customer next-best-action ignored existing quotes → "Create first quote" when 2 drafts existed (Pardeep: "kya ye logical hai") — ✅ FIXED (localhost)
The NBA only looked at subscriptions/projects, so a customer with 2 draft quotes but no subscription still got "No subscription yet · Create first quote" — illogical. Made `deriveCustomerInsights`/`computeNBA` quote-aware (threaded `allQuotes` from both the detail page + panel). New case-4 logic when there's no sub/project: (a) **draft quotes exist** → "N draft quote(s) not sent yet · Review & send" (CTA opens the newest draft via a new `open_quote` kind → `/quotes/[id]`); (b) **sent/viewed quotes** → "N quote(s) awaiting decision · Draft a follow-up with AI"; (c) **no quotes at all** → the original "No quote yet · Create first quote". Verified LIVE on Design Box (2 drafts): NBA now reads "2 draft quotes not sent yet", CTA navigates to Q-ET-2026-27-0010. typecheck+lint clean. Files: `customer-insights.tsx`, `customers/[id]/page.tsx`, `customer-panel.tsx`.

### 🧭 Quote builder — Quote Settings moved ABOVE line items (Pardeep: "sabse neeche hona logical hai?") — ✅ FIXED (localhost)
Quote Settings (billing cycle · currency + exchange rate · pricing basis · GST) was pushed to the BOTTOM via `order-last` on the card — but those settings DRIVE how each line is priced/displayed (esp. international: set USD + pricing basis before adding items so the catalog shows the right price). The card's own comment even admitted invoice mode keeps it above "because the currency drives each line's price" — the same is true for quotes. Removed `order-last` so Settings render right after Customer Details and before Line Items in BOTH modes. New order: Customer → Settings → Line items → Totals (who → how → what → total). Verified LIVE: Quote Settings now sits above "No line items yet". typecheck+lint clean. File: `quote-builder.tsx` (one-line CSS/DOM order change).

### 🧾 Quote builder — "Or type a new prospect" showing under a selected customer (Pardeep: "kya yaha logical hai") — ✅ FIXED (localhost)
The Customer Details section always showed BOTH the existing-customer picker AND the "Or type a new prospect" free-text — so with a customer already selected, the stray prospect field read as ambiguous ("which one wins?"). Made it a clean **either/or**: the prospect field (+ its Country) now renders only when NO existing customer is picked (matching how Country was already gated). To switch back, added a **✕ clear** affordance on `CustomerCombobox` (a span, not a nested button, so trigger markup stays valid) that deselects the customer and brings the prospect entry back. The onChange cross-clearing is now redundant (removed) since the two never show together. Verified LIVE: no customer → picker + prospect both offered; pick Design Box → prospect/Country hide, ✕ appears; click ✕ → customer clears, prospect returns. typecheck+lint clean. Files: `quote-builder.tsx`, `customer-combobox.tsx`.

### 🌐 Foreign quotes showed ₹ to the customer (Pardeep: international client ko quote USD me chahiye) — ✅ FIXED (localhost)
Root cause: the quote SAVED correctly (currency=USD + exchange_rate ARE persisted; amount stays canonical ₹ by design for books/GST) — but the **public accept page showed ₹**, because its server projection never selected `currency`/`exchange_rate` and the view formatted everything with `rupee()`. So the customer opening the link saw ₹ even for a USD quote. (The PDF was already currency-aware.) Fixes:
- **Public accept page** (`quote/[id]/accept`): server now selects `currency, exchange_rate`; `PublicQuote` carries them; the view uses a `money()` helper (`formatForeign(foreignEquivalent(₹, rate), currency)`) for every amount — rate/amount/subtotal/taxable/GST/total/accept button. Verified LIVE on the real USD quote Q-ET-2026-27-0010: whole page renders in **$** ($32.00 rate · $1,023.88 total).
- **Quotes list**: added `quoteMoney(q)` — foreign quotes show their currency ($1,023.88), ₹ quotes unchanged; the cross-quote pipeline sum stays ₹ (can't sum mixed currencies). Verified LIVE: #0010 shows $1,023.88, all others ₹.
- Books stay ₹ everywhere (GST/accounting canonical). typecheck+lint clean. Files: `accept/page.tsx`, `quote-accept-view.tsx`, `quotes/page.tsx`, `currency.ts`. NOTE: the internal quote-DETAIL page still shows ₹ (mixes with ₹ payments) — offered to convert its quote figures to USD as a follow-up.
- **Foreign line-math consistency** (Pardeep: "32 × $32 = $1,024, par $1,023.88 kyun?") — converting each ₹ figure to USD independently made a rounded unit rate disagree with the exact total (₹3,055/seat → $32.00 shown, but 32 seats × exact ₹ = $1,023.88). Fixed on BOTH customer-facing docs (accept page + `QuotePDF`): for a foreign quote we now round the **per-unit** rate in the display currency and derive line amount + subtotal/discount/tax/total from THAT, so qty × rate == amount and Σ lines == total exactly. **Domestic ₹ quotes are gated to keep the canonical stored figures untouched** (no rounding drift vs the saved amount). Verified LIVE: USD quote now shows 32 × $32.00 = **$1,024.00** end-to-end; a domestic quote still shows its exact ₹ (₹19,116). The `= ₹X in books (for GST)` reference on the PDF stays the canonical ₹. Builder line rows may still show the old per-figure conversion — flagged as a possible follow-up.
- **Builder line rows + totals now consistent too** (Pardeep: "builder line rows bhi consistent karo") — applied the SAME display-currency per-unit rounding across the quote-builder: line amount (mobile card + desktop table), List price, quote discount, subtotal, taxable, CGST/SGST/IGST, grand total + sticky bar all derive from the rounded per-unit rate for foreign quotes (`dispAmt`/`fmtDispC`/`fmtTotalC`/`fmtPayableC` helpers; retired `curFmt`/`fmtTotal`/`fmtPayable`). Domestic ₹ falls back to the canonical figures (no drift). Verified LIVE: AppSheet Core 10 × $104.31 = **$1,043.10** = Subtotal = Taxable = Total; books record ₹99,600. typecheck+lint clean.

### 💵 Quote builder — round off the foreign "Total payable" (Pardeep) — ✅ BUILT (localhost)
Foreign (USD) totals carried ugly cents from the ₹ ÷ rate conversion (e.g. $1,023.88). Added a **"Round off total"** checkbox in the totals sidebar — **ON by default** → the payable total shows whole units ($339); toggle off → exact ($339.34). Applies to both the sidebar grand total and the sticky bottom-bar total. **Display-only + money-safe**: the "= ₹X in books (for GST)" line stays the exact canonical ₹ (unchanged), so GST/books are untouched — only the client-facing foreign figure rounds. `formatForeign()` gained an optional `decimals` arg (default 2). Only shows for foreign currency (₹ totals are already whole). Verified LIVE (US quote, ₹32,400 @ ₹95.4803): default $339, unchecked $339.34, books ₹32,400 throughout. typecheck+lint clean. Files: `currency.ts`, `quote-builder.tsx`. NOTE: rounds the BUILDER display; if the customer PDF should show the same rounded figure, that's a small follow-up (store the flag on the quote).

### 💱 Quote builder — USD pricing basis toggle + currency-aware picker (Pardeep) — ✅ BUILT (localhost)
Two parts:
- **Picker shows the billing currency**: when billing USD, the "Add line item" catalog picker converts each item's ₹ price to USD (`formatForeign(it.msrp / fx, currency)`) e.g. `$2.83/mo` + small `≈ ₹270 @ ₹95.4803` ref (was showing ₹). Rate-not-set → "set the exchange rate to show USD" prompt.
- **Per-quote pricing-basis toggle** (Pardeep's decision — resellers sometimes bill the Indian rate in USD, sometimes the real international USD price): International-billing panel now has a **International USD / India rate → USD** switch. `international` (default) = use each item's catalog USD price if set (else ₹-convert); `india` = always convert the ₹ price at the rate (ignore the catalog USD price). Gated in all 3 places — picker display, `addFromCatalog` (initial line), and the re-price effect — so display + stored line agree. Books always stay ₹ (USD price stored as `usd × fx`, ₹ price stored as-is) → GST-safe; line rates stay hand-editable for exceptions. Item form already has a USD-price field, so resellers set the international price per item.
- Verified LIVE (US export quote, rate ₹95.4803, temp USD price $6 on GW-STR then reverted): International basis → **$6.00** (real USD), India basis → **$2.83** (₹270 ÷ rate). typecheck+lint clean. Files: `quote-builder.tsx`, `add-line-item-dialog.tsx`.


### 🧱 Customer form — full-page rebuild (better than Zoho) — ✅ BUILT + LIVE-VERIFIED (localhost, awaiting deploy)
Pardeep: "full page form Zoho se behtar banana hai to app ko behtar bana sake." Converted customer add/edit from a side-sheet to a dedicated full-width PAGE, and made it beat Zoho on the reseller-specific parts:
- **New routes** `/customers/new` + `/customers/[id]/edit` (full-page, label-left/field-right rows, **tabs**: Details · Address · Contact persons). Header + footer both carry Cancel/Save.
- **Shared brain** — extracted ALL logic (schema, prefill/edit back-fill, GSTIN→state derive, export-vs-India shaping, normalise-on-submit) into `use-customer-form.ts`. Both the full-page form AND the side-sheet (`AddCustomerForm`, kept for the quote-builder's inline "＋ New customer" so an in-progress invoice draft isn't lost) consume the same hook → the two views can't drift on money-sensitive logic.
- **Better-than-Zoho moves**: (1) country-first — region picker sits above everything with a LIVE tax-treatment banner (India = GST flow + GSTIN verify/auto-fill; export = zero-rated/LUT + USD default); (2) one-click GSTIN → legal name/address/state/PIN; (3) "Shipping same as billing" checkbox instead of retyping; (4) tab-level error dots so validation on a hidden tab is discoverable.
- **Customer type (Business / Individual) + Display name** (Pardeep: "kai customer individual bhi hote hai") — migration 0165 adds `customer_type` ('business' default / 'individual', check-constrained) + `display_name` (nullable). Form: a segmented Business/Individual toggle at the top of essentials; for **Individual** the GSTIN + Company-name rows hide and the person's Name becomes required (the person IS the customer). **Display name** field with live on-brand suggestion **chips** ("First Last", "Last, First", Company) — click to fill (replaced the native `<datalist>` which rendered an unstyled dropdown over the sidebar). Money-safe: canonical `name` = company (business) or person name (individual) → that's what invoices/GST use, unchanged for business; `display_name` is a UI-only label wired into the customers list, detail header, panel header + search (falls back to `name`), never onto the GST invoice. Verified LIVE: toggle hides company/GSTIN, individual create → detail shows "Rahul Verma", DB row `customer_type=individual`, gstin null; typecheck+lint clean, test row cleaned.
- **Customer detail page — Zoho-style top tabs** (Overview · Transactions · Statement) — added top-level tabs to `/customers/[id]`. **Transactions** = one unified real-data table (invoices + payments + refunds + quotes + projects, color-coded type badges, real doc numbers, chronological). **Statement** = a running-balance ledger (invoice = debit, payment = credit, live balance + closing-balance summary; verified math: ₹38,232 + ₹3,823 billed − both paid = ₹0 closing). **Overview** = the rail + metrics + NBA + subscriptions + recent-activity feed. **Mails tab deliberately NOT added** — we send via mailto/WhatsApp deep-links which aren't logged per-customer, so a Mails tab would be a fake shell; needs an email-logging feature first (flagged to Pardeep). Payments pulled via `usePayments()` filtered by customer_id. Verified LIVE on a customer with 2 invoices + 2 payments: all three tabs populate correctly; typecheck+lint clean.
- **Customer detail page — Zoho-style 360 layout** (Pardeep shared Zoho's customer detail, liked its user-friendliness) — rebuilt `/customers/[id]` into a two-column layout: a **left identity rail** (`CustomerIdentityRail` in customer-insights.tsx) = Contact card (avatar + person + email/phone + Call/WhatsApp/Email quick actions), Address card (Billing + Shipping), and "Other details" (Customer type · Currency INR/USD · GSTIN+verified badge / Place of supply · TAN · TDS · Payment terms · Since); **right column** = Outstanding/Lifetime/MRR/Renewal metric bar + Next-best-action + Subscriptions & projects + Activity/Quotes/Invoices tabs. **Removed the fake "Health 70/100" card** (nothing computed it — same vanity metric already dropped from the list). Header simplified (name + contact line; contact actions moved into the rail). Foreign customers show USD + State/Province (no GSTIN). Verified LIVE: full rail renders, clean reload no errors, typecheck+lint clean.
- **Billing address — City field + grouped** (Pardeep: "address me city hone chahiye") — migration 0166 adds `city` column. Address tab now holds the FULL billing address together: Billing address → City → State/Province → PIN/ZIP (State + PIN moved here from "Other details", which now = Designation/Website/Payment terms). City flows onto the GST invoice via `build-props` (composes `address, city`; old customers with city inside the address line unaffected). Types + hook (schema/prefill/submit) + sheet form updated. Verified LIVE: Address tab shows City grouped with address/state/pin; typecheck+lint clean.
- **IA restructure (Pardeep: "Zoho zyada user-friendly")** — deep-analyzed: our biggest friction was hiding the primary contact's name/email/phone behind the 3rd tab, so creating a customer forced a tab-switch. Fixed to match Zoho's information architecture: an always-visible **Essentials block** (Company name, GSTIN+verify, Primary contact name, Email, Work phone + Mobile) sits above the tabs; tabs now hold only **secondary** fields — "Other details" (State, PIN, Designation, Website, Payment terms), "Address", "Contact persons". Result: everything you need to create a customer is on one screen, no hunting. Verified LIVE: essentials render above tabs, Other-details tab shows secondary fields, typecheck+lint clean.
- **"Make primary contact"** — each other-contact row has a ⋮ menu (Make primary contact / Remove); promoting swaps the row into the primary slot (old primary demotes to a row, or drops if empty) so nothing is lost. Reflects Zoho's row action.
- **Contact-persons Zoho-style table** (Pardeep shared Zoho's grid): "Other contacts" now a spreadsheet-style table — Salutation · First · Last · Email · Work phone · Mobile columns, one editable row per person, per-row remove (×), "＋ Add Contact Person" below; scrolls inside its own container (page body never side-scrolls). Added `mobile` to the contact_persons zod/prefill/submit (ContactPerson type + migration 0164 jsonb already had `mobile`); sheet card also gained a mobile input. Verified LIVE: table renders, columns + remove ×, add row, horizontal scroll contained.
- **Wiring**: customers list "Add customer" + FAB + empty-state, customer detail "Edit", `?edit=1` deep-link, and customer-panel edit ALL navigate to the new pages. Panels/sheet for edit removed everywhere except the quote-builder inline case.
- Verified LIVE: create (India) → toast → navigates to detail; edit prefill correct; export banner + foreign state dropdown on UAE; shipping toggle reveals/hides; quote-builder inline sheet still renders (same hook). typecheck + lint clean, zero console errors. Test customer cleaned up. Files: `use-customer-form.ts` (new), `customer-form-page.tsx` (new), `customers/new/page.tsx` (new), `customers/[id]/edit/page.tsx` (new), `add-customer-form.tsx` (now sheet-over-hook), `customers/page.tsx`, `customers/[id]/page.tsx`, `customer-panel.tsx`.

### 👤 Customer form — Zoho-parity fields — ✅ BUILT (localhost, post-00171, awaiting deploy)
Pardeep wanted our customer form like Zoho Books' (inspected Zoho's real contact via the Zoho Books MCP — Anutech org 60071232614). Added all 4 chosen field-groups (migration 0164, additive/nullable):
- **Multiple contact persons** — `customers.contact_persons` jsonb; form "Other contacts" section with `useFieldArray` (Add/remove person: first/last/email/phone/designation). Verified LIVE: Add person → full row appears.
- **Split primary contact** — `contact_salutation/first_name/last_name/mobile` columns; form "Primary contact" section (Title dropdown + First + Last + Designation + Work phone + Mobile). `contact_name` still saved as the combined display value (backward-compat).
- **Default payment terms** — `customers.payment_terms_days`; form dropdown (Due on receipt / Net 15/30/45); invoice builder **pre-fills** the Terms/Due from the selected customer.
- **Billing + Shipping address** — `customers.shipping_address` jsonb (attention/address/city/state/zip/country); separate form section (billing stays the flat columns).
Types: `ContactPerson` + `ShippingAddress` + CustomerRow/Insert fields. Verified LIVE: all sections render, Add-person works, shipping renders. typecheck clean. Files: migration 0164, database.types, add-customer-form, quote-builder (terms pre-fill).
⏳ Follow-up (not done): show shipping address / extra contact persons on the invoice PDF (currently PDF uses billing + primary contact only).

### 🌍 Customer form — State/Province dropdown by country — ✅ BUILT (localhost, post-00171, awaiting deploy)
Pardeep: free-text state let a Kuwait customer be saved with "california". Now the State/Province field is a **dropdown of the selected country's states/emirates** for the markets we serve. New `lib/gst/states-by-country.ts` (`getStatesForCountry`) covers the Gulf (UAE/Saudi/Kuwait/Qatar/Oman/Bahrain) + US/UK/Canada/Australia; countries without a list fall back to free text. Changing country **resets** the state (clears a now-wrong value). India is untouched — it derives the state (with GST state code) from the GSTIN, the compliant source. Verified LIVE: Country → Kuwait turns State/Province into a select of Kuwait's 6 governorates, value reset. typecheck clean. Files: `states-by-country.ts` (new), `add-customer-form.tsx`.

### 🧾 Invoice builder — rich customer picker (Zoho-style) — ✅ BUILT (localhost, post-00171, awaiting deploy)
Pardeep liked Zoho's customer-select dropdown in the invoice. Replaced our plain `<select>` (names only) with a new `CustomerCombobox` (`components/features/customers/customer-combobox.tsx`): a Popover trigger showing the selected customer (avatar + name + email), a dropdown with a search box, a scrollable list (avatar · name · email/domain, active row highlighted + ✓), and a **"+ New customer"** footer that opens the AddCustomerForm and **auto-selects** the created customer (added an `onCreated` callback to AddCustomerForm). Wired into the quote/invoice builder (replaces the Select block). Verified LIVE: picker opens with search + avatars + email subtitles + New-customer; selecting "Client A" showed avatar+name+email in the trigger and cascaded GSTIN / place-of-supply / intra-state GST. typecheck clean, no console errors. Files: customer-combobox (new), add-customer-form (onCreated), quote-builder.

### 🧾 Invoice builder — Zoho-Books-style improvements — ✅ BUILT + TEST-GREEN (localhost, post-00171, awaiting deploy)
Pardeep shared Zoho Books' New Invoice page + wanted ours improved to match. Adopted the useful Zoho patterns (kept our reseller features — billing cycle, USD, margin — which Zoho lacks; did NOT do a risky full visual clone of the shared quote-builder):
1. **Terms → Due Date** (Zoho's core pattern): invoice mode now has a **Terms** dropdown (Due on receipt / Net 15 / Net 30 / Net 45) that auto-computes the **Due date**. Made REAL: migration 0162 adds `quotes.payment_terms_days`; migration 0163 re-creates `generate_invoice` to stamp `due_date = invoice_date + coalesce(payment_terms_days, 30)` (was hard-coded +30). Rolled-back test GREEN (`generate_invoice_payment_terms.test.sql`: Net15→today+15, null→today+30). Replaced the old read-only "Payment due (net 30)".
2. **Terms & Conditions** field (migration 0162 `quotes.terms_conditions`): document-level T&C textarea below Notes; flows to InvoicePDF + QuotePDF + operator preview + build-props. Invoice PDF footer "Payment terms" now shows real "Due by <date>" (was hard-coded "Net 30 days").
3. **Running total** in the sticky footer — already existed.
4. **Header/totals** — Invoice Settings row cleaner with Terms/Due; kept the clean card layout (no risky full restructure).
Verified LIVE: Terms Net 15 → Due "18 Aug 2026"; Notes + "Terms & conditions" both render. typecheck clean. Files: migrations 0162/0163 (+test), database.types, quote-builder, quote-preview-dialog, InvoicePDF, QuotePDF, build-props.

### 👥 Customers list — Zoho-Books-style rebuild (drop fake health) — ✅ BUILT (✅ DEPLOYED rev 00171)
Pardeep shared a Zoho Books customer list + wanted ours to match; also questioned the "health" column (correctly — nothing computes `health`, it's a static default ±outstanding penalty; a vanity metric borrowed from big CRMs without the signals). Rebuilt the customers table Zoho-style, contact + accounting oriented:
- **New columns:** Name · Contact · Email · Work phone · Place of supply · **Receivables** · **Unused credits**. Dropped Health (fake) + MRR/ARR + the chevron from the table.
- **MRR/ARR** kept in the header stat-strip (reseller's core recurring metric) → "N customers · ₹X MRR · ₹Y ARR · ₹Z receivables" (health/at-risk removed from header too).
- New bulk `useOpenCreditsByCustomer()` query (open customer_credits per customer). Receivables from existing outstanding map. Row rose-flag now = has receivables (real signal), not health.
- Views dropdown de-healthed: All · Has receivables · Has unused credit · With subscriptions · No subscription.
- Mobile cards rebuilt to match (name/contact/email/phone + Receivables/Credits row). Removed HealthBadge + unused imports.
- Verified LIVE (1400px): columns render, header shows MRR/ARR, zero h-scroll, no console errors. typecheck clean. File: `customers/page.tsx` + `queries/customers.ts`.

### 👥 Customers list — fake "70 · Watch" health for zero-subscription customers — ✅ FIXED (superseded by the Zoho rebuild above)
Design review of the live customers page: the desktop table HEALTH column rendered a `HealthBadge` (e.g. "70 · Watch") for EVERY customer — including 3 with no active subscription (₹0 MRR/ARR) — a meaningless/misleading score (same fake-data pattern we've killed elsewhere). The header avg/at-risk was already gated to active customers; only the list-table cell + row-atRisk were not. Fix: `customers/page.tsx` — `hasRelationship = !!sub || !!out`; the HEALTH cell shows the score only for a real money relationship (active subscription or outstanding balance), else **"New"**; `atRisk` (row rose-flag) now also gated on `hasRelationship`. Verified LIVE: Dummy/Excel/oishii (no sub) → "New"; Rakesh Dummy (₹2,970 MRR) → "70 · Watch". typecheck clean. (Mobile card already gated correctly.)

### 🧾 Invoice/quote builder — export logic fixes — ✅ BUILT (✅ DEPLOYED rev 00171)
Design review of the invoice builder for an export (US) customer surfaced two logical inconsistencies:
- **GST rate showed "18%" for an export/zero-rated customer** — contradicted the "Export → no GST" badge above (actual invoice was 0 GST, but the field misled). Now: for `isExport`, the GST field shows **0%**, disabled, helper "Export → zero-rated under LUT · no GST". `quote-builder.tsx` GST FormField.
- **Currency defaulted to INR for a clearly-foreign customer** — operator had to remember to switch. Now a one-shot effect defaults billing currency to **USD** for an export customer on a NEW quote (guarded: skips edit/duplicate, never fights a manual choice) + auto-fetches the latest ₹/USD rate. Verified LIVE (oishii-kw.com, US): GST → "0% · zero-rated", currency → USD @ ₹95.48 auto. typecheck clean.

### 🛡️ Launch-safety pass (deep pending-work audit, Aug 2026) — ✅ DEPLOYED rev 00170
Full codebase sweep for pending/stub/money-risky work before launch. Money-spine verified genuinely built + test-backed. Fixed the one **money-dangerous** gap + one operator-honesty gap:
- **🔴 Portal "Pay now" marked invoices PAID for ₹0 when Razorpay unconfigured** — `api/portal/invoice/[id]/pay/route.ts:120` took a simulation branch (called `record_payment`, flipped invoice paid, showed customer "Payment recorded. Thank you!") whenever keys weren't set — the DEFAULT state. A real portal customer could settle an invoice paying nothing. **Gated the simulation to non-prod** (`NODE_ENV !== "production"` or `ALLOW_PORTAL_PAY_SIMULATION=1`); in prod without Razorpay it returns an honest 503 "online payment not available yet — pay by bank transfer/UPI" (customer button already shows `data.error`).
- **Setup wizard claimed "provisioning is fully automated · Sync runs every 15 minutes"** (`setup/page.tsx:403`) — false, no such sync; operator could skip manual provisioning → customer gets no service. Rewrote to honest copy (reconcile available; license provisioning still done in Google Partner console).
- Verified NOT issues (stale LAUNCH_READINESS.md claims): cron renewals/trial-expiry are **fail-closed** (503 if CRON_SECRET unset, not fail-open); GSTIN mock lookups **already carry a "Mock data — configure Sandbox" disclaimer**; online-orders/command-palette "stub" comments are stale (both wired to real data). typecheck clean.
- **Needs Pardeep (external, can't fix in code)** — see "🚦 Launch blockers" below: Razorpay live KYC+keys; Resend domain verify (emails ship from sandbox/stub until then); GST e-Invoice/IRN (NOT built — legal e-invoice for B2B > ₹5cr); confirm prod Razorpay/CRON env secrets set.

### 🧾 Billing-cycle decouple (frequency ≠ price tier) — ✅ BUILT + TEST-GREEN (✅ DEPLOYED rev 00170)
Pardeep flagged: the "Billing cycle" picker was disabled until a line item existed, and it conflated two things — a line's `commitment` should be the product PRICE tier (Monthly-flex vs Annual), while billing cycle is an independent quote-level FREQUENCY; and a Monthly-flex line should force monthly billing. Decoupled (lowest-risk path, money-math untouched):
- **Migration 0161** — `quotes.billing_cycle` (monthly/quarterly/half_yearly/yearly, default yearly) + check + backfill from existing line commitments. record_payment/generate_invoice/subscriptions **unchanged** (frequency was already display-only; the "make a subscription?" gate keys off price tier `commitment is distinct from 'monthly'`, which holds for both new `annual_yearly` and legacy `annual_*`).
- **Types**: `BillingCycle` + `BILLING_CYCLE_INVOICES_PER_YEAR`; `QuoteRow/Insert.billing_cycle`; clarified `LineCommitment` JSDoc (now price tier). New shared `lib/quotes/billing.ts` (cycleInvoicesPerYear/cycleUnitLabel/cycleScheduleLabel/cycleFromLegacyCommitment) replaces 4 drift-prone duplicated helper copies.
- **Builder**: billing-cycle picker now ALWAYS enabled (quote-level, not gated on line items); a Monthly-flex line forces it to Monthly + disables other options + shows a hint; per-line "Commit" stays the price tier; saves `billing_cycle`.
- **Display**: QuotePDF + quote-preview-dialog + public quote-accept-view all read frequency from `billing_cycle` (with legacy per-line fallback); build-props + accept page.tsx select/pass it.
- Verified LIVE: picker enabled with 0 items (was disabled), changed to Quarterly, then a Monthly-flex line locked it to "Monthly — 12 invoices/yr" + hint + totals flipped to /mo. **Rolled-back money test GREEN** (`supabase/tests/record_payment_billing_cycle_decouple.test.sql`): ANNUAL+quarterly → 1 subscription, FLEX-monthly → 0 subscriptions (gate unaffected). typecheck clean.
- NOTE (honesty): frequency is still a stated schedule/label — quarterly does NOT yet emit 4 real invoices/yr (separate future feature: invoice scheduling + subscription cadence).

### 🔭 PLANNED (post-launch, NOT started) — GST-per-item model-cleanup
Correctness-of-model / future-proofing — **does not produce wrong numbers today** (every product is HSN 998313 @ 18%), so deferred until after deploy + real launch blockers (Razorpay live). Test-backed when built. (The sibling billing-cycle decouple is now DONE — see the ✅ entry above.)

**GST rate on the item, derived per-line (not a single quote-level rate)** — Pardeep flagged: GST is an item/HSN property; quote should derive per-line + sum, with HSN-wise breakup (GSTR-1). Today: items have `hsn` but NO `gst_rate`; quote applies ONE `tax_rate` (18%) to the whole taxable amount ([quote-builder.tsx:459-460]). Correct today only because every product is HSN 998313 @ 18%. Plan (when needed): add `items.gst_rate` (default 18) + migration; line inherits item's hsn+rate; quote/invoice compute per-line GST + sum + HSN-wise breakup; touches item-form, line-items, tax computation, PDFs, `generate_invoice` tax-breakdown (0116), GSTR-1 export. Value unlocks when a mixed-rate item is sold or proper HSN-wise GSTR-1 is needed.

### 🌍 Live exchange rates — auto-fetch ₹/unit from the internet — ✅ BUILT (✅ DEPLOYED rev 00170)
Pardeep: "exchange rate internet se update kare latest rates." The builder's International-billing block defaulted the rate to 1 → wrong numbers until hand-typed. Now: (1) new server route `GET /api/fx/latest?from=USD` fetches ₹/unit server-side (no CORS, cached ~1h) from open.er-api.com with a frankfurter.app fallback — returns `{rate, asOf, source}`; input restricted to our billing currencies; **not a money-write** (only a suggested, editable, then quote-stamped rate). (2) Quote/invoice builder auto-fetches the moment a foreign currency is picked, shows a green "✓ Latest rate: ₹X/USD · as of <date> (auto — override allowed)" line + a "🔄 Latest" refresh button; editing the field flips it to manual; the ⚠ "rate galat" warning now only shows while unset. Verified LIVE: route returns USD→₹95.50 / AED→₹26.00; picking USD in the builder auto-filled 95.4965 with the toast + status. typecheck clean. Files: `app/api/fx/latest/route.ts` (new), `components/features/quotes/quote-builder.tsx`.

### 🎨 Contacts page — layout deep-analysis + fixes — ✅ BUILT (✅ DEPLOYED rev 00170)
Pardeep: "is page ko deep study and analysis karo logical/user-friendly layout POV se aur kamiya improve karo." Deep review (World-Class Product Designer lens) found 3 real deficiencies + fixed:
1. **Horizontal scroll on desktop** — resizable-column defaults totalled **1174px**, overflowing even a 1440px screen (Phone/Source needed sideways scroll). Root cause: resize handles are px-anchored so the table must stay fixed-width. Retuned defaults + **dropped the low-value "Created" column** (still on the detail page) → total **944px**. Verified LIVE: overflow at 1280px went **101px → 0px**; 1440px = zero scroll, no dead-space scrollbar. Columns still drag-resizable.
2. **Redundant dual selection UI** — selecting contacts showed BOTH a GeminiCard (with Email/WhatsApp/Clear) AND a floating bottom bar (same 3 actions) at once — clutter that also pushed the list down. Removed the GeminiCard-on-select; the always-visible floating bar (survives scroll, thumb-friendly) is the single selection surface.
3. **No quick-reach actions** — a contacts *directory*'s core job is reaching a person fast, but every row forced you to open the record. Added row-hover **Email + WhatsApp** one-click actions (mailto / wa.me, focus-within for keyboard) alongside Promote (imported) + Open. Mobile card already had tappable email/phone.
Verified LIVE at 1280 + 1440 (no h-scroll, hover actions appear), no console errors, typecheck clean. File: `app/(app)/contacts/page.tsx`.

### 🎨 Polish sweep #1 — honest empty/error states + mobile gaps — ✅ BUILT (✅ DEPLOYED rev 00170)
World-class = polish + trust. Ran an Explore audit across all 11 list pages (empty/error/loading/mobile-card coverage). Most pages (leads/customers/quotes/invoices/payments) were already solid; fixed the worst gaps — priority = the trust bugs where a **failed load masqueraded as "all done / nothing here"** (same anti-pattern as the killed fake-success toasts):
- **documents** — `error` was never captured → a failed query rendered "No documents yet". Now captures `error`/`refetch` → honest "Couldn't load your documents" + Retry.
- **tasks** — `error` never read → a failed load showed a cheerful "Nothing on your plate today." (false positive). Now derives `loadError`/`refetch` per active bucket → "Couldn't load your tasks · this isn't 'inbox zero'" + Retry.
- **online-orders** — raw `useEffect` fetch: on error only `console.error`, left orders=[] → looked like an empty buy-flow; no loading state either. Refactored fetch into a reusable `load()` + `loading`/`loadError` state → skeleton while loading, honest error + Retry, empty only when genuinely empty.
- **renewals** — no top-level empty state (zero-subs tenant saw all-zeros strip + empty buckets; **blank on mobile**). Added a real "No subscriptions to renew yet" EmptyState (→ Create a quote / View customers); moved the per-bucket "No subscriptions in this window" OUT of `hidden md:block` so it shows on phones too; error retry now `refetch()` not `window.location.reload()`.
- **subscriptions** — Trials tab table was `hidden md:block` with no mobile parallel → **Trials tab fully blank on phones**. Added a `md:hidden` trial card list (company/plan/days-left/Convert).
Verified LIVE: renewals renders clean desktop + mobile (empty-bucket message now visible on phone), subscriptions renders clean. typecheck clean. Files: documents/tasks/online-orders/renewals/subscriptions `page.tsx`.

### 🎨 Polish sweep #2 — secondary tables → mobile cards + contacts CTA — ✅ BUILT (✅ DEPLOYED rev 00170)
Closed the deferred mobile gaps from sweep #1 (§20: no table should horizontal-scroll on phones):
- **payments** — Outstanding-receivables table + Project-payments table each got a `md:hidden` card list (table now `hidden md:block`). Outstanding card keeps the safe primary action (Record payment → quote); advanced money ops (suspend / write-off / reminder) stay desktop-only.
- **invoices** — "Pending GST invoice generation" table → mobile card list keeping the primary **Generate** action; bulk-select stays desktop.
- **quotes** — Project-quotes table → mobile card list (customer/project, amount, outstanding, status + the same actions dropdown: Open / Preview / Edit / Delete).
- **contacts** — empty state now has real CTAs (Add contact + Import CSV) instead of a dead-end message.
Verified LIVE on mobile viewport (375px): payments Project-payments card renders clean ("Client A · Custom accounting software · ₹5,40,000", no horizontal scroll). typecheck clean. Files: payments/invoices/quotes/contacts `page.tsx`. Polish sweep now COMPLETE (empty + error + mobile). Deferred to a future consistency pass: ₹/label/date micro-consistency audit across pages.

### 🤖 AI next-best-action on leads — 1-tap Gemini follow-up draft (the moat) — ✅ BUILT (✅ DEPLOYED rev 00170)
Roadmap P1 differentiator vs pre-AI incumbents (RackNap/Zoho). Customers already had an AI draft in their next-best-action; Leads did NOT — the "what do I say?" gap. Added a full-width **"✨ Draft follow-up with AI"** button to the lead detail drawer (between Call/WhatsApp/Email and the smart next-action CTA), reusing existing infra: `AiDraftButton` + `/api/ai/draft-followup` (Gemini Flash, stub fallback). Channel auto = WhatsApp if phone else email; purpose = followup (lead mode never touches money figures — money-safe for prospects). Draft is editable, Copy / Open WhatsApp, ZERO auto-send (human-in-the-loop). Small change to `ai-draft-button.tsx` (added `className` prop for full-width in drawer). Verified LIVE on localhost: opened "Client G Ltd" → button drafted a contextual Hinglish WhatsApp message referencing real contact (S.Godara), company, plan (Google Workspace Business Starter) + 10 seats; API 200, mode=gemini. typecheck clean. Files: `app/(app)/leads/page.tsx` (import + drawer button), `components/shared/ai-draft-button.tsx` (className prop). Closes fast-follow 171(b) for Leads.

### 🚀 First-run onboarding — Getting Started checklist (world-class polish) — ✅ BUILT (✅ DEPLOYED rev 00170)
Strategic review verdict: app niche me strong (tested money-spine, GST, international) par world-class polish + trust se ~1 layer door. Pardeep chose FIRST-RUN ONBOARDING. Built `GettingStartedCard` on the dashboard: 4-step guided path (set up GST profile → add first customer → create first quote → record first payment), each step ✓ from REAL data (no fake ticks), next step spotlighted (amber CTA), progress % + bar, auto-hides once all done. Fills the gap where a new tenant landed on an empty dashboard with no path. Verified (temporarily nulled setup_completed_at → card showed 75%/3-of-4, restored). File: `components/features/dashboard/getting-started-card.tsx` + dashboard wire.

### 🌍 International currency — real USD product pricing + USD invoices/quotes — ✅ BUILT (✅ DEPLOYED rev 00170)
Pardeep: "Google Workspace ka USD price alag hota hai, ₹ se convert nahi." So: (1) catalog item gets an optional real **USD price** (`prices.usd = {msrp, wholesale}` USD/seat/mo) — Items form has 🌍 USD price inputs. (2) Quote/invoice builder: when currency=USD, catalog lines use the item's USD price (canonical ₹ line = USD × 12 × rate; books stay ₹); a reprice effect re-values catalog lines on currency/rate change (order-independent). No USD price → ₹ converts (fallback). (3) Quote + Quote-preview + Invoice PDF/dialog all render USD-primary for foreign customers + "Export zero-rated" + "INR equivalent (for GST)". Verified: $7/mo item → 10 seats → **$840** (real) not $390 (converted), books ₹69,720. Files: database.types (ItemPrices.usd), item-form, add-line-item-dialog, quote-builder, QuotePDF, quote-preview-dialog, InvoicePDF, tax-invoice-dialog, build-props (9/9 vitest green).

### 🧾 Direct invoice via the real builders (catalog items, foreign, project) — ✅ BUILT (✅ DEPLOYED rev 00170)
Pardeep's steer: invoice items must come from the catalog (like quote), handle foreign customers, and work for projects too. So the bespoke line-item dialog was RETIRED; "Invoice" now opens a chooser → the real builders in invoice mode:
- **Subscription/service** → quote-builder `?invoice=1`: catalog items, seats, GST split, **foreign currency + export zero-rating** (all reused), one-time/recurring toggle, Save → quote (`is_one_off`) + `generate_invoice` → /invoices.
- **Project** → project builder invoice mode: one-time catalog items, GST, no milestones; Save → `create_project_direct_invoice` (migration 0160: create_project_quote → accept → raise, atomic) → /invoices.
Migrations 0157 (`is_one_off` + record_payment guard), 0158 (`create_direct_invoice`), 0159 (recurring option), 0160 (`create_project_direct_invoice`) — all DB→LIVE, all rolled-back tests green (subs guard, domestic/export GST, recurring→sub, project 200000/36000/18/236000/active). `InvoiceChooserDialog` wired on customer drawer + full page. Tests in `supabase/tests/`.

### 🤝 Referral & Commission — jo deal refer/close karaye usko commission — ✅ BUILT (✅ DEPLOYED rev 00170)
Migration 0156 (DB→LIVE): `referral_partners` + `referral_agreements` + `referral_commissions` + AFTER-INSERT trigger on `payments` (non-fatal — commission fail ho to bhi customer payment survive) + `pay_referral_commission` RPC. Per-deal one-time/recurring, % ya fixed, ex-GST base, per-partner 5% TDS (194H). Rolled-back test green (one-time guard, recurring, ex-GST, TDS, refund-ignore). UI: `/referrals` (Commissions | Partners + KPIs + payout), "Add referral" on customer detail, P&L "Referral commissions" expense line. Test: `supabase/tests/accrue_referral_commission.test.sql`.

### 🧱 Leads table: email→hover + Stage moved to 2nd column — ✅ BUILT (25 Jul, deploying rev 00151)
> Round-2 recs: #1 collapsible sidebar + #2 plan-truncate + #4 right-align money were ALREADY done (confirmed). #3 implemented: **email now off-row → shows on hover** (title tooltip + small ✉️ mail glyph as the cue; name + phone stay visible — phone is the pipeline CTA), and the **Stage column moved to 2nd position** (right after Company, before Contact) so pipeline status reads at a glance — moved both the header SortHeader and the inline-editable Stage cell together (10 headers = 10 cells, typecheck clean). `leads/page.tsx`. NOTE: couldn't reach the desktop list-view table in the flaky preview (kept showing kanban) to screenshot — verified via typecheck + structural consistency; verify on prod.

### 🏷️ Quotes: "Prorata" tag on add-seats quotes + Leads header/table polish — ✅ BUILT (25 Jul)
> **Prorata tag:** add-seats quotes (mid-term partial-period charges) now show a **"Prorata"** badge in the quotes list next to the ID, alongside the existing Extension/Renewal badges (`is_add_seats` → info badge, mobile + desktop views). Verified Q-ET-2026-27-0008 (is_add_seats=true). `quotes/page.tsx`.
> **Leads #2 (header declutter):** the 5 secondary header buttons (Import CSV · Send campaign · Import from Google · Share enquiry form · [Start trial on deals]) rolled into ONE **"More" dropdown** — header now shows only Search · Filter · More · **+ Add Lead**. Browser-verified. `leads/page.tsx`.
> **Leads #4 (equal row height):** the Plan column ("Google Workspace Business Starter" wrapped to 4 lines → uneven tall rows) now **truncates to one line with a hover title tooltip** (max-w-190 + whitespace-nowrap on seats). `leads/page.tsx`.
> **#1 (value/stage scroll):** was a narrow-viewport thing; on desktop the columns fit, and #4's truncate helps. **#3 (sidebar default icon-only):** NOT done — recommended keeping the existing Collapse toggle (default expanded) rather than defaulting collapsed; awaiting Pardeep's call.
> **Deploy saga:** several deploys failed — first gcloud auth expired (computer slept → Pardeep re-logged in), then multiple builds failed because the deploy ran from the repo ROOT (no Dockerfile → buildpacks "no groups passed detection") instead of `production/` (the documented cwd gotcha — must run from production/). Fixed; rev 00149 = prorata + Leads #2; rev 00150 (deploying) = + Leads #4.

### 👁️ Documents/Employee-docs: in-app file viewer (renders PDFs everywhere) — ✅ FIXED (24 Jul, ✅ DEPLOYED rev 00170)
> Clicking View downloaded / showed a black box: signed URLs serve as attachment, window.open got popup-blocked, and native `<object>/<iframe>` PDF embedding failed in the plugin-less preview window (images rendered fine — proved the pipeline; PDFs need a native viewer). Final robust fix: **`DocViewerDialog`** fetches the file bytes and renders **inside an in-app modal** — **PDFs via pdf.js (`pdfjs-dist`) drawn page-by-page to `<canvas>`** (no dependency on the browser's native PDF plugin, so it works in ANY browser incl. the embedded preview), **images via `<img>`**, everything else offers Download (Download always present). Wired into `documents/page.tsx` + `employee-detail-drawer.tsx`. **Browser-verified in the preview window:** GST.pdf renders fully (GST cert visible), logo image renders, no console errors. New dep: `pdfjs-dist@^4.10` (justified — reliable cross-browser in-app PDF viewing; worker via `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`). `doc-viewer-dialog.tsx`.

### 📁 Documents vault: business-scheme categories + Branding/Logo — ✅ BUILT (24 Jul, migration 0129 DB→LIVE; app ✅ DEPLOYED rev 00170)
> App already HAS a Company Document Vault (`/documents` — categories, search, expiry reminders, private storage) — Pardeep didn't realise it. Aligned its categories to his Google-Drive/Cowork scheme + added a **Branding / Logo** bucket (his ask: put the company logo under a Logo heading). New scheme: **Legal · Finance · HR/Employees · Operations · Sales & Marketing · Admin · Branding/Logo · Other** (was compliance-shaped: company_legal/gst_tax/banking/agreements/licenses/hr/other). Migration 0129 swaps the `documents_category_check` CHECK + remaps existing rows (company_legal/agreements/licenses→legal, gst_tax/banking→finance, hr→hr) and moves any doc titled "*logo*"→branding. Updated `DocumentCategory` union, `DOCUMENT_CATEGORIES`, upload-dialog default, and the server-side `api/documents/route.ts` category whitelist. **Browser-verified:** Anutech logo now shows under "Branding / Logo", GST under "Finance". `0129_document_categories_business_scheme.sql`, `documents.ts`, `database.types.ts`, `upload-document-dialog.tsx`, `api/documents/route.ts`.
> NOTE: HR split refactor below hit a Next.js rule — a `page.tsx` can't have arbitrary named exports. Fixed by moving all shared HR screens/dialogs into `payroll/screens.tsx` (a non-page module); `payroll/page.tsx` + employees/leave/attendance pages import from there. typecheck + browser clean.

### 🗂️ HR: split combined Payroll & Leave page into separate pages — ✅ BUILT (24 Jul, ✅ DEPLOYED rev 00170)
> The one tabbed `/accounting/payroll` page (Run payroll / Employees / Attendance / Leave) is now **4 separate routes**, each with its own HR-shell header + breadcrumb: **/accounting/employees** (Employees), **/accounting/payroll** (Payroll — run payroll + statutory-dues banner, tabs removed), **/accounting/leave** (Leave), **/accounting/attendance** (Attendance register + network settings). Done by `export`-ing the tab components (EmployeesTab/PayrollTab/LeaveTab/AttendanceTab) + a shared `HrPageShell` from the payroll page module and rendering each in a thin route page (no code duplication; shared dialogs stay in one module). HR sidebar now: Employees · Payroll · Leave · Attendance · Attendance Kiosk · Employee Loans; breadcrumbs updated. Browser-verified all 4 pages render. typecheck clean. `payroll/page.tsx`, `employees/page.tsx`, `leave/page.tsx`, `attendance/page.tsx`, `nav.ts`. (Minor: a couple of in-page copy strings still say "Employees tab" — cosmetic, can tidy later.)

### 🔗 Sidebar: "Google Drive" quick link under Documents — ✅ BUILT (24 Jul, ✅ DEPLOYED rev 00170)
> Added an external nav item "Google Drive" right below Documents (Workspace section) → opens `https://drive.google.com` in a new tab (each user's own Drive; not a hardcoded tenant folder). New `external?: boolean` flag on NavItem; Sidebar's renderLink now sets `target="_blank" rel="noopener noreferrer"` + an external ↗ glyph for such items. Browser-verified (href/target/rel correct). `nav.ts`, `Sidebar.tsx`.

### 🧭 Sidebar: dedicated "HR" section — ✅ BUILT (24 Jul, ✅ DEPLOYED rev 00170)
> Payroll & Leave, Attendance, and Employee Loans were buried inside the Accounting menu. Moved them into a new **HR** nav section (owner/manager) placed right after Accounting; updated breadcrumbs (`/accounting/payroll` → HR · Payroll & Leave, `/attendance/kiosk` → HR · Attendance, `/accounting/loans` → HR · Employee Loans). Accounting now holds only finance items. `nav.ts`. Browser + DOM verified (HR section + all 3 links render; breadcrumb reads HR / …).

> ✅ **DEPLOYED rev 00144 (24 Jul 2026):** Employees profile+document vault · Quotes latest-on-top · Subscriptions Edit/Delete/"•••"/design-fixes · Payments Delete/"•••" · Expenses partial tag · P&L drill-down search+payee-group(collapsible)+subtotals. Migrations 0126/0127/0128 already live on DB.

### 👤 Employees: full HR profile + document vault — ✅ BUILT (24 Jul, migration 0128 DB→LIVE; UI ✅ DEPLOYED rev 00170)
> Employees now hold a full profile + private document vault. **Schema (0128):** added email/phone/designation/date_of_birth/address/emergency_contact_name/emergency_contact_phone to `employees`; new `employee_documents` table (tenant-scoped RLS) + a **PRIVATE storage bucket `employee-docs`** with tenant-scoped object policies (`(storage.foldername(name))[1] = current_tenant_id()`); path `{tenant}/{employee}/{uuid}-{file}`. **PII** (Aadhaar etc.) only ever served via 5-min signed URLs. **UI:** Add/Edit employee dialog extended with the new fields (scrollable); clicking an employee name opens a **detail drawer** — read-only profile grid + a **Documents** section (type select: Aadhaar/PAN/Voter ID/Resume/Offer letter/Other → upload → list with View (signed URL) / Delete). Hooks: `useEmployeeDocuments`, `useUploadEmployeeDocument` (rolls back the storage object if the row insert fails), `useDeleteEmployeeDocument`, `getEmployeeDocUrl`. **Browser-verified end-to-end** (real HITESH BABU): drawer + profile render; uploaded a test doc → appeared in list (storage RLS + row insert OK); deleted it → gone (storage API + row); bucket confirmed empty after. typecheck clean. `0128_employee_profiles_documents.sql`, `payroll.ts`, `employee-detail-drawer.tsx`, `payroll/page.tsx`, `database.types.ts`. **Form layout fix (Pardeep, post-00144, localhost):** the Employee dialog was cramped — narrow (max-w-md), all fields stacked tall, and a DOUBLE scrollbar (inner `max-h/overflow` on top of DialogContent's own scroll). Rewrote it: **wider** (md:max-w-2xl), grouped into **3 sections** (Basics · Payroll & statutory · Emergency & access) with a responsive **2-col grid** (`Field` helper), removed the inner scroll so there's a **single** clean scrollbar, added a subtitle. Also **added PAN / PF no. / ESI no. inputs** (the drawer showed them but the form had no way to set them). Browser-verified. Awaiting deploy.

### 🔽 Quotes: latest quote on top by default — ✅ FIXED (24 Jul, ✅ DEPLOYED rev 00170)
> The list ordered by `created_date` (a DATE), so same-day quotes had no stable order — Q-…-0008 (newest) showed BELOW 0007. Changed `useQuotes` (+ `useQuotesByLead`) to order by **`created_at` (timestamptz)** desc, `nullsFirst:false`. Browser-verified: 0008 now on top, then 0007. `quotes.ts`.

### 🛠️ Subscriptions: fix a mistake — Edit (correct details) + guarded Delete — ✅ BUILT (24 Jul, migration 0127 DB→LIVE; UI ✅ DEPLOYED rev 00170)
> Answer to "subscription me galti ho gayi to kaise thik karein": a subscription = a paid quote's result (payment↔quote↔PO↔sub linked), so fix by mistake-type. New leads-style **"•••" menu** on each subscription row: **Correct details · Add seats · Extend term · —— · Delete subscription** (rose). **Correct details** = `EditSubscriptionDialog` (plan/vendor/seats/MRR/start+renewal date/status) → `useUpdateSubscription` plain record update (does NOT re-bill or touch payment/invoice). **Delete** = guarded RPC `delete_subscription` — **blocks** if it came from a paid quote (delete the payment instead → unwinds cleanly) or a linked PO is past draft; else drops draft POs + the sub (tasks/renewal-log cascade). **Tested (rolled-back):** paid-sub (Rakesh) delete → blocked; manual/no-payment sub → deleted. typecheck clean; browser-verified the menu + pre-filled Correct dialog. `0127_delete_subscription.sql`, `subscriptions.ts` (useUpdateSubscription/useDeleteSubscription), `edit-subscription-dialog.tsx`, `subscriptions/page.tsx`, `database.types.ts`.
> **Design/layout pass (same page, 24 Jul):** (1) killed the **"Manual add" dead-end** (primary button that only toasted) → now **"New subscription"** routes to the quote builder `/quotes/new` (the real creation path). (2) **Decluttered the actions column** — removed the redundant standalone `clock`/Extend icon (it lives in the "•••" menu now); rows show just the primary quick action (+Seats / Renew) + "•••". (3) **SEATS clarity** — `10 (0)` → `10 · 0 used` with a "Licensed · in use" header tooltip. Browser-verified: New subscription → /quotes/new, seats reads clearly, actions decluttered. **Follow-up (Pardeep caught):** "Add seats" was showing in BOTH the visible "+ Seats" button and the "•••" menu — removed it from the menu (menu now = Correct details · Extend term · Delete; label "Actions"); the quick "+ Seats" button stays. Duplicate-affordance review-miss, fixed + verified.

### 🗑️ Payments: delete a payment (safe reverse) — ✅ BUILT (24 Jul, migration 0126 DB→LIVE; UI ✅ DEPLOYED rev 00170)
> `record_payment` does a lot (lead→customer, subscription + PO, quote status, invoice-paid), so delete goes through a guarded atomic RPC `delete_payment(p_payment_id)` — NOT a raw table delete. **Guards (block):** GST invoice already issued for the quote (cancel/credit-note first) · payment reconciled to a bank line (un-reconcile first) · add-seats quote (manage via subscription) · a linked PO past 'draft' (handle manually). **Reversal:** delete the payment (RV number retired, gap OK) → recompute quote payment_amount/status from remaining received payments → if nothing left, **full undo** (delete the subscription(s) + auto-PO this quote created, revert the won lead to 'quote', **keep the customer**); if a balance remains, re-open the subscription's outstanding. Pardeep chose "full undo" scope. **Tested (rolled-back, real Rakesh ₹38,232 payment):** happy→ deleted, status=none, sub+PO removed, lead→quote; guards invoice/bank/add-seats all block; partial (2 payments, delete 1)→ status=partial, sub kept, outstanding=28,232. UI: the payments row actions are now a **leads-style "•••" dropdown menu** (Open quote · Edit details · Receipt voucher · —— · Delete payment in rose), replacing the inline buttons; Delete confirms + explains the reversal. Browser-verified the menu renders with all items. `0126_delete_payment.sql`, `payments.ts` (useDeletePayment), `payments/page.tsx`, `database.types.ts`.

### 🔎 P&L drill-down dialog: search + group + subtotals — ✅ BUILT (24 Jul, ✅ DEPLOYED rev 00170)
> The shared P&L drill-down (`pnl-drilldown-dialog.tsx`, opened from the P&L Report's Revenue / COGS / Operating-expenses lines) now has: a **search box** (filters on the row's visible text), a **Group toggle** (groups by the natural key per kind — expenses→category, revenue→customer, cogs→vendor — biggest group first, with a per-group subtotal), and a **bottom total bar** that reflects the filtered set (shows group count + "(filtered)" when a search is active). **Browser-verified** on Operating expenses: grouped → "SALARIES · 9 → ₹7,20,000" + footer "1 GROUP · TOTAL · 9 ITEMS ₹7,20,000"; searching "hitesh" → 2 rows, ₹1,50,000, footer "(FILTERED)". typecheck clean. Benefits Revenue + COGS drills too. **Fix (Pardeep caught):** grouping was by `primary`=category, so all salaries collapsed into one useless "SALARIES · 12" bucket. Changed the expenses mapping so **primary = payee** (employee for salaries, vendor otherwise) and the category + period moved to the detail line (trailing " — <name>" stripped). Now Group buckets **per employee/payee** — browser-verified: PARDEEP SHARMA · 3 → ₹2,90,000, HITESH BABU · 3 → ₹2,25,000, 5 groups · ₹9,25,000. groupLabel "payee". Flat list is also payee-first now. **Collapsible groups (Pardeep):** in grouped mode each group is now an accordion — **collapsed by default** (only name · count + subtotal), click the header to **slide the rows open** (framer-motion height animate, chevron rotates); a live search auto-reveals all. Browser-verified: all 5 groups collapse by default, header click slides open/closed. `framer-motion` import added.

### 🏷️ Expenses: "Partial" reconcile tag on partially-paid salary expenses — ✅ BUILT (24 Jul, ✅ DEPLOYED rev 00170)
> A Salaries expense now shows a tag driven by its **salary's paid_status** (not just expense.reconciled_txn_id, which partial payments don't set): **✓ Reconciled** (green) when the salary is fully paid, **◐ Partial · ₹paid/₹net** (amber) when partially paid, nothing while unpaid. Non-salary expenses keep the reconciled_txn_id-based ✓ Reconciled. `reconcileTag()` + `<ReconcileTag>` in `expenses/page.tsx`, fed by a `useSalaryPayments()` expense_id→salary map. **Browser-verified** against real prod data (Pardeep reconciled real TPT-SALARY lines partially after rev 00143): e.g. Ranjeet Apr ◐ Partial ₹31,000/₹70,000, HITESH May ◐ Partial ₹52,000/₹75,000, Pardeep Sharma ✓ Reconciled. Every partial's paid_amount == its single matched bank-line debit (data integrity confirmed). typecheck clean; the payroll-page SWC console errors seen during editing were stale (page renders fine, JSX balanced, tsc 0 errors).

### 📅 Payroll: calendar icon per row → full-year (FY) payroll calendar — ✅ BUILT (24 Jul, ✅ DEPLOYED rev 00170)
> On the payroll table, each row's Action column has a **calendar icon button** (name stays plain text, per Pardeep) → opens a dialog "**{name} — payroll FY 20xx–yy**" showing all 12 Indian-FY months (Apr→Mar), each with net pay + status (Paid / Partial / Unpaid / Not run), plus a footer (Months run N/12 · Year net · Cleared). Tap any month row → jumps the page's month picker to it (to pay/undo/view). New hook `useEmployeeSalaryHistory(employeeId)`. **Browser-verified:** Darshan's card showed Jul 2026 ₹8,000 Paid + totals 1/12·₹8,000·₹8,000; tapping Apr 2026 switched the page to April (surfaced a real Pardeep Sharma ₹90,000 Paid + Ranjeet Partial ₹31,000/₹70,000). typecheck + console clean. `payroll/page.tsx` (EmployeePayrollYearDialog), `payroll.ts`.

### 💸 Payroll: PARTIAL salary payments (paid less than the full salary) — ✅ BUILT (24 Jul, migration 0125 DB→LIVE; app UI ✅ DEPLOYED rev 00170)
> Need: pay part of a salary now (cash crunch), rest owed + paid later. `net` stays the full earned amount; new `salary_payments.paid_amount` tracks how much has cleared the bank; `paid_status` derives — **unpaid** (0) → **partial** (0<x<net) → **paid** (≥net). The bank-line trigger `sync_salary_paid_status` is now **amount-based**: each reconciled money-out line adds its debit to the matched salary's paid_amount; un-reconcile subtracts. A full match (debit==net) still lands straight on 'paid' (backward-compatible). Split reconcile sets paid_amount=net for its salaries. `delete_salary_payment` now blocks on `paid_amount>0` (a partial has bank lines attached even before reconciled_txn_id is stamped). Balance sheet "Salary payable" = Σ(net − paid_amount) for non-paid rows (only the still-owed slice). UI: reconcile dialog has a new **"Pay a salary (full or part)"** picker (lists unpaid/partial salaries with remaining; disables lines that would over-pay); payroll shows a **"Partial · ₹x/₹net"** badge + hides Undo once paid_amount>0. Migration 0125. **Tested (rolled-back):** pay→unpaid/0, +₹70k→partial/70000, +₹20k→paid/90000, −₹20k→partial, undo-while-partial→blocked, −₹70k→unpaid/0; expense-match + split paths still full→paid. **Browser-verified** end-to-end: applied ₹24,800 to a ₹70,000 salary → "Partial · ₹24,800/₹70,000", Undo hidden; then reversed + cleaned up. `0125_partial_salary_payments.sql`, `payroll.ts` (useUnreconciledSalaries), `bank.ts`, `reconcile-transaction-dialog.tsx`, `payroll/page.tsx`, `balance-sheet.ts`, `database.types.ts`.

### 🧭 Reconcile: salary → Payroll only (✅ DEPLOYED rev 00170)
> Policy: salaries have ONE door — Payroll & Leave (payslip + statutory + paid-status + the Salaries expense). The reconcile "Book as a new expense" flow could book category "Salaries" → an off-payroll salary expense with no payslip + double-count if payroll later runs. Fix (final): **"Salaries" removed from the reconcile category dropdown** entirely (don't offer what you can't do here), plus a **"Open Payroll & Leave →" shortcut** that closes the dialog and jumps straight to `/accounting/payroll`. Verified on the ₹70k ABHISHEK line: dropdown has 12 categories, no Salaries; shortcut navigates to payroll. `reconcile-transaction-dialog.tsx`. ✅ Follow-up done (✅ DEPLOYED rev 00170): the **Expenses "Add expense" dialog** now also excludes "Salaries" from the category dropdown (kept only when editing a legacy Salaries expense) + shows a "Book it in Payroll & Leave →" shortcut. Verified: shortcut navigates to /accounting/payroll. `add-expense-dialog.tsx`. So salaries redirect to Payroll from BOTH doors now.

### 🐛 Leads: SwipeLeadCard nested-button hydration error — ✅ FIXED (24 Jul, ✅ DEPLOYED rev 00170)
> The mobile swipe card wrapped everything (incl. call/WhatsApp/quote action `<button>`s) in an outer `<button>` → "button cannot be a descendant of button" hydration error. Converted the outer to `<div role="button" tabIndex=0>` with Enter/Space keyboard handling + focus ring. Verified: `document.querySelectorAll('button button')` = 0, 18 cards render, tsc clean. (The spawned background session for this was stuck — clean worktree, no commits — so fixed directly. Two idle sessions `zealous-chebyshev` / `relaxed-lewin` can be closed.) `swipe-lead-card.tsx`.

### ↔️ Banking: resizable Description column (✅ deployed rev 00141)
> The Description column truncated long RTGS/salary narrations. Added a drag-handle on the Description header edge (always-visible grip, 12px hit area, col-resize cursor) → drag to set the column width (clamped 140–760px, `descW` state applied to header + every row cell). Also added `title={description}` on the cell so hovering shows the full text as a fallback. Verified: dragging grew the column 437→617px, full RTGS narration visible. `banking/[id]/page.tsx`.

### 🧾 Expenses page: reconciled badge + date presets — half-year now FY-aligned (✅ deployed rev 00141)
> (1) Each expense now shows a green "✓ Reconciled" chip when it's matched to a bank line (`reconciled_txn_id` set) — table + mobile card. (2) Quick date-range presets above the FROM/TO pickers: This month / This quarter / Half-year / This FY / Previous FY (Indian FY Apr–Mar), active one highlighted. Verified: "This FY" → 01-04-2026→31-03-2027, reconciled salary-expenses show the badge, unreconciled don't. `accounting/expenses/page.tsx`.

### 🐛 Payroll: "paid" (but un-reconciled) salary was un-removable — ✅ FIXED (24 Jul, migration 0124; guards DB→LIVE, Undo-button UI localhost→deploy)
> 0120's guard blocked undo/expense-delete whenever paid_status<>'unpaid'. But legacy rows were migrated to 'paid' with NO bank link, so they got stuck: no Undo on the payroll row (only unpaid showed it) AND the expense refused to delete → dead end (Pardeep's Mar-2026 ₹90k). Correct rule: block ONLY when actually bank-reconciled (`reconciled_txn_id is not null`). Relaxed both `delete_salary_payment` + `tg_expense_delete_guards_salary`; payroll Undo button now shows whenever `!reconciled_txn_id` (paid or unpaid). **Verified:** Mar-2026 paid row got an Undo → removed salary + expense, "Paid this month" ₹90k→₹0, DB clean.

### ✅ DEPLOYED rev **00140** (24 Jul 2026) — Bonus/Incentive + Multi-expense split reconcile
> Both UI features below are LIVE (00140). Prod smoke-test: app 200, cron 401 (CRON_SECRET intact). Migrations 0121–0123 on prod DB.

### 🔗 Banking: match ONE bank line to MULTIPLE expenses (split reconcile) — migrations 0122/0123 on prod DB
> Several things paid in one transfer (e.g. 2 months' director salary ₹90k + ₹1.1L = ₹2L RTGS) couldn't reconcile — the 1:1 suggester found nothing. Added a **"Combine multiple expenses"** section in the reconcile dialog (money-out lines): tick expenses that add up to the line, running total gates the button at exact match. Since salaries book a 'Salaries' expense, this covers multi-salary too — matching salary-expenses flips their salaries to paid. RPC `reconcile_expenses_to_bank_txn` tags the line 'split' + links each expense (+ new `expenses.reconciled_txn_id`); the `sync_salary_paid_status` trigger reverts salaries **and** expenses on un-reconcile. Single 'expense'/'project' matches also now set the reverse-link (reliable candidate filter). **Money-tested (rolled back)** + **real:** reconciled the actual ₹2,00,000 → 'split', 2 salaries paid, 2 expenses linked; app balance 5.4L→3.4L, gap −7.15L→−5.15L. (Salary-specific RPC 0122 superseded by the general expense one.)

### 💰 Payroll: Bonus / Incentive earning (migration 0121 on prod DB; app UI ✅ DEPLOYED rev 00170)
> No way to pay a one-time bonus/incentive without inflating "gross" (mislabels the payslip). Added an `incentive` earning: `salary_payments.incentive` col + `pay_salary` gained `p_incentive` (earned = gross − LOP + incentive; adds to net + the Salaries expense). Pay-salary dialog has an "Earnings (on top of salary)" → "Bonus / Incentive" field (live summary + Pay button update); payslip PDF shows a separate "Bonus / Incentive" line. **Money-tested (rolled back):** gross 30k + bonus 5k → net 35k, expense 35k, incentive stored. **Browser-verified:** ₹90k + ₹10k bonus → Pay ₹1,00,000.

### 🏦 Banking "Balance in app vs bank" + Payroll "Undo" — ✅ DEPLOYED rev **00139** (24 Jul 2026)
- **Banking reconciliation view** (`banking/[id]/page.tsx`): **Balance in bank** (opening + all statement lines) vs **Balance in app** (opening + only reconciled lines) + **To reconcile** (the gap). Ties out: bank − app = to-reconcile. Verified: bank ₹-1,75,835, app ₹5,40,000, gap ₹-7,15,835 (19 unreconciled).
- **Payroll "Undo" button** (`payroll/page.tsx` + `useDeleteSalaryPayment`): unpaid salary rows get an Undo → `delete_salary_payment` RPC → reverts to "Pay salary" (removes salary + its expense atomically). **Verified end-to-end** (paid Deepak → Undo → reverted, 0 residue). Complements the trigger so users can undo from Payroll instead of hunting the expense.

### 🐛 Payroll: deleting a salary's expense orphaned the salary — ✅ FIXED (24 Jul, migration 0120, DB-level → LIVE on prod)
> Pardeep paid a ₹90k salary → it booked a 'Salaries' expense → he deleted that expense → the FK (`salary_payments.expense_id ON DELETE SET NULL`) nulled the link but LEFT the salary_payment (unpaid), so payroll showed "unpaid + Payslip" with no way to re-pay (should show "Pay salary"). Fix: (1) `delete_salary_payment(id)` RPC — atomic reversal (restore advance recovery + reopen loan, delete linked expense, delete salary_payment; guarded unpaid & not reconciled). (2) `trg_expense_delete_guards_salary` BEFORE-DELETE trigger on `expenses` — deleting a Salaries expense now reverses its unpaid salary (no orphan), or blocks with a clear message if the salary is paid/reconciled. (3) Cleaned the existing orphan (Pardeep Jul). **Verified:** payroll now shows "Pay salary" for Pardeep + "Paid this month" corrected ₹98k→₹8k; rolled-back trigger test green. ⏳ Fast-follow (needs deploy): an "Undo" button on unpaid payroll rows → `delete_salary_payment` (so users undo from Payroll, not by hunting the expense).

### 🔧 Post-00137 UX/reconcile changes — ✅ DEPLOYED rev **00138** (24 Jul 2026)
> All four items below are LIVE (00138). Prod smoke-test: cron 401 (CRON_SECRET intact), app 200. Migrations 0119 already on prod DB.
- [x] ~~Cloud Scheduler set up~~ ✅ (24 Jul) — enabled Cloud Scheduler API on resellsubsos-prod; created 2 ENABLED jobs (`resellersos-renewals` 09:00 IST, `resellersos-trial-expiry` 10:00 IST) hitting the cron endpoints with `Authorization: Bearer $CRON_SECRET`. Renewal/trial reminder emails now auto-fire daily.
- [x] ~~Reconcile suggester ignored project payments~~ ✅ (24 Jul, migration 0119 on prod DB; dialog/link app-side localhost) — `suggest_bank_transaction_matches` now also offers un-reconciled `project_payments` (bank_txn_id null) for money-in lines (`match_type='project'`). Reconcile dialog labels it "Project"; `useReconcileTransaction` keeps the `project_payments.bank_txn_id` reverse-link in sync. Money-safe (project payment = receivable reducer, bank credit = cash-in; linking, no double-count). **Verified end-to-end:** the real ₹5,40,000 Excel advance now suggests (exact) → Match → reconciled, both sides linked. Types: added `project` to BankMatchToType / BankMatchSuggestionRow / MatchSuggestion.
- [ ] **"Add service" tab-aware** (✅ deployed rev 00141): on `customers/[id]`, the card's primary button now follows the active card tab — Subscription → subscription quote (`/quotes/new?customer`), Project → project quotation dialog with the customer pre-selected (`prefillCustomerId` added to CreateProjectQuoteDialog). Was: always opened the subscription builder.
- [ ] **Banking transactions — no forced horizontal scroll** (✅ deployed rev 00141): the account transactions table forced a horizontal scroll (Reconcile button clipped) on narrow/tablet widths. Fixed per §20: dropped the table `min-w-[680px]`, Description column now truncates fluidly (`max-w-0` + `truncate`), and the table→card breakpoint raised `md`→`lg` so narrow/tablet shows the full card list (complete description + full-width Reconcile) and the table only renders ≥1024px where every column fits. Verified at 820px (cards) and 1280px (table), no side-scroll either way.
- [ ] **Customer 360 — Subscription/Project tabs** (✅ deployed rev 00141): the "Subscriptions & projects" card on `customers/[id]/page.tsx` now has a `TabBar` Subscription|Project toggle (with counts) like Quotes/Invoices/Payments — instead of showing both merged. Verified on localhost. ⏳ Redeploy to ship.

### 🔍 Deep audit (24 Jul 2026) — launch-blockers before public/multi-tenant / paying customer
> 4-lens code-verified audit (money / security / UX / product). Full report: Claude artifact "ResellerOS Deep Audit". Top-3 headline findings personally code-confirmed. These are money/security-sensitive → each needs Pardeep sign-off + a green test before ship (CLAUDE.md §0.4).
- [x] ~~**SEC-1 (CRITICAL):** public quote link keyed on the sequential `quotes.id`~~ ✅ **FIXED (24 Jul, migration 0115 — applied to prod DB; app changes localhost-only, awaiting deploy).** Added opaque `quotes.public_token uuid` (random, unique). Public read page + accept API now require `?t=<token>` (constant-time compare via `lib/quotes/accept-token.ts`; pure URL builders in `lib/quotes/accept-link.ts` for client) — no/wrong token → 404 (no enumeration signal). Public page now serves a **customer-SAFE DTO** (no `total_cost`/per-line cost/`public_token`). All 5 link-generation sites append the token (quotes send, v1-mappers, renewals send-now + cron, owner copy-link ×2). **Verified:** no-token→404, wrong-token→404, right-token→renders, cost `6600`/`1320` absent from HTML payload. Tests: `accept-link.test.ts` (7) + updated v1-mappers; vitest suite 112/112 green (added `@` alias to vitest.config). ⚠️ Old already-sent links (no `?t=`) now 404 — owner re-copies the link (expected for a security fix; ~no real external links pre-launch).
- [x] ~~**MONEY-2 (root cause — fixes MONEY-1 + MONEY-2 + MONEY-5):** persist the GST breakdown on invoices~~ ✅ **FIXED (24 Jul, migration 0116 — applied to prod DB; app reads localhost-only, awaiting deploy).** Added `invoices.taxable_value/tax_amount/tax_rate/inter_state` (+ backfilled existing, identity `taxable+tax=amount` held). `generate_invoice` now persists from the quote's subtotal/discount/rate + customer-vs-tenant state; `raise_project_milestone_invoice` reverse-derives from the project rate/inter_state. **Reads:** P&L revenue = `Σ taxable_value` (GST no longer counted as income — **MONEY-1**); GST report reads persisted `tax_amount` + splits CGST/SGST vs IGST by `inter_state`, CSV gained place-of-supply + CGST/SGST/IGST columns (**MONEY-2**); `build-props.ts` project invoices now show real GST via `invoiceAmounts()` (**MONEY-5**). **Money-tested (rolled back):** subscription 16200+2916=19116, project 580508+104492=685000. **SQL test** `invoice_tax_breakdown.test.sql` (intra/inter/project) green. **Browser-verified:** P&L revenue ₹4,57,627 (was ₹5,40,000 inclusive); GST report Head=CGST 9%+SGST 9% ₹41,187+₹41,186. typecheck + vitest 112/112 green.
- [x] ~~**MONEY-3:** invoice delete reused the GST serial (Rule 46 breach)~~ ✅ **FIXED (24 Jul, migration 0118 — applied to prod DB; dialog copy localhost).** Dropped the `last_number - 1` rollback tail from `delete_subscription_invoice` + `delete_project_invoice` — delete still corrects mistakes (payments reversed, milestones freed) but the number is **retired, never reused** (Pardeep chose this over a full Credit Note flow, which is now a roadmap item for cancelling issued invoices). Delete dialog now says the number is retired + why. **Verified (rolled back):** after delete the series stayed at 6, next invoice = 0007 (no reuse). SQL test `invoice_delete_no_serial_reuse.test.sql`.
- [x] ~~**SEC-2:** `next_document_number` / `next_customer_number` trusted a caller-supplied tenant~~ ✅ **FIXED (24 Jul, migration 0117 — applied to prod DB).** Authenticated callers (`current_tenant_id()` not null) are forced to their own tenant; a mismatched explicit `p_tenant_id` → `insufficient_privilege`. service_role (null caller) still passes tenant explicitly. `next_customer_number` also revoked from PUBLIC (granted authenticated + service_role). **Verified (rolled back):** cross-tenant alloc rejected; own tenant (null + explicit) returns Q-ET-…-0007/0008.
- [x] ~~**SEC-3:** cron routes fail-OPEN if `CRON_SECRET` unset~~ ✅ **FIXED (24 Jul, localhost — awaiting deploy).** `/api/cron/renewals` + `/api/cron/trial-expiry` now **fail closed**: no `CRON_SECRET` → 503; wrong/missing bearer → 401 via constant-time `timingSafeEqualStr` (`lib/crypto/timing-safe.ts`). **Verified:** unauth GET on both → `{"error":"cron not configured"}` (503), job did NOT run. ⚠️ **DEPLOY NOTE:** prod MUST have `CRON_SECRET` set in Cloud Run + the scheduler must send `Authorization: Bearer <secret>`, else renewals/trial automation stops (503). This is the intended posture — configure the secret before/with deploy.
- [x] ~~**UX-1 / TRUST-1:** fake "sent" toasts + dishonest setup/PDF copy~~ ✅ **FIXED (24 Jul, localhost — awaiting deploy).** Invoices: per-row "Call"/"Remind" fake-success toasts → a real **"Follow up"** button that opens the customer (falls back to honest info if no customer); "Call all overdue" fake queue → "Open customers"; header "New invoice" → /quotes, "Export GSTR-1" → /accounting/gst (real CSV), removed the "Push to Zoho" stub (honest "Not configured" card already exists). Public buy FAQ no longer claims "IRN reference" (e-invoice not built) + fixed a "Haryana" hardcode → "intra-state". Setup wizard: `[Demo] Simulate approval` gated to non-prod; fabricated "Live mode · HDFC ••4521" → honest "finish in Settings → Integrations"; done-checklist no longer claims "GST e-invoice ready"/"Razorpay connected" (→ "GST tax invoice (PDF)" + "Razorpay payments · todo"). PDF IRN lines were already `gst_irn &&`-guarded (never falsely shown) — audit overstated that one. typecheck green, no console errors. ⏳ **Deferred (roadmap):** drive the whole setup wizard off REAL connection state (bigger onboarding rework); full Credit Note flow.
- [ ] **MONEY-5:** add SQL tests for the untested money RPCs (project invoice/payment 0101, salary 0099, bank→expense 0098, invoice-deletes 0109/0110).
- **Next (post-launch):** GST e-Invoice IRP (IRN+QR, ClearTax GSP); own SaaS paywall + tier enforcement (`/pricing` is only a billboard); real renewal-risk model (kill the `sub.id` hash mock in `renewals/page.tsx:56-87`); `refund_payment` RPC; audit log; custom domain + SPF/DKIM/DMARC.
- **Later (moat):** provisioning automation (Google CSP write→MS/Zoho); 3 AI bets (renewal/collections agent, Hindi WhatsApp+voice, quote/margin copilot); Hindi UI (0% done today). **Strategic caution:** freeze new-module breadth (payroll/attendance/loans/projects) until IRP+paywall+real-churn+first-paying-reseller land.

### ✅ DEPLOYED — rev **00137** (24 Jul 2026)
> The whole batch below (6 audit blockers + milestone/logo/toggle work) is LIVE on Cloud Run rev 00137. Migrations 0114–0118 on prod DB. Prod smoke-tested: no-token quote → 404, wrong-token → 404, cron w/o secret → 401. `CRON_SECRET` set on the service.
> ⚠️ **Cloud Scheduler API is NOT enabled on `resellsubsos-prod`** — so renewals/trial-expiry crons are NOT auto-firing on a schedule. The endpoints are secured (401 w/o bearer) but nothing triggers them daily. **Follow-up:** enable Cloud Scheduler API + create 2 jobs (daily) that call `/api/cron/renewals` + `/api/cron/trial-expiry` with `Authorization: Bearer $CRON_SECRET`. Until then, renewal reminder emails won't send automatically.
- [x] ~~**Project quote — edit only FUTURE milestones when invoiced/paid**~~ (24 Jul, migration **0114**, `update_project_future_milestones`) — once a milestone is invoiced/paid, the contract total + invoiced/paid milestones lock; the operator can still re-plan the remaining (un-locked) milestones, which must still add up to (total − locked). Edit dialog shows a "Contract is fixed — re-plan remaining only" banner, disables customer/items/GST, renders locked milestones read-only (🔒 Invoiced/Paid tag), and routes Save to the new RPC. **Money-tested (rolled back):** valid redistribution keeps advance untouched + total intact; wrong total rejected with a clear message. **Browser-verified end-to-end** on Excel (advance ₹5.4L locked, ₹20.56L re-planned, total ₹25.96L preserved, invoice link intact).
- [x] ~~**Clear RPC errors on project quote edit/delete**~~ — `useUpdateProjectQuote`/`useDeleteProjectSale` now `throw new Error(error.message)` so the real Postgres guard message surfaces in the toast (was generic "Could not update"; PostgrestError isn't `instanceof Error`).
- [ ] Rest of this session's localhost work (record-payment on Invoices, milestone impact + raise-invoice-on-paid, delete-invoice explained dialog w/ payment list, Subscription/Project toggles on Quotes/Invoices/Payments, company logo upload) — deploy together on request.

### 🧾 HR + Accounting suite (20 Jul 2026) — shipped live (rev 00050→00056), `session/money-spine-hardening-jun1`
All money movement via atomic SECURITY DEFINER RPCs (§17b) and verified in **rolled-back tenant-scoped txns** (no test data left in prod). Each posts the correct bank/expense/loan legs.
- [x] ~~**Employee Loans**~~ — `/accounting/loans`. Disburse (cash out of a chosen bank/cash account) + repayments (cash/bank/salary-deduction), auto-close at ₹0. Guarded like quotes/customers. Outstanding shows as a Balance-Sheet asset. Migration 0085. Verified: disburse −, repay +, salary-deduction 0-cash.
- [x] ~~**Salary + Expense Advances**~~ — `employee_loans.kind` (loan/salary_advance/expense_advance). Expense-advance **settlement** = spent→a Salaries/expense entry (NO fresh cash, cash left at disburse) + unspent cash returned. Migration 0086. Verified: 500 adv → 350 spent (expense) + 150 return, net cash −350.
- [x] ~~**Payroll & Leave**~~ — `/accounting/payroll` (Employees / Run payroll / Attendance / Leave tabs). `pay_salary`: net = gross − LOP − advance-recovery − TDS/PF/ESI/other; books Salaries expense (earned = gross−LOP) + net-only cash-out + advance salary-deduction; withheld TDS/PF/ESI = "Salary dues payable" liability (Balance Sheet) settled via `pay_statutory_dues`. Leave register; unpaid = LOP. Migration 0087. Verified: 30000 gross, 2000 LOP, 5000 adv recovered (loan closed), 1000 TDS → expense 28000, net 22000 (identity holds).
- [x] ~~**Attendance — office kiosk + PIN**~~ — `/attendance/kiosk` (shared office device, logged in as owner). Name + bcrypt PIN → check-in/out toggle (IST day). Auto-LOP suggestion in payroll from attendance (Sundays off). Migrations 0088. Verified: PIN set → in → out → already-done, wrong PIN rejected.
- [x] ~~**Attendance security**~~ — office-network (IP) allowlist enforced **server-side** in `/api/attendance/mark` (real x-forwarded-for; off-site marking blocked); owner "Lock to this network"; IP logged per mark. Migration 0089.
- [x] ~~**Attendance selfie**~~ — front-camera photo captured on check-in/out (best-effort), private tenant-foldered storage bucket, owner reviews via signed URLs in "Today's check-ins". Deters buddy-punching. Migration 0090.
- [x] ~~**Project Quotations — send → customer accepts → project**~~ ✅ (23 Jul 2026, migration 0104, rev **00103**) — full quote→accept→project flow for one-time sales, mirroring the subscription quote-accept pattern (project id = unguessable link secret). project_sales gained `line_items` + `accepted_at` + 'quoted'/'draft' statuses; RPCs `create_project_quote` (itemised, status 'quoted') + `accept_project_quote` (public-safe, 'quoted'→'active'). **Public page `/project-quote/[id]`** (server component, admin read) shows itemised quote + GST + milestone schedule + Accept button; POST accept API. Owner: `CreateProjectQuoteDialog` (line items from one-time catalog + milestones, live GST/total), /projects "New quotation", detail shows quotation banner (copy customer link + Mark accepted) + quoted-items table + gates milestone billing until accepted. Balance-Sheet project-receivable counts only active/completed (a quoted project isn't owed yet). **Browser-verified END-TO-END** on prod (public page rendered ANUTECH branding + ₹4.72L quote; clicked Accept → "✓ Accepted"; test data deleted). ⏳ Fast-follow: quotation PDF (currently the public link IS the shareable quote), link project to a customer record, WhatsApp/email send button.
- [x] ~~**Catalog split — Subscription vs one-time Items catalog**~~ ✅ (23 Jul 2026, migration 0103, rev **00102**) — Items screen now has a top switcher: **Subscription Catalog** (recurring per-seat/mo, existing) and **Items Catalog** (one-off products/services — custom software, setup, AMC, hardware; flat sale price + cost + HSN/SAC, `item_type='one_time'`). New `OneTimeItemForm` + `OneTimeCatalog` list. Subscription quote pickers (quote-builder, add-line-item) now exclude one-time items (can't be quoted with wrong per-seat pricing). One-time items will feed the Project Quotation flow. ⏳ Next: **Project Quotation** (quote PDF → customer accepts → creates project + milestones) — approved by Pardeep, builds on this.
- [x] ~~**Project / one-time sales (custom software as a product)**~~ ✅ (22 Jul 2026, migration 0101, rev **00100**) — new self-contained path for one-off deals (e.g. ₹22L custom software) billed in **milestones**, separate from the subscription spine (no bogus subscription/PO/renewal). Tables `project_sales`/`project_milestones`/`project_payments` (tenant RLS) + RPCs `create_project_sale`, `raise_project_milestone_invoice` (writes a proper GST Tax Invoice into the existing `invoices` table via central doc-numbering; reverse-derives GST from the inclusive milestone amount; SAC 998314), `record_project_payment` (no subscription; optionally links the real bank credit line → `matched_to_type='project'`, reconciled, no double count). UI: `/projects` list + `/projects/[id]` detail + create dialog (live GST/total + milestone editor) + record-payment dialog (bank-credit picker). Balance Sheet: new **"Project receivables"** asset (total − payments). Revenue flows into P&L on invoice date. **Money-tested (rolled back)** on the real ₹22L Client A deal: taxable 22,00,000 + GST 3,96,000 = 25,96,000; M1 invoice raised+paid; bank ₹5.4L credit matched 'project'; receivable 20,56,000. ⚠️ Not in the automated Vitest suite yet. Fast-follow: milestone edit UI, invoice PDF (CGST/SGST split) for project invoices, link project to a customer record.
- [x] ~~**Salary accrual — unpaid until the bank confirms it**~~ ✅ (22 Jul 2026, migration 0099, rev **00097**) — payroll run now books ONLY the Salaries expense (P&L) + records the salary `paid_status='unpaid'` with **no cash leg**; the net shows as a new **"Salary payable"** liability on the Balance Sheet until the real bank debit is imported and reconciled to it (trigger flips it → `paid`; un-reconcile → back to `unpaid`). Kills the old double-count (payroll used to post a net-pay debit AND the imported statement line was a second debit). Reconcile "Suggested matches" now offers unpaid salaries (by NET) for money-out lines + `salary` match-type badge; Salaries expenses excluded from the expense suggestions. Payroll UI shows Paid/Unpaid badge. **Money-tested (rolled back):** run→unpaid, expense +1, bank_transactions Δ0, reconcile→paid, un-reconcile→unpaid. ⚠️ Not yet in the automated Vitest suite. ⚠️ Existing/already-run salaries were migrated to `paid` (they'd already moved cash).
- **Decision:** face-recognition attendance considered + **declined** (owner chose PIN+selfie) — biometric DPDP consent, accuracy→wrong-pay risk, photo-spoof without liveness, dep/cost. Revisit if office scales.
- ⚠️ **Not yet done:** unit tests (Vitest) for the new RPCs — logic is rolled-back-txn verified but not in the automated suite; add before relying heavily. New employees/loans are hard-delete-only (no undo) — acceptable, non-money.

### ✅ In-app E2E spine verification — PASSED in production (31 May 2026)
- [x] ~~**Full money-spine walked through live app UI**~~ — lead `L-ZZTESTUI1` (buy-workspace, stage New) → quote `Q-ET-2026-27-0016` (draft → sent → accepted) → customer created → payment ₹1,22,342 (ref `ZZTEST-UPI-0001`) → subscription (10 seats, active) → invoice `INV-ET-2026-27-0006` (paid). DB cross-check: **exactly 1 of each — zero duplicates**. Confirms idempotency, no-dup-sub, one-invoice-per-quote, tenant-scoped doc IDs (the `ET` code in `INV-ET-...`) all working in PROD via real UI flow.
- [x] ~~**UI copy nit:** lead drawer heading "QUOTES SENT" → "Quotes"~~ ✅ FIXED (31 May) — `leads/page.tsx`
- [x] ~~**UI copy nit:** draft quote showed "Revise & resend · Sent today"~~ ✅ FIXED (31 May) — draft now shows "Send draft quote" (smart-CTA + footer button + helper text gated on `status === "draft"`). Typecheck green. Committed (not yet deployed).
- [x] ~~**Cleanup:** QA test data removed from prod (31 May 2026)~~ — lead `L-ZZTESTUI1`, quote `Q-ET-2026-27-0016`, payment `ZZTEST-UPI-0001`, invoice `INV-ET-2026-27-0006`, subscription `567d6542…`, customer `f68384a1…` deleted FK-safe (child→parent, single txn). Verified all 6 = 0 rows.

### 🛠 UI/UX fixes (1 Jun 2026)
- [x] ~~**Leads "Quick add" button did nothing on click**~~ ✅ FIXED — the "Quick add · 4 fields" action was a hover-reveal popup (`visibility:hidden` → `group-hover`), so it was undiscoverable, not keyboard-accessible, and impossible on touch (no hover); users moved the mouse to click and it vanished. Replaced with a proper **split-button**: "Add Lead" + caret dropdown ("Full form · all fields" / "Quick add · 4 fields"). Handler (`setQuickOpen`) was always correct — confirmed via programmatic click. `leads/page.tsx`. Typecheck+lint green.
- [x] ~~**"N follow-ups due today" banner now expandable**~~ ✅ FIXED — was a static non-clickable `<div>`. Now a click-to-expand accordion: header toggles a list of the due/overdue leads (most-overdue first), each row tappable → opens that lead's detail drawer (`setSelected`). Keyboard-accessible buttons + aria-expanded. `leads/page.tsx`. Typecheck+lint green. **Verified LIVE** (banner → list of 8 → row click → lead drawer).
- [x] ~~**Listing pages clipped/overflowing at tablet widths (768–1100px)**~~ ✅ FIXED — wide data tables had no horizontal-scroll container, so on narrow-but-tablet widths the `<table className="w-full">` overflowed its `<Card flush>` and pushed the whole page wider → banner + KPI cards + table all appeared "cut off" at the right edge (reproduced at clientWidth 952: page overflowed 40px). **Systemic fix:** `Card` primitive now wraps `flush` bodies (which exist *for* full-bleed tables) in `<div className="overflow-x-auto">` — fixes invoices, contacts, customers, customers/[id], items, payments + any future flush table in ONE place. Radix dialogs/menus are portal-rendered so unaffected. Also changed the invoices + payments "pending" tables from `overflow-hidden` (clipped the Generate button) → `overflow-x-auto`. `card.tsx`, `invoices/page.tsx`, `payments/page.tsx`. Typecheck+lint green.

### 🎨 World-class UI + portal + AI push (3–4 Jun 2026) — committed on `session/money-spine-hardening-jun1`
- [x] ~~**Customer surface rebuilt "answers-first" (beats Zoho's accountant-first layout)**~~ ✅ — new shared `customer-insights.tsx` = single source of truth for Outstanding (Σ subs.outstanding_amount) / MRR (active subs) / Lifetime-paid (paid invoices) / next-renewal + a **deterministic next-best-action** (rules over real rows — no AI, no money-write; reminders are WhatsApp/email deep-links). Both `CustomerPanel` (master-detail) and `/customers/[id]` 360 page compose it → can never show different numbers. **Removed fake data** from the 360 page (stub "Customer added" activity, hardcoded "Account manager: Pardeep Sharma", dead Note/Log-call buttons). Real woven activity timeline (subs/quotes/invoices). TSC:0 + lint green. **Verified LIVE** (rev 00109, Excel tenant, "manoj property": Outstanding ₹1 → NBA "Send WhatsApp reminder"). Commit `58784f5`.
- [x] ~~**Leads: inbound-email→lead + AI follow-up draft + Gmail-style master-detail LeadPanel**~~ ✅ — `/api/webhooks/inbound-email` (secret-guarded, idempotent, Gemini extract + stub fallback, dedup, migration 0069 audit table); `/api/ai/draft-followup` (Gemini Flash, RLS-scoped, stub fallback, zero money-write); LeadPanel (hide-empty fields, thin-lead nudge, AI-draft block). Commit `019593f`.
- [x] ~~**DSP support-platform integration — Phase 1 (read APIs + API-key auth)**~~ ✅ (14 Jul 2026) — public `/api/v1` so the DSP support app reads a customer's billing status (customer/subscriptions/invoices/quotes/payments) to gate support. Migration 0080 (auto customer numbers `C-00001` — every customer now has a stable `billing_customer_id`) + 0081 (`api_keys`, SHA-256-hashed, per-tenant, revocable). Bearer/X-API-Key auth, every endpoint tenant-scoped. Settings→Integrations "Support platform API (DSP)" card to mint/reveal-once/revoke keys (owner-only). Handover doc `docs/dsp-integration-api.md`. **Caught+fixed a caching bug**: `createAdminClient` now forces `cache:no-store` — Next was caching admin GET fetches, which would serve STALE billing status / let revoked keys through. 19 new Vitest (88 total). E2E-verified: 401 no/bad/revoked key, 200 active, cross-tenant isolation (foreign uuid → 404), all 5 shapes, email fallback, UI create/reveal/revoke, last_used_at stamp. Test data cleaned (0 leftover). **Phase 2 (outbound signed webhooks) = planned, not built.** · **Follow-up (15 Jul 2026):** paginated `GET /api/v1/customers?page=&per_page=` list added for DSP "Sync all" (`{customers,page,per_page,total,pages}`, per_page≤200, no N+1) — prod-verified, rev 00153. · **Follow-up (15 Jul):** `pdf_url` for invoices+quotes now real — `GET /api/v1/documents/{invoice|quote}/{id}/pdf?token=` renders server-side (renderToBuffer + existing InvoicePDF/QuotePDF), capability-URL HMAC token (browser-openable, bad/absent→403, unknown→404), pure GST-math prop builders. **Fix:** pdf_url/payment_url now built from request host (x-forwarded), not `NEXT_PUBLIC_APP_URL` (prod env = `resellersos.app` which doesn't resolve → was dead links). 15 new Vitest (115). Prod-verified rev 00155. ⚠️ **Separate open issue:** prod `NEXT_PUBLIC_APP_URL=https://resellersos.app` is a non-resolving domain — still breaks owner-notify + quote-send email links; fix env or set up the domain mapping.
- [x] ~~**Enquiries Inbox — inbound email READABLE in the ERP + convertible**~~ ✅ (14 Jul 2026) — migration 0079 (`inbound_emails.body_text/body_html` + atomic tenant-scoped idempotent `convert_inbound_email_to_lead` RPC, §17b); webhook now stores the body; new `/enquiries` triage screen (list + detail drawer + convert-to-lead, responsive, body shown as text-only = XSS guard); sidebar nav + "new to triage" badge; 5 Vitest (74 total green). E2E-verified locally (3 test emails → drawer → convert → real lead + row stamped → cleaned up). Prod env verified: `BUY_PAGE_TENANT_ID`=Anutech ✅. **Receive side** = Gmail Apps Script forwarder guide in `docs/inbound-email-apps-script.md` (Pardeep sets up — keeps Gmail, no MX change).
- [x] ~~**Branded per-tenant portal + shop cross-sell + pay-online**~~ ✅ — portal chrome (logo/name/GSTIN, account menu, seat-usage), shop via `portal_list_products`/`portal_request_quote` (no margin exposure), pay-online guarded to settle only invoices with a linked subscription (prevents duplicate-sub), OTP 6–10 digit fix, migrations 0067/0068. Commit `c05342d`.
- [x] ~~**Collapsible desktop sidebar**~~ ✅ — icon-only mode (w-16) + tooltips + badge dots + localStorage persist; content auto-reflows. **Verified LIVE.** Commit `d71219e`. Also removed redundant `/preview/leads` throwaway prototype.
- [x] ~~**AI-powered follow-up in customer next-best-action**~~ ✅ — draft-followup route now handles customers (purpose 'reminder' = uses REAL outstanding amount verbatim, or 'followup' = warm check-in), Gemini Flash + stub fallback, zero money-write. NBA "Draft reminder/check-in with AI" → editable inline draft (Redraft/Copy/Send via WhatsApp/email). Human-in-the-loop. **Verified LIVE** (rev 00110, "manoj property" → ₹1 reminder draft). Commit `e659191`. (Real AI output gated on `GEMINI_API_KEY` — currently stub.)
- [x] ~~**Breadcrumb fix + dashboard leaderboard real name**~~ ✅ — `getCrumb` now resolves dynamic detail routes (`/customers/<uuid>`, `/quotes/Q-…`, `/accounting/banking/<id>`) via `[id]` placeholder + parent-prefix fallback (was always "Dashboard"). 5 Vitest green. Leaderboard hardcoded "Pardeep Sharma" → signed-in user. Commit `1542a6a`.
- [x] ~~**Compact list-page headers (Zoho-style) — space reclaimed everywhere**~~ ✅ — big KPI-card grids (~120px) ate space and pushed lists down. **Customers**: 4 cards → metrics in subtitle + saved-**Views dropdown** (All/At-risk/Has outstanding/With subscriptions/No subscription/Healthy, live counts), commit `2cccfc9`. **Quotes + Invoices**: new shared `<StatStrip>` (thin inline row ~32px) + existing tabs, commit `0a4098b` (rev 00113, both verified LIVE). **Subscriptions + Payments + Renewals**: same StatStrip; dropped the **fake hardcoded "Renewal rate 87%"** placeholder (compass: no fabricated numbers). **Leads** already compact (smart-views chips). All headers now tight + consistent.
- [x] ~~**In-app Gemini (AI) key management**~~ ✅ (4 Jun) — owner sets the Gemini key from Settings → Integrations → AI assistant (no Cloud Run). Migration 0070 (gemini cols on `tenant_secrets`, RLS owner-only, masked); resolver `lib/ai/gemini.ts` (tenant key → env → stub) wired into all 3 AI routes; model dropdown + self-diagnosing Test (lists the key's available models on failure); default `gemini-2.5-flash` (2.0-flash alias 404s on some keys). Verified live. Commits `0cfd555` (system), `7d73390` / `83a8765` / `a7503dc` (model + dropdown + reliability fixes).
- [ ] **Fast-follow:** (a) ✅ done — NBA AI draft wired; (b) apply answers-first + NBA to Leads/Dashboard; (c) paused-sub MRR/renewal shows "—" (correct but may confuse — decide if paused should surface differently); (d) ✅ done — breadcrumb fixed; (e) Renewals: compute a REAL renewal-rate metric to replace the dropped placeholder.
- [ ] **🎯 Operator next-actions (Pardeep) — priority order:**
  1. ~~Set Gemini key~~ ✅ **DONE (4 Jun)** — AI is LIVE. Key set **in-app** (Settings → Integrations → AI assistant, no Cloud Run needed), billing on, model `gemini-2.5-flash`. Verified live: real Hinglish drafts on a customer (₹1 reminder, amount correct) + a lead (ACB India follow-up). All 3 AI surfaces now real (customer/lead drafts + inbound-email extraction + campaigns).
  2. **Dogfood with REAL data** — import 5–10 real Excel customers (CSV importer ready) + run one full real money-cycle (lead → quote → pay → invoice). Surfaces hidden bugs + proves value. This is the compass line (Excel = first customer).
  3. **Pick a "first user"** — Client A fully on the app, or one friendly reseller. Polish has diminishing returns without a real user.
  4. **P0 launch-blockers when taking real money:** Razorpay live keys; GST e-invoice if needed (see `LAUNCH_READINESS.md`).
  5. **Inbound email — set up the Gmail forwarder**: follow `docs/inbound-email-apps-script.md` (paste script + `INBOUND_EMAIL_SECRET` into Apps Script Script Properties + 5-min trigger). ERP display side is DONE + deployed (Enquiries Inbox). ⚠️ Also **rotate `INBOUND_EMAIL_SECRET`** — current prod value is the committed dev test value; rotate in Cloud Run + Script Property together.
- [ ] **🎙️ AI voice-calling agent — DESIGN APPROVED, build deferred** (4 Jun) — full design + cost + compliance in `docs/VOICE-AGENT-PLAN.md`. Managed Hindi platform (Sarvam/Bolna), phased: **Phase 0 = WhatsApp voice-note (cheapest, no telephony) ship first** → Phase 1 outbound reminder calls (money-safe script, customers-only) → Phase 2 lead-qual/callback → Phase 3 inbound IVR. Build greenlight pending 4 owner decisions (budget / provider / DLT+KYC / consent source). Money-correctness: agent never speaks an unverified ₹ figure.

### 🚦 Launch blockers — fix order (audit Section 6)
- [x] ~~**1. record_payment idempotency**~~ ✅ DONE (30 May 2026) - bugs #1 & #2 fixed
  - Migration `0051_record_payment_idempotency.sql` applied to DB (project resellersos)
  - Unique index `payments(tenant_id, quote_id, reference) WHERE status='received'` + early RPC guard + race backstop
  - Verified red→green on test DB: same ref 2× → 1 row (was 2); distinct refs 2× → 2 rows (partial payments safe)
  - Regression test committed: `production/supabase/tests/record_payment_idempotency.test.sql`
  - Bug #2 (webhook): covered — webhook already passes Razorpay `payment.id` as reference, so RPC guard dedupes retries
- [x] ~~**1b. Bug #5 — record_payment clobbers sibling subs' outstanding**~~ ✅ FIXED (31 May 2026, migration 0056) - proven red (sibling 3000→2000), then fixed: added `subscriptions.quote_id` (FK), stamped on sub creation, scoped the outstanding UPDATE to `quote_id = p_quote_id`. Red→green + regression test `record_payment_sibling_and_extend.test.sql`. No regression (add-seats/new-sale/idempotency all green).
- [x] ~~**2. Add-seats duplicate-subscription fix**~~ ✅ DONE (30 May 2026) - bugs #3 & #4 (the bug Pardeep found in testing)
  - Migration `0052`: added `quotes.is_add_seats`; record_payment skips ALL sub handling for add-seats quotes
  - `add-seats.ts` now sets `is_add_seats: true`; `database.types.ts` updated; typecheck green
  - Verified red→green on test DB: customer with 1 sub + add-seats pay → 1 sub (was 2); new sale still → 1 sub
  - Regression test committed: `production/supabase/tests/add_seats_no_duplicate_subscription.test.sql`
- [~] **2b. Extend-on-already-renewed (#16) ✅ FIXED + silent-no-sub (#6) deferred** (migration 0056)
  - [x] ✅ **#16 (31 May)** — proven red (extend-on-`renewed` sub → 2 subs), then fixed: dropped the `renewal_state <> 'renewed'` filter from the renewal-sub lookup so a quote that is a sub's `renewal_quote_id` ALWAYS rolls that sub forward (no duplicate). Idempotency unaffected (payment dedup returns first; `renewal_quote_id` nulled after completion). Regression test green; same dup-sub class as the bug Pardeep originally found.
  - [ ] **#6 (deferred, low-risk):** fully-paid + annual + no-customer silently makes no sub. A defensive `raise` could block a legit edge; left as documented fast-follow (rare — quotes always have a customer or lead in practice).
- [x] ~~**🔴 NEW P0 — cross-tenant global doc-id collision**~~ ✅ FIXED (30 May 2026) - `quotes`/`invoices`/`purchase_orders` ids are GLOBAL text PKs but numbered per-tenant → two tenants both made `Q-2026-27-0009` → collision (confirmed live: broke buy-page quote creation). Fix: migration 0054 — `tenants.doc_code` (ET/ANU) embedded in doc numbers → `Q-ET-2026-27-0012` vs `Q-ANU-2026-27-0012` (globally unique, no FK/PK change, existing ids untouched). Applied to prod + regression test committed. Storefront also re-pointed to Client A (fbb976f1).
- [~] **3. Pricing unify** - charged price == shown price (bugs #10,#11,#12) — PARTIAL
  - [x] ✅ Architectural fix (30 May): shared `src/lib/pricing/workspace.ts`; enquiry + checkout both price from the catalog (single source of truth). Removed enquiry's hardcoded ₹270/₹864/₹1080 + first-20 promo. Checkout fallback aligned to catalog. 6 Vitest tests + typecheck green.
  - [x] ✅ VALUE RESOLVED (30 May): Pardeep confirmed via Google's site — real India price is Starter **₹270**, Standard **₹864** (current 20%-off of ₹1080 list). Catalog `items.msrp` updated (was mis-seeded ₹136/₹736 = ~half price → live underpricing fixed). Code fallbacks + Vitest updated to match. (Claude's ₹136/₹736 belief was outdated — Pardeep's Google screenshot was authoritative.)
  - [ ] Polish: model the Standard 20%-off as a proper promo (show ₹1080 strikethrough + badge) via site-promo system, instead of baking ₹864 into msrp — so it auto-reverts when Google's promo ends.
  - [ ] Check COST side: Starter/Standard wholesale (₹110/₹620) give 59%/28% margin vs Plus/Enterprise ~10-15% — wholesale may be mis-seeded too low (affects profit reports, not customer price).
- [x] ~~**4. Invoice atomicity** - ek supply = ek invoice (bugs #7,#8,#9)~~ ✅ DONE (1 Jun 2026)
  - [x] ✅ DONE (30 May): `invoices(quote_id)` UNIQUE index (migration 0053) — duplicate invoice impossible (bug #7). Regression test committed.
  - [x] ✅ **DONE (1 Jun, migration 0058): atomic `generate_invoice(p_quote_id)` SECURITY DEFINER RPC** — `SELECT … FOR UPDATE` on the quote serialises concurrent clicks (#8 race); INSERT invoice + UPDATE quote in ONE txn (#9 orphan). Tenant-guarded via `current_tenant_id()` (SECURITY DEFINER bypasses RLS — authenticated callers locked to own tenant, service/cron trusted). Exact port of old client logic (status rule, 30-day due, razorpay_id map, frozen advance snapshot). Client `useGenerateInvoice` (`lib/queries/invoices.ts`) now calls the RPC. Regression test `generate_invoice_atomic.test.sql` GREEN on live DB (full→paid+idempotent double-call=1 invoice; partial→pending, net 72342). Typecheck+lint green.
  - [ ] Fast-follow (low): freeze GST split snapshot on invoice (#24) — currently re-derived from quote at view time.
- [x] ~~**#17 Public customer "Accept" now converts the lead**~~ ✅ DONE (1 Jun, migration 0059) — `accept_quote` made service-role-safe (derives tenant from the quote when no auth context, like record_payment/generate_invoice); public accept route (`api/public/quote/[id]/accept`) now calls it instead of a bare status update → lead→customer + `won` + `payment_status='awaiting'`, same atomic path as operator "Mark accepted". Regression test `accept_quote_public_conversion.test.sql` GREEN (public conversion + already-has-customer idempotency). Typecheck+lint green.
- [x] ~~**Money-Flow Test Matrix doc re-verified + updated (1 Jun)**~~ ✅ — `docs/MONEY-FLOW-TEST-MATRIX.md` revised against live DB+code: new §2.1 fix-status table (15/16 P0s resolved), spine-health + bottom-line + launch-line updated. Both May root causes (idempotency/atomic RPCs, price-engine divergence) confirmed closed.
- [x] ~~**#26/#27 zero/NULL-amount guards**~~ ✅ DONE (1 Jun, migrations 0060/0061) — `generate_invoice` rejects ₹0 gross (no ₹0 tax invoice / wasted INV serial); `record_payment` rejects payment against a ₹0/NULL-amount quote (was: any payment → "fully paid" + mrr=0 sub). record_payment reproduced verbatim + guard, **full regression suite green** (mrr-ex-gst, idempotent replay, renewal roll-forward, partial, sibling-scoping, + ₹0-reject). DB-only (RPCs) — no client deploy needed. Test `zero_amount_guards.test.sql`. Doc §2.1 updated.
- [x] ~~**5. accept_quote RPC**~~ ❌ FALSE ALARM (verified 30 May) - audit #14 was WRONG: `accept_quote(p_quote_id)` EXISTS in the DB (audit checked migration files, not live DB). "Mark accepted" does NOT crash.
  - Real issue surfaced = **schema drift**: `accept_quote`, `redeem_coupon`, `create_site_promo` + `coupons`/`site_promos` tables exist in prod but NOT in committed migrations. Capture via `supabase db diff` (also unblocks CI). See bug #34.
- [~] **6. GST split + IST expiry fixes** - customer-visible correctness (bugs #18,#19,#20) — GST HEAD DONE, IST expiry pending
  - [x] ✅ **GST head (IGST vs CGST/SGST) derivation unified (31 May)** — new `src/lib/gst/place-of-supply.ts` `isInterStateSupply(customerStateCode, sellerStateCode)` + 5 Vitest (green). Replaced hardcoded GST head in **all** authoritative surfaces: quote-builder (was seller="27"!), quote-send PDF route (was false), quote-detail preview+download, whatsapp-send PDF, cron-renewals PDF, renewals/send-now PDF. Tax-invoice view + receipt-voucher already derived → refactored to the shared helper. Typecheck green.
  - [x] ✅ **Client A GST profile set (31 May)** — `state='Delhi (07)'`, `state_code='07'`, `gstin='07AAAAP0000A1Z5'` (Pardeep-provided). Now seller state is known → head derives correctly.
  - [x] ✅ **Journey 1 (IGST) + Journey 3 (CGST/SGST) verified LIVE (31 May, deploy rev resellersos-00072-ssv)** — same Standard×10 (₹1,03,680) for a Maharashtra (27) vs Delhi (07) customer: MH → **IGST ₹18,662** (single line), Delhi → **CGST ₹9,331 + SGST ₹9,331**; both total ₹1,22,342. Verified across quote-builder, customer-facing quote PDF ("Inter-state (IGST applies)"), AND the legal **Tax Invoice** (IGST @ 18% ₹18,662, ITC note per CGST §31, advance adjusted per Rule 53). Receipt Voucher RV-ET-…-0008 also generated (Journey 1 step 6). Full spine again 1-of-each, zero dups. Test data cleaned.
  - [x] ✅ **FU2: Quotes LIST quick-preview GST head fixed (31 May)** — extracted to `QuotePreviewContainer` which fetches the customer + derives via `isInterStateSupply()`. (commit d4ff0e6)
  - [x] ✅ **FU3: end-of-day IST quote expiry (31 May)** — `endOfDayIST()`+`isQuoteExpired()` in lib/utils (23:59:59.999 IST), used in the public quote-accept route; 7 Vitest. A quote "valid until 30 Jun" no longer lapses at 05:30 IST dawn. (commit d4ff0e6)
  - [x] ✅ **FU1: buy-page captures place-of-supply → inter-state leads bill IGST (31 May)** — migration 0055 adds `leads.state_code`/`state` + makes accept_quote & record_payment copy state_code/state/gstin lead→customer; buy form has a "Your state (GST)" dropdown; enquiry route stores it. SQL regression test green (record_payment: MH lead → customer state_code=27, 1 sub). accept_quote copy verified via in-app E2E. (commit 3b76249) — captures both RPCs into version control too (drift #34, partial).
  - [ ] Vitest: GST split + TZ-expiry (LQ-A5/Q5, RN-18, INV-04)
- [~] **7. Playwright happy-path E2E** - build→send→accept→pay smoke, runs every deploy — SPEC WRITTEN, auth-wiring pending
  - [x] ✅ **`e2e/money-spine.spec.ts` written (1 Jun)** — funnel smoke: every spine page renders in the app shell (no error boundary), invoices money-KPIs, quote builder computes a GST total, quick-add (new split-button) → lead created, + public buy-page price (no-auth). Fixed `lead-flow.spec.ts` stale quick-add selector (hover-popup → caret dropdown). **No-auth tests GREEN against live prod** (smoke ×3 + buy-page); authed tests `skip` cleanly without env. `npx playwright test --list` = 78 tests, 0 parse errors.
  - [ ] **Wiring to light up the authed spine tests (Pardeep decision — touches prod Supabase):** create `.env.test` with `NEXT_PUBLIC_SUPABASE_ANON_KEY`; seed Tenant-A/B fixtures (`supabase/seed/test-users.sql` + `ensureTestAuthUsers()` with the service key). Note: single Supabase project = these synthetic tenants land in prod (RLS-isolated). Consider a Supabase branch / staging DB before seeding prod.
  - [x] ✅ **CI wired (1 Jun)** — `.github/workflows/ci.yml` gained a non-blocking `e2e-smoke` job: installs Playwright chromium, runs `smoke.spec.ts` + `money-spine.spec.ts` (no-auth) against the deployed app (`PLAYWRIGHT_BASE_URL` repo-var, default prod), uploads the report on failure. `continue-on-error: true` (like lint) so a transient prod blip never blocks a merge. The no-auth tests are already proven green vs prod; authed specs self-skip until the anon key + seeded fixtures land. **Takes effect on next push to GitHub (master/v3-dev) or PR.**
  - [ ] Full suite (authed) on a seeded Supabase branch — needs the wiring above (anon key secret + Tenant-A/B fixtures); then drop `continue-on-error` to make the smoke required.
- [ ] **#34 schema-drift: capture the coupon/promo subsystem into a migration** (1 Jun — drift precisely mapped). These exist in PROD but in **zero** committed migrations, so a fresh `supabase db reset`/rebuild silently loses ALL coupon + site-promo functionality:
  - Tables: `coupons`, `coupon_redemptions`, `site_promos` (simple text/int/bool/uuid/timestamptz cols; tenant_id FK→tenants ON DELETE CASCADE; created_by FK→auth.users; CHECKs on discount_type∈{percent,flat}, discount_value>0, banner_style∈{amber,rose,emerald,indigo,ink}; RLS tenant-scoped via `current_tenant_id()` + service_role)
  - Functions: `redeem_coupon`, `create_site_promo`, `get_active_site_promo`, `coupons_touch`, `site_promos_touch_updated_at`
  - Triggers: `trg_coupons_updated`, `trg_site_promos_touch` · + 3 indexes
  - **Fix (proper tool, not hand-assembly — avoids divergent re-capture):** from `production/`, run `npx supabase db diff -f capture_coupons_promos` against the linked prod DB → review → save as `supabase/migrations/0062_*.sql` → commit. NOT launch-critical (coupons/promos unused in the intra-state pilot), but do before any environment rebuild or the seeded E2E branch.
- [x] ~~**CI (GitHub Actions)**~~ ✅ LIVE (30 May) - private GitHub repo `Pardeep-byte1/resellersos`; `.github/workflows/ci.yml` runs typecheck + Vitest + lint on every push/PR. GREEN. Already caught a real bug (vitest was globbing Playwright e2e specs → added vitest.config.ts). Working branch is now **master** (= GitHub).
- [ ] **CI: add SQL money-RPC tests** - still pending: needs a Postgres in CI + full schema (blocked on schema-drift capture via `npx supabase`). Until then the SQL tests in `production/supabase/tests/` run manually.

### 💰 Business-readiness (revenue unlock, parallel)
- [ ] **Razorpay live mode + paywall (tier enforcement)** - pehla ₹1 lene ke liye
- [ ] **Audit logs** - `audit_log` table + wrap mutations
- [ ] **Soft launch with 1-3 design-partner customers** - public launch nahi, friendly cohort first

## Waiting On
- [ ] **🔴 Pardeep: Resend pe `example.test` domain VERIFY karo** - quote/enquiry emails abhi FAIL ho rahe hain (`Resend 403: domain is not verified`, confirmed in `quote_send_log` 30 May). Customer ko quote email + PDF nahi milega jab tak verify nahi hota (resend.com/domains). Journey 1 step 1 + step 4 ka email part isi pe blocked. [Interim: `RESEND_FROM_DEFAULT=onboarding@resend.dev` se bhej sakte ho test ke liye.]
- [ ] **Pardeep: `resellersos.in` domain khareedo** - ~₹1000, 5 min (custom domain + email)
- [ ] **Pardeep: Razorpay live KYC complete karo** - live keys ke liye
- [ ] **Pardeep: decide karo — money unit ₹ ya paise?** - schema vs CLAUDE.md ambiguity (bug #36)
- [ ] **Pardeep: catalog `msrp` ka matlab — retail ya cost?** - pricing fix ke liye zaroori (bug #12)

## Someday
- [ ] Capture `redeem_coupon`/`coupons`/`site_promos` into migration files (schema drift, bug #34)
- [ ] TDS atomic with payment (bug #22) · cadence catch-up (bug #21) · coupon units guard (#31)
- [ ] e-Invoice IRP (ClearTax) · DPA template · data export (DPDP)
- [ ] AI feature #1 (lead scoring / quote suggestion)
- [ ] **Auto-provisioning helper (differentiator, validated by Pardeep)** — Pardeep provisions via Google Partner Sales Console, finds it "confusing." Scope FIRST: (A) guided in-app checklist/wizard (cheap, no API, kills most confusion) vs (B) full Google Workspace Reseller API automation (needs reseller API access). NOT a launch blocker — after money-spine + revenue.
- [ ] All remaining P2 items from MONEY-FLOW-TEST-MATRIX.md Section 4

## Done

## MERGE (DMS → ResellerOS, ek app) — direction confirmed 1 Sep
Pardeep: sab DMS features ResellerOS me; ResellerOS = ek ghar; engine integrate (rewrite nahi). Zoho→ResellerOS billing. CONFIRMED 2 Sep: app.anutech.in = sirf ENGINE (customer sirf ResellerOS dekhega); DMS ke customer-facing pages ResellerOS me port honge (website/ folder seed).
- [x] **Brick #1: Hosting catalogue me** ✅ 1 Sep — DMS `/api/public/hosting-plans` (Anutech-Digital main c4072d5) + `sync_hosting_catalog` RPC (20260901170000, mutation-tested) + `/api/catalog/sync-hosting` + owner-only "Sync hosting" button (/items). Auto-sync (engine price = catalogue price); browser-verified (button + 401/502 graceful). LIVE after DMS deploy.
- [x] **Brick #2: Domains catalogue me** ✅ 2 Sep — sync_domain_catalog RPC (20260902090000, mutation-tested) + /api/catalog/sync-domains + owner-only "Sync domains" button (Items Catalog tab). Har priced TLD = one-time item; ₹0 skip. tld-pricing pehle se DMS main par. Browser-verified (button + 502 graceful). LIVE after DMS deploy.
- [~] **Brick #3: Native quote→pay→invoice** (2 Sep) — Domains: PEHLE SE THEEK (project quote, msrp se priced). Hosting: **10x misprice fix** (flat product qty default 1, catalogDefaultQty helper + unit test 11/11) → ab annual sub ban kar sahi spine me. HSN gap (invoice par hardcoded 998313) alag task task_2538cd75 me (freeze-per-line + CA SAC decision chahiye).
- [~] **Brick #4: Provision-on-sale** (2 Sep) — decision layer DONE, kharcha jaan-boojh kar automatic NAHI. hosting/domain ab valid provisioning vendor (migration 20260902100000); paid order queue me jaata hai blocker `engine_not_connected` ke saath (sahi next step: engine connect karo — "vendor console" nahi), domain+plan saath. Vendor ab CATALOGUE se resolve (items.vendor), plan ke naam se guess nahi — "Starter" me hosting shabd hi nahi hai. Guards: domain bina naam = REFUSE; hosting par seats=0 refuse nahi hota; TEST-mode payment domain kabhi register nahi kar sakta (mutation-verified). 14 naye test (29 total). BAAKI: asli ordering call — engine deploy + server-to-server credential + Pardeep ki explicit haan (irreversible spend).
- [~] **Brick #5: Customer-facing site → ResellerOS** (2 Sep) — Foundation + ALL 14 free pages DONE: website src/site me vendored + scoped design (.anutech-site); (marketing) route group; /hosting /domains /ssl /email /reseller /reselleros /cart /checkout /quote /refund /status /why-us + 3 API routes port; build 181 pages + 6353 test green; browser-verified (blue sales pages + orange reselleros page, app design unaffected). BAAKI sirf: colliding routes (/,/pricing,/about,/login,/privacy,/terms,/support) "kaun jeete" decision; engine ke public pages retire.
- [ ] ⚠️ Pardeep decisions: (a) fractional→whole rupee rounding (₹49.99→₹50) theek hai? (b) hosting HSN 998315 CA se confirm
- [ ] ⚠️ BLOCKER (Pardeep): DMS deploy (app.anutech.in) — tabhi hosting/domain sync + website live jagega
