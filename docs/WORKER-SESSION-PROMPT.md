# Worker session — one card, its own worktree (6 Oct 2026)

Pardeep: "koi badiya tarika batao jisse project jaldi complete kar saku". One **manager**
session (plans, board, 5 PM staging/live) and several **worker** sessions, each building ONE
card in its own folder, so 3–4 cards move at once without touching each other's files.

**Two workers, same files — blocked by a lock, not by memory.** `production/scripts/ops/worker-lock.mjs`
keeps one lock per card in `~/.claude/worker-locks`. A worker claims its folders before writing
code (refused if another live worker holds an overlapping path), checks the files it actually
changed before every commit/push, and releases after. A lock whose worktree folder is gone is
removed automatically. `node scripts/ops/worker-lock.mjs list` shows who holds what.

**Max 2 workers 09:00–21:59 IST, 4 at night; one type-check at a time; no dev server per worker** (6 Oct: 8 workers with 8 dev servers left 2 GB of
24 GB free and hung the machine). `claim` refuses a 5th worker (exit 3). Workers run only their own
tests; the manager does every browser check on ONE server after pulling the pushes.

**AUTO mode + card prep (6 Oct night):** the manager prepares each card first (`worker-lock.mjs prep`:
files exist, re-exports followed, `lockAreas` + `prepared: true` written on the card) and Pardeep approves
the day's order (`todayRank`). A worker started with `CARD = AUTO` takes the next prepared card, and up to
3 in a row, so nobody waits for the manager to hand out the next one.

**How to use:** Claude app → New session → **Local** (not cloud) → paste the block below →
change `R-XXX` on the first line to the card number → Enter. Press Allow when it asks for the folder.

---

