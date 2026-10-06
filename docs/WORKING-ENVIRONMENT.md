# Working environment — kaam tez karne ke liye

> Likha 18 Aug 2026, ek aise session ke baad jo paanch goals tak chala. Har cheez **naapi
> hui** hai ya usi session me **asli me hui** — andaza nahi. Jahan mera pehla andaza galat
> nikla, wo bhi likha hai, kyoki wahi sabse zyada kaam ka hissa hai.

---

## Pehle: jo maine socha tha aur galat tha

Maine kaha tha "Stop hook har turn par 2926 tests chalata hai, ~40-60 second". **Naapa:**

```
Tests 2926 passed · Duration 7.26s · wall clock 9 sec
```

**9 second.** Ye problem nahi hai — ise chhedna hi nahi chahiye. Wo hook `CLAUDE.md §25.2`
me likhi wajah se hai (4 test mahino tak toote pade the, kyoki koi darwaza nahi tha), aur 9
second us bima ki bahut sasti keemat hai.

Sabak: **"slow lag raha hai" aur "slow hai" alag cheezein hain.** Naapo, phir badlo.

---

## Asli waqt kahan jaata hai — naapa hua, bade se chhota

| # | Kya | Kitna | Kiska kaam |
|---|---|---|---|
| 1 | `npm run build` **10+ minute** | Is session me 2 baar = 20+ min | Aap (§4) |
| 2 | Permission classifier ne **~8 call** rokin | Har rok = poora round trip barbaad | Aap (§1) |
| 3 | `SUPABASE_ACCESS_TOKEN` galat — CLI aur **dono MCP server** todta hai | Har DB read slow raaste se | Aap (§2) |
| 4 | Ek session me **5 goals** → baar-baar compaction | Detail ghisti hai, main apni purani baat galat yaad karta hoon | Aap (§5) |
| 5 | `CLAUDE.md` **827 lines** + `AGENTS.md` **259** = har session 1086 lines | Fixed tax, kabhi kam nahi hota | Main (§6) |

---

## §1 — Permission rules (sabse bada, 2 minute)

### Aaj ka live saboot

Ye migration **teen baar** ruki: `create function` do baar, `-f` ek baar. Aapne ek line
jodi, aur **turant lag gayi**. Wahi ek line ne teen round trip bacha diye.

### Aapne aaj ek galti ki thi — ye samajhna zaroori hai

Aapne line jodi par **comma chhoot gaya**:

```json
"allow": [
"Bash(npx supabase db query:*)"        ← comma nahi
      "Bash(cd /c/dev/...
```

Isse poori file **invalid JSON** ban gayi. Aur Claude Code aisi haalat me us file ki
**saari** permissions chup-chaap band kar deta hai — sirf nayi line nahi, **saari 185**.
Koi error nahi dikhta. Bas sab kuch permission maangne lagta hai aur wajah nahi pata chalti.

