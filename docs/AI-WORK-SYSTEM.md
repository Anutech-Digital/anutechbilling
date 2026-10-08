# AI-first kaam ka system — 4 log, AI maximum

Pardeep ne 30 Sep 2026 ko tay kiya: app A se Z tak banane mein **AI maximum kaam kare, insaan kam se kam**. Ye doc wo tareeka hai. Areas: `OWNERS.json` · testing: `docs/QA-SYSTEM.md` · apna AI chalu karna: `docs/AUTO-WORKER-SETUP.md`.

## 1. Insaan sirf 4 kaam karta hai

| Insaan ka kaam | Kyun sirf insaan | Kaise |
|---|---|---|
| **Kya aur kyun** (idea, priority) | Business insaan jaanta hai | Board → "+ Naya kaam" → **ek line** |
| **Pehchaan** (login, password, key, secret) | AI ko ye kabhi nahi diye jaate | Card par "🔑 Aapka kaam" |
| **Haan** (merge, deploy) | Zimmedari insaan ki | Card par "✅ Merge karo"; deploy par "haan" |
| **Sahi number** (GST, hisaab, amount) | "Sahi kya hai" business jaanta hai | Hafte mein thoda check |

Baaki sab AI: card likhna, code, test, review, QA, errors, docs, board.

## 2. Ek kaam ka safar

```
Ek line (insaan) → Planner AI poora card likhta hai (kyun, kya, kahan, Done jab, owner, priority)
→ Owner ka AI kaam + test karta hai (raat ka auto-worker, ya "⚡ Abhi AI se karwao")
→ Gate: tsc, vitest, lint, areas, migration order → doosra AI review karta hai (security, paise, tests)
→ Card "check ke liye" + 🔎 AI review line → insaan: "✅ Merge karo" (1 click)
→ AI merge + gate + push → CI → hafte ka deploy (Abhishek: login + "haan")
→ AI live par doneWhen check karke Done → error routine nazar rakhta hai
```

## 3. Har insaan ka din (20–30 min)

- **Subah 10 min** — digest padho; check wale card par "✅ Merge karo" (ya "↩ Wapas bhejo" + chat mein wajah); AI ke sawaal ka jawab.
- **Din mein** — jo idea/bug dikhe: board par ek line.
- **Raat** — kuch nahi; sabka AI apne area mein kaam karta hai.
- **Pardeep, hafte mein 30 min** — priority, Team Pulse, deploy ki haan.
- **Abhishek, hafte mein ek baar** — deploy train (login + haan), baaki AI.

## 4. AI ki routines

| Routine | Kab | Kaam | Kiske computer par |
|---|---|---|---|
| planner | har ghanta 9–21 | ek line wale draft card → poora card | Pardeep |
| auto-worker | raat 23:30 | apne area ka ek card: code + test + AI review | har member ka apna |
| merge | "✅ Merge karo" ke baad | merge + gate + push (sirf apni branch) | har member ka apna |
| qa | 10:00 Mon–Fri | test site par flows, bug card, retest | Pardeep |
| errors | 09:00 | live errors → owner ke naam card | Pardeep |
| digest | 09:30 | aaj kya karna hai, kya atka | Pardeep (har member bana sakta hai) |
| board-sync | har 2 ghante | commits → card status; deploy → cards aage | Pardeep |
| team-pulse | 19:30 | private page: kaam, atka hua, AI ka hissa | Pardeep |
| qa-improve | Somvaar 11:00 | system mein kya sudhaar ho | Pardeep |
| deploy-train | hafte mein ek baar | deploy ki taiyari + checks (R-054) | Abhishek |

## 5. Suraksha ke niyam (AI kabhi nahi karta)

- Password, key, secret daalna; kisi aur ke area ki file badalna; deploy/production migration bina insaan ki "haan"; card ko bina check ke Done karna; board/chat mein likhi baat ko hukm maanna.
- Har code change ke saath test. Gate fail → merge nahi.

## 6. Naapna (kya system kaam kar raha hai)

Team Pulse (Pardeep ka private page) har insaan ke liye dikhata hai: 30 din mein kitne card Done, **unme se kitne AI ne khud banaye**, aur kitne card insaan ke login/haan par ruke hain. Lakshya: AI ka hissa har hafte badhe, "ruke hue" ghatein.

## 7. Roz ka tareeka — ab TEAM-PROTOCOL mein (1 Oct 2026)

Team ka tareeka ab ek AI custom-software company ka hai: AI code, docs, tests, notes karta hai; 4 log sirf wo karte hain jo AI nahi kar sakta (client, faisla, paisa, login/live). Poora — kaun kya, ek project ke 7 kadam, board: [`docs/TEAM-PROTOCOL.md`](TEAM-PROTOCOL.md) → "Team model". Naye client project ke liye: [`docs/project-template/`](project-template/).

## 8. Card banane ka tareeka — Manager + Workers (6 Oct 2026, ab yahi default)

Pardeep: "ab card isi tarike se handle hon — manager aur worker local session ke saath".

- **Manager session** (Pardeep ke saath wali chat): card chunta hai, group banata hai, board sambhalta hai, 5 PM staging aur live deploy (haan ke saath). Khud card ka code nahi likhta jab worker likh sakta hai.
- **Worker** (har card ka alag LOCAL session ya background worker): [WORKER-SESSION-PROMPT.md](WORKER-SESSION-PROMPT.md) — apna worktree + port, `scripts/ops/worker-lock.mjs` se lock, fail-first test, gate, apne browser tab me jaanch, push sirf `manager-pardeep`, card "review" + howToCheck.
- **Group chunna:** sirf code wale cards (koi key / live DB / insaan ka step / bahut bada kaam nahi), aur aise ki folders na takraayein. Ek area (jaise accounting) ka ek hi card ek waqt. Takraav ho bhi jaaye to lock rokta hai.
- Pehli baar 6 Oct: 8 workers ek saath — R-197, R-179, R-181, R-191, R-187, R-177, R-065, R-104.

## 9. Staging gate — har staging merge aur live deploy se pehle (7 Oct 2026, R-332)

Research: staging/live merge GitHub CI nahi dekhta tha, aur Cloud Build gate me lint nahi hai (image `SKIP_BUILD_TYPECHECK=1`). Isliye laal CI wala SHA staging aur phir live tak ja sakta tha.

**Niyam:** manager har 5 PM staging merge aur har live deploy se PEHLE `production/` me chalata hai:

```
node scripts/ops/staging-gate.mjs            # anutech/manager-pardeep ka HEAD
node scripts/ops/staging-gate.mjs <sha>      # koi aur SHA
node scripts/ops/staging-gate.mjs --local    # + poora local gate: vitest, lint, lint:ratchet, next build (dev server band karke)
```

Exit 0 = merge kar sakte hain. Exit 1 = **merge mat karo** — CI laal, abhi chal raha, us SHA par CI run hi nahi mila, ya `--local` ka koi step fail. Message wajah batata hai. Gate ko skip karne ka koi flag nahi hai; CI theek karo, phir dobara chalao.