```text
CARD = AUTO   ← AUTO = aaj ki list se khud card lo (ya R-XXX likho ek hi card ke liye)

Tum ResellerOS ke WORKER ho: sirf upar wala ek card banao, apne alag folder (worktree) me. Hinglish me jawab, chhota.

0. CLOUD CHECK: agar tum cloud container me ho (path /home/user/…, localhost nahi khulta, browser pane nahi) to kuch mat karo — bolo "Ye cloud session hai — naya session LOCAL chun kar chalaiye" aur ruk jao.
1. FOLDER: session folder me nahi hai to change_directory se C:\Users\mso50\new-reselleros (owner Allow dabayega).
2. NIYAM: asli repo SIRF Anutech-Digital/anutechbilling (remote `anutech`), branch manager-pardeep. Abhicode0to1/new-reselleros PUBLIC purana repo — wahan kabhi push nahi. staging/deploy branch, live/staging database, secrets, gcloud — kabhi mat chhuo (ye manager session ka kaam hai). AGENTS.md aur production/CLAUDE.md padho aur maano.
3. CARD LO: board "Kaam ki list" https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n, collection cards (ArtifactData tool; ToolSearch "select:ArtifactData"). Card padho (why, fix, doneWhen, files). Agar status "doing" hai aur claimedBy kisi aur ka/updatedAt 60 min se kam purana — ruko, owner ko batao. Warna update (if_version se, samay sirf `date -u +%Y-%m-%dT%H:%M:%SZ` se): status "doing", claimedBy "pardeep", claimedAt, nowDoing "Worker session shuru", liveLog line. Har bade kadam par nowDoing + liveLog.
   AUTO ho to: cards me se wo lo jinka `todayRank` hai, status "list" hai aur `prepared: true` hai — sabse chhota todayRank pehle. Claim karte waqt doosra worker usi card ko le chuka ho (if_version fail / status doing) to agla lo. Koi na bache to step 10.
4. WORKTREE (apna alag folder, main folder ko mat chhuo):
   cd C:\Users\mso50\new-reselleros && git fetch -q anutech
   git worktree add C:/Users/mso50/reselleros-w-<card lowercase> -b w-<card lowercase> anutech/manager-pardeep
   cmd //c mklink /J "C:\Users\mso50\reselleros-w-<card>\production\node_modules" "C:\Users\mso50\new-reselleros\production\node_modules"
   production/.env.local main folder se copy karo.
   LOCK (zaroori, code se PEHLE): card par `lockAreas` ho to wahi use karo (manager ne `worker-lock.mjs prep` se pakke kiye hain). Na ho to card ke files/doneWhen se folder ya file chuno ("src" ya "src/app" jaisa bada nahi). Phir worktree ke production/ me:
   node scripts/ops/worker-lock.mjs claim <CARD> C:/Users/mso50/reselleros-w-<card> "<folder1>" "<folder2>"
   Exit 3 (pehle se 4 worker) ya Exit 2 (TAKRAAV) aaye to KUCH mat banao: card par nowDoing "Ruka: <dusra card> same files par", worktree hatao (step 9), owner ko batao, ruk jao. Lock file kabhi delete/edit mat karo. AUTO me: card ko wapas status "list" karo (claim hatao), worktree hatao, aur agla card try karo (step 3).
   DEV SERVER MAT CHALAO (RAM bachao — 6 Oct ko 8 servers se computer hang hua). Browser jaanch manager karega.
5. BANAO (sirf worktree me): pehle bug ho to ek test jo FAIL ho (saboot), phir fix, phir test pass. Feature ho to tests saath. Paise ₹ whole rupees, tenant_id/RLS, koi `any` nahi. Naya DB migration chahiye to production/supabase/migrations me file likho par KAHIN apply mat karo — card par likho "migration: <file> — manager lagayega". Naye migration ki PEHLI line ZAROORI: `-- deploy-peek: <SQL boolean, true jab file lag chuki ho>` (jaise `exists(select 1 from pg_trigger where tgname='trg_x')`; `| " $` mana), chaho to `-- deploy-key: <chhota naam>` bhi — manager `node scripts/ops/gen-deploy-db.mjs --date <YYYY-MM-DD>` se staging+live deploy-db script ka MIGS khud banata hai; header na ho to wo fail karta hai.
6. JAANCH (halki, RAM bachao): apni test files `npx vitest run <files>`, PHIR badli files se jude saare tests `npx vitest related <badli files> --run` (7 Oct: workers ne 2 baar apne area ke bahar ke tests tode — ye unhe pakadta hai; scan/ratchet tests ke liye apne folder ka `npx vitest run <folder>` bhi), commit se pehle ek baar `node scripts/ops/worker-lock.mjs tsc <CARD>` (ek waqt me ek hi worker type-check karta hai — khud `npx tsc` mat chalao), aur sirf badli files par `npx eslint <files>` — sab green. Browser jaanch NAHI — manager push ke baad apne ek server par karega; aiResult me likho "browser jaanch: manager karega".
7. COMMIT + PUSH: pehle `node scripts/ops/worker-lock.mjs check <CARD>` (jo files sach me badli, unka takraav) — exit 2 → commit/push mat karo, owner ko batao. Phir commit message "<CARD>: <kya badla>" + aakhri line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Phir PUSH sirf `node scripts/ops/worker-lock.mjs push <CARD>` se (khud `git push` mat karo) — ye apni baari ka intezaar karta hai (ek waqt me ek hi worker push karta hai), phir fetch + rebase + tsc + guard tests (~40 s, repo-scan/ratchet suites — scripts/ops/push-guard-suites.mjs) + push. Exit 2 = rebase CONFLICT (abort ho chuka) → card par likho, ruko, doosre ka code mat hatao. Exit 5 = guard test fail → jo test naam aaya use `npx vitest run <file>` se chalao, apni badli file theek karo (test dheela mat karo), phir dobara push. Exit 1/4 → card par wajah likho aur ruko.
8. CARD BAND: status "review", nextStep "deploy", nowDoing null, commits [sha], finishedAt, aiResult "✓ kya badla, tests, browser me kya dekha", howToCheck (2–4 kadam), liveLog line.
   Card me feedbackId + feedbackEnv ho to app me report fixed karo (token kabhi print mat karo, note sirf ASCII):
   curl -s -X POST -H "Authorization: Bearer $(cat ~/.claude/secrets/agent-queue-token)" -H "content-type: application/json" -d '{"id":"<feedbackId>","note":"AI ne theek kiya: <CARD> (<sha>) - <ek line>. Staging par shaam 5 baje ke merge ke baad. Tab browser test."}' <staging: https://resellersos-staging-njvk4nxhdq-as.a.run.app | live: https://reselleros.anutech.in>/api/agent/feedback-fixed
9. SAFAI: push ho gaya ho tabhi `node scripts/ops/worker-lock.mjs release <CARD>` (atka ho to lock rehne do — worktree hatate hi wo khud purana maana jaayega). Junction PEHLE hatao aur pakka karo ki hat gaya:
   PowerShell: (Get-Item 'C:\Users\mso50\reselleros-w-<card>\production\node_modules').Delete()
   tabhi `git worktree remove C:/Users/mso50/reselleros-w-<card>` aur `git branch -D w-<card>` (kabhi --force jab junction ho — shared node_modules mit jaata hai).
10. AGLA CARD (sirf AUTO me): step 9 ke baad wapas step 3 — is session me max 3 card (context chhota rahe). 3 ho gaye ya list khaali, tab step 11.
11. ANT: 4 line me batao — card, kya badla, tests, push hua ya nahi. Phir ye session archive karo (mcp__ccd_session_mgmt__archive_session, session_id "self") — SIRF agar ye session isi prompt se shuru hua. Kuch atka ho to archive mat karo, wajah batao.
```