**Hamesha check karo** — file badalne ke baad ye chalao:

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8'));console.log('VALID')"
```

`VALID` na dikhe to file tooti hai.

### Aur ek baat: aapki jodi hui line mere commands se match nahi karti

Rule prefix se match hota hai. Aapne jodi:

```
Bash(npx supabase db query:*)
```

Par main token ke chakkar me commands aise chalata hoon:

```
env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked ...
```

Ye `npx` se shuru nahi hota, `env` se hota hai — **to rule match nahi karta.** Isi liye
trigger lag gaya par uske baad ka verification probe phir ruk gaya.

Do me se koi ek karo:

**Behtar** — token theek karo (§2). Phir `env -u` ki zaroorat hi nahi, aur aapki maujooda
line kaam karne lagegi.

**Ya turant** — ye line bhi jod do (comma ke saath!):

```
"Bash(env -u SUPABASE_ACCESS_TOKEN npx supabase db query:*)",
```

### Aur ye teen, jo har session me kaam aati hain

```
"Bash(bash deploy.sh)",
"Bash(git log:*)",
"Bash(npx supabase migration list:*)",
```

> **Tradeoff imaandari se:** har rule ek jaanch hatati hai. `db query:*` ka matlab hai main
> bina poochhe production database me likh sakta hoon. Ye aapne aaj jaan-boojh kar diya.
> `Bash(*)` jaisa kuch **kabhi mat** jodna — wo saari jaanch khatam kar deta hai.

---

## §2 — `SUPABASE_ACCESS_TOKEN` theek karo (ye do jagah tod raha hai)

### Live saboot

Aapke Command Prompt me:

```
Invalid access token format. Must be like `sbp_0102...1920`.
```

Maine yahi mere shell me jaancha (**value nahi chhapi**):

```
len=75   first4=sbp_   charset_ok=0
```

Asli PAT = `sbp_` + **40 hex** = 44 chars. Jo set hai wo **75 chars** ka hai aur hex nahi.
Yaani wo Supabase ka access token hi **nahi** hai — kuch aur hai jo galat naam se rakha gaya.

### Isse do cheezein tooti hain

1. **CLI** — isi liye har command me `env -u SUPABASE_ACCESS_TOKEN` lagana padta hai.
2. **Dono MCP supabase server** — `mcp__supabase__execute_sql` ne is session me
   `Unauthorized. Please provide a valid access token` diya. MCP me `env -u` ka option
   nahi hai. To har DB read slow CLI raaste se gaya, jabki MCP tez hai.

### Kya karna hai

Ye credential ka kaam hai — main na token maangunga na dikhaunga. Aap khud:

1. Windows me **Start → "environment variables" → "Edit the system environment variables"**
2. **Environment Variables…** button
3. User variables me `SUPABASE_ACCESS_TOKEN` dhundo
4. Us par sahi PAT lagao — Supabase dashboard → **Account → Access Tokens** → naya banao
   (`sbp_` + 40 hex). **Ya** agar zaroorat nahi to variable **Delete** kar do — CLI stored
   login se chal jaata hai (aaj `env -u` isi liye kaam kiya).
Sabse saaf raasta — delete kar do, kyoki `supabase login` pehle se hua hua hai. Ek command,
admin ki zaroorat nahi (variable **HKCU** me hai, HKLM me nahi — naapa hua):

```bash
reg delete "HKCU\Environment" /v SUPABASE_ACCESS_TOKEN /f
```

### ⚠️ "Naya window kholo" kaafi NAHI hai — ye aaj kaata

Pehle isme likha tha "Command Prompt band karke naya kholo". **Wo adhoora tha.** Registry se
value hat gayi thi, phir bhi naya Command Prompt wahi purana error de raha tha.

Wajah: Windows me har naya window `explorer.exe` se environment **inherit** karta hai, aur
explorer ne purani copy pakad kar rakhi hoti hai. To "naya window" bhi purana token leke
aata hai.

**Turant test karne ke liye** — usi window me:

```bash
set SUPABASE_ACCESS_TOKEN=
```

(`=` ke baad kuch nahi.) Phir `npx supabase projects list` — list aani chahiye.

**Permanent** — explorer restart karo:

1. **Ctrl + Shift + Esc** (Task Manager)
2. **Processes** me **Windows Explorer** dhundo
3. Right-click → **Restart** (screen ek pal blink karegi, normal hai)

Ya sign out / restart. Uske baad naye windows saaf environment ke saath khulenge.

> Ye Claude ke shell par bhi lagu hota hai: is session ka shell purani copy leke chal raha
> hai (naapa: length 75), isliye usme `env -u` lagana zaroori rahega. **Explorer restart ke
> baad naya Claude session** shuru karo — tab shell saaf hoga aur `Bash(npx supabase db
> query:*)` rule apne aap match karega.

---

## §3 — Duplicate MCP server hatao

**Naapa hua** — asli me sirf ye configured hain:

```
project .mcp.json  → supabase
global ~/.claude.json → gw-pro, supabase-db
```

`supabase` aur `supabase-db` **ek hi kaam** karte hain. Dono ke tools har turn me jagah
khaate hain. Ek hatana hai — par **kaun sa, ye 19 Aug ko ulta nikla:**

> ~~Ek hata do — `supabase-db` (global wala), kyoki project wala `.mcp.json` me hai aur team
> ke saath chalta hai: `claude mcp remove supabase-db`~~
>
> **❌ Ye salah galat thi, aur ulti thi.** 19 Aug 2026 ko dono chala kar dekha:
>
> | server | kahan se | nateeja |
> |---|---|---|
> | `supabase` | project `.mcp.json` | **`Unauthorized`** — har call bekaar |
> | `supabase-db` | user-scoped `~/.claude.json` | **chalta hai** |
>
> Wajah wahi hai jo §2 me likhi hai: `.mcp.json` me `"${SUPABASE_ACCESS_TOKEN}"` likha hai,
> aur is machine par (a) `${VAR}` wahan resolve nahi hota, aur (b) us naam ka env var ek
> galat value par set hai. To jo "team ke saath chalta hai" wala tha, wahi is machine par
> **kabhi nahi chalta**. Us salah par amal karne se ek chalta hua server hatt jaata aur ek
> tootta hua bach jaata.

**Sahi kaam:** `.mcp.json` se `supabase` hatao (working `supabase-db` rehne do). Ek naye
teammate ko Supabase MCP chahiye to wo apne user-scope me asli PAT ke saath jode — repo me
token nahi jaana chahiye, aur `${VAR}` yahan chalta nahi.

> **Ye toota hua server sirf jagah nahi khaata, wo jhoot bolta hai.** `Unauthorized` padh kar
> ek session ye maan sakta hai ki "DB access hai hi nahi" aur schema ka andaza lagane lag
> jaye — 14 Aug wali poori galti isi se shuru hui thi.

> Maine pehle kaha tha "3 supabase server aur ~12 marketing/finance server configured hain".
> **Wo galat tha.** Config me sirf 2 supabase hain. Marketing/finance/figma/canva wale
> **plugins** se aate hain, aur `enabledPlugins` teeno settings files me khaali hai — to main
> aapko koi line nahi bata sakta jo delete karni hai. Wo plugin UI se band hote hain.

---

## §4 — Build 10+ minute se kam karo (sabse bada waqt)

Is size ke Next.js app ke liye 10+ minute **abnormal** hai. Windows par sabse aam wajah:
**Defender har `node_modules` file scan karta hai.**

### ⚠️ Command se ye NAHI hoga — Tamper Protection rokta hai

Pehle isme likha tha "admin PowerShell me `Add-MpPreference` chalao". **Wo galat tha.**
Chala kar dekha:

```
Add-MpPreference : You don't have enough permissions to perform the requested operation.
FullyQualifiedErrorId : HRESULT 0xc0000142
```

Wajah naapi:

```
IsTamperProtected : True
```

Tamper Protection Windows ka security feature hai jo Defender settings ko **command se
badalne se rokta hai — admin ko bhi**. To ye command kabhi nahi chalegi.

**Tamper Protection band karne ki salah nahi hai** — GUI se wahi kaam ho jaata hai, bina
security kamzor kiye.

### GUI se karo — Windows Security app

1. **Windows key** → type `Windows Security` → kholo
2. Baayin taraf **Virus & threat protection**
3. "Virus & threat protection settings" ke neeche → **Manage settings**
4. Neeche scroll → **Exclusions** → **Add or remove exclusions**
5. UAC popup → **Yes**
6. **+ Add an exclusion** → **Folder**
7. Chuno: `C:\dev\ResellerOSv3 - Copy` → **Select Folder**

List me folder dikhne lagega. Bas.

> Sabak (`CLAUDE.md §25.1`): wo command likhte waqt maine Tamper Protection check nahi kiya
> tha. Ek `Get-MpComputerStatus` pehle chala leta to aap do galat command na chalate.

Phir build ka time naapo:

```bash
cd /d "C:\dev\ResellerOSv3 - Copy\production" && powershell -Command "Measure-Command { npm run build }"
```

### Aur build ke do niyam jo aaj bhi kaate

1. **Dev server chalte waqt build kabhi mat chalao.** `.next` ud jaata hai aur chalta hua
   page apne hi chunks par 404 deta hai — bilkul "deploy toot gaya" jaisa dikhta hai. (Ye
   memory me hai: `build-dev-server-clash`.)
2. **Build tabhi chalao jab deploy karna ho** ya branch khatam ho. Har turn par nahi.
   `typecheck + test + lint` 1 minute me ho jaate hain; build unse alag cheezein pakadta hai
   (typedRoutes, prerender) — `CLAUDE.md §25.2`.

---

## §5 — Ek goal, ek session (context ke liye sabse bada)

Ye session **paanch** goals chala: Enquiries Hub → Poka-Yoke → Billing → Keyboard →
Hierarchy. Beech me kai baar compaction hua.

**Asli nuksaan, aaj ka:** compaction ke baad maine **do baar** apni hi purani baat galat yaad
ki — kaha "main DDL apply nahi kar sakta" jabki maine wo test hi nahi kiya tha. Jab test
kiya, chal gaya. Do round trip us ek galat yaad par gaye.

**Kya karna hai:** naya goal = **naya session**. Purana kaam nahi khota — commits aur memory
files me hai. Ek session me 2 se zyada goal na le jaao.

---

## §6 — Har session ka fixed tax kam karo

```
production/CLAUDE.md   827 lines
AGENTS.md              259 lines
```

Ye **har session me poora padha jaata hai**. 1086 lines ka tax jo kabhi kam nahi hota.

Isme se ye hisse ab kaam ke nahi lagte:
- §18 Roadmap (Phase 1-5 with weeks) — timeline kabhi follow nahi hui
- §19 Contacts (P1/P3/P4) — ye log naam se maujood nahi hain
- §17b ke "TBD" RPC — teeno ab ban chuke hain
- §12 Performance budgets — kabhi naape nahi gaye

Ye mera kaam hai. Bolo to main chhaant dunga — jo sach me niyam hain wo rahenge, jo
aakanksha thi wo hategi.

---

## Kaam dene ka sahi tareeka — jo aaj tez chala aur jo slow

### Tez chala

| Aapne kaha | Kyo tez chala |
|---|---|
| "ye annual 2004 support project me kyo dikha raha jabki quote 2000 ka tha" | Ek screen, ek galat number, ek expectation. Main seedha reproduce karke fix kar saka. |
| "chalu kar do, jo tumhe sahi lage wo karo" | Faisla mera, par daayra saaf. Maine naapa, behtar design chuna, laga diya. |
| "1" | Ek shabd, poora saaf — kyoki options pehle likhe the. |

### Slow chala

| Aapne kaha | Kya hua |
|---|---|
| "ab kya karna hai" (3 baar) | Har baar wahi list dohrai gayi. Ek option chun lena 3 turn bacha deta. |
| `/goal` ke 5-step block | Bade hain. Har step ke beech gate chalta hai. Theek hain, par ek session me ek hi. |
| kuch nahi (chup rehna) | Stop hook mujhe wapas chalu karta rehta hai; main "intezaar" likhta hoon aur turn barbaad hote hain. **Bas ek shabd likh do** — "ruko" ya "chhod do". |

### Teen aadatein jo sabse zyada bachaayengi

1. **Screenshot ke saath wo likho jo aapko dikhna chahiye tha.** "Q-2026-9776 accepted hai
   par Record payment ka option nahi" — isme screen, record, aur ummeed teeno thi. Us bug par
   ek hi round laga.
2. **"Ho gaya" ya "ye error aaya + poora output"** — aadha output slow karta hai. Aaj
   `Invalid access token format` ka poora line dekh kar hi asli wajah mili (version nahi,
   env var).
3. **Jab kuch do baar kaate, bolo "isko yaad rakho".** Main memory file bana dunga jo agle
   session me apne aap aa jayegi. Aaj do bani: `do-supabase-project-hain`,
   `supabase-token-env-var-toota-hai`.

---

## Local test setup — hosting aur trial asli server par (3 Oct 2026)

Pawan ki machine par, Pawan ke kehne par, local DMS **asli** cheezon se juda hai — taaki trial aur
paid hosting poore test ho sakein. Live site par inme se kuch nahi chalta.

| Kahan | Setting | Matlab |
|---|---|---|
| ResellerOS `.env.local` | `HOSTING_TRIAL_LIVE=1`, `HOSTING_PROVISIONING_LIVE=1` | confirm/paid hosting DMS se account banwata hai |
| ResellerOS `.env.local` | `ALLOW_TEST_PAYMENT_PROVISIONING=1` | Razorpay TEST payment par bhi hosting (domain kabhi nahi); production build me band |
| ResellerOS `.env.local` | `ALLOW_REPEAT_TRIALS_LOCAL=1` | ek-trial-per-customer check band; production build me band |
| ResellerOS `.env.local` | `RESELLERCLUB_API_URL`, `RESELLERCLUB_RESELLER_ID`, `RESELLERCLUB_API_KEY` = DMS wala asli account 1299294 (DMS ka `RESELLERCLUB_SECRET` hi API key hai) | domain search aur checkout ka daam seedha ResellerClub se. Iske bina laptop par koi domain price nahi milta: purana engine `app.anutech.in/api/public/*` 404 deta hai aur redeploy nahi ho sakta. Yahan sirf daam/availability padhe jaate hain; register DMS hi karta hai |
| ResellerOS `.env.local` | `HOSTING_RENEWAL_LIVE=1` | paid hosting renewal DMS se account ki expiry aage badhata hai (`/api/cron/renew-hosting`) |
| DMS `.env.docker` | `ENGINE_HOSTING_RENEW_LIVE=1` | DMS ka renewal switch; test renewal sirf tab jab `ENGINE_ALLOW_TEST_PAYMENT_PROVISION=1` aur ResellerOS isi machine par ho |
| ResellerOS `.env.local` | `NO_OWNER_PAYMENT_ALERT_LOCAL=1` | test payment par owner ko "payment received" email nahi; live server par hamesha jaata hai |
| DMS `.env.docker` | `DIRECTADMIN_*` = server1.anutech.in, `ENGINE_HOSTING_PROVISION_LIVE=1` | har test account **asli** server1 par banta hai |
| DMS `.env.docker` | `ENGINE_ALLOW_TEST_PAYMENT_PROVISION=1` | test payment par DMS bhi account banata hai (sirf jab ResellerOS isi machine par ho) |
| DMS `.env.docker` | `RESELLERCLUB_*` = asli account 1299294 | domain search/price asli; admin se register/renew = asli domain |
| DMS `.env.docker` | `RAZORPAY_KEY_*` = test keys | koi asli paisa nahi |
| Supabase (local) | `ai_autonomy`: test workspace `22222222…` me `provisioning.activate = auto` | paid hosting bina insaan ke |

- **Hosting job:** `cd production && node scripts/local-cron.mjs` — har minute (live par Cloud Scheduler).
- **Test account hatana:** DMS admin → Hosting → ⋮ → Terminate Account → Yes, Delete. Server1 se bhi
  hatata hai aur customer ko "hosting removed" email jaata hai. Warning "DA deletion …" aaye to
  server1 par haath se hatao.
- **Test domain:** koi bhi random naam chalega (Pawan, 3 Oct 2026).
- **Band karna:** DMS `.env.docker` se `ENGINE_HOSTING_PROVISION_LIVE` / `ENGINE_ALLOW_TEST_PAYMENT_PROVISION`
  hatao aur `docker compose up -d dms`. Purane placeholder values ki backup Claude ke scratchpad me thi.
- **Restart ke baad:** Docker Desktop "start at sign-in" on kiya gaya hai; ResellerOS
  (`npm run dev -- -p 4320`) aur local-cron khud nahi chalte.

## Karne ka order

1. **§2 token** — do jagah theek karta hai (CLI + MCP), aur §1 ki aapki line kaam karne
   lagti hai
2. **§4 Defender exclusion** — sabse bada single time saving
3. **§1** me `bash deploy.sh` aur `git log:*` jod do, aur JSON check karna seekh lo
4. **§3** `claude mcp remove supabase-db`
5. **§6** mujhe bolo, main docs chhaant dunga
6. **Agla goal naye session me**
