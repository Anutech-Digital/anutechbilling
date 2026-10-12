# QA system — testing, workflows aur errors automatic kaise pakde jaate hain

Pardeep ne 30 Sep 2026 ko tay kiya: testing ka zyadatar kaam machine/AI kare, 4 log sirf wo karein jo insaan hi kar sakta hai — aur **ye system har hafte behtar hota rahe** (neeche "Har hafte sudhaar").

## 1. Kya automatic chalta hai

| Kab | Kya | Kahan | Haalat (30 Sep) |
|---|---|---|---|
| Har push | CI: typecheck, unit tests, lint, build, migration order; SQL tests (RLS, paise) | `.github/workflows/ci.yml` | S44 mein SQL job + teeno dev branches jud rahe hain |
| Har push + raat | E2E (Playwright) — neeche ke 15 workflows, test company par, logged-in | `production/e2e/` | R-053: test company "E2E Test Co" + 4 role users ka seed aur W6–W13 ke logged-in specs ban gaye (local par 11/11 pass). CI mein chalne ke liye GitHub secrets + ci.yml job baaki (Abhishek) — tab tak ye skip hote hain aur suite-health laal rehta hai |
| Roz 10:00 (Mon–Fri) | AI QA routine `reselleros-qa`: test site ke pages + flows, fail → bug card, fix ke baad auto retest | `production/e2e/qa/run.mjs` | Chal raha hai (abhi sirf public + buy pages) |
| Button dabane par (board "🧪 AI se testing karwao") | AI tester `reselleros-qa-now`: insaan ki tarah website kholta, click karta, form bharta, numbers milata hai; bug → page owner ke naam card (source ai-tester) | test site (public) + localhost:3001 (logged-in) | 30 Sep se |
| Roz 09:00 | Error routine `reselleros-errors`: production ke Cloud Run ERROR logs → group karke owner ke naam card | scheduled task | 30 Sep se |
| Har minute | Uptime check "ResellerOS live" + alerts | Cloud Monitoring | S9 |
| Raat 23:30 | Auto-worker: Pardeep ke area ke code cards local branch par | scheduled task | Chal raha hai |
| Somvaar 11:00 | Sudhaar routine `reselleros-qa-improve`: hafte ke bugs dekh kar system mein kya kami rahi | scheduled task | 30 Sep se |

## 2. Kaun kya karta hai

- **Pardeep (manager) + AI** — QA system ka malik (30 Sep se areas badle: Hitesh ab Accounting module): E2E suite, test company + test users, retest AI QA karta hai; hafte mein ek baar phone par haath se ghoomna (docs/MANUAL-TEST-SCRIPT.md).
- **Hitesh (Accounts)** — Accounting/GST/payroll module ka malik; apne workflows (W10–W13) ke tests.
- **Abhishek, Pawan, Hitesh** — **har fix ke saath test** (taaki bug wapas na aaye); Done/Review se pehle push + CI green; apne area ke bug card.
- **Pardeep** — hafte mein 30 min: naye bugs + Team Pulse dekh kar priority; business ke number (accounting, GST, renewal amount) khud check — "sahi number kya hai" ye wahi jaante hain.
- **Claude** — routines chalana, untested critical routes (webhooks, payments) ke tests likhna, errors ko sahi owner tak pahunchana, har hafte sudhaar ka prastav.

## 3. 15 main workflows (E2E aur AI QA inhi par chalte hain)

| # | Workflow | Area | Automatic test |
|---|---|---|---|
| W1 | Signup → /welcome → company bani / join request | Pawan | anutech-*.spec.ts (hissa) |
| W2 | Login, logout, password reset, role wise menu | Pawan | role-permissions.spec.ts |
| W3 | Lead aaya (form / IndiaMART) → assign → follow-up | Pardeep | lead-flow.spec.ts |
| W4 | Lead → quote → customer ko bhejna | Abhishek | money-spine.spec.ts (hissa) |
| W5 | Quote pay (Razorpay test) → invoice → subscription | Abhishek | money-spine.spec.ts |
| W6 | Seats badhana (duplicate nahi) | Abhishek | w06-seats-add.spec.ts |
| W7 | Renewal reminder → renewal quote → pay → nayi date | Abhishek | w07-renewal.spec.ts |
| W8 | Overdue invoice → dunning email/WhatsApp | Abhishek | w08-overdue-dunning.spec.ts (dunning dry-run; asli email nahi) |
| W9 | Credit note / refund | Abhishek | w09-credit-note-refund.spec.ts |
| W10 | Expense / purchase bill → GST input | Hitesh | w10-expense-gst-input.spec.ts |
| W11 | GST reports: GSTR-1, 3B, HSN — invoice se milaan | Hitesh | w11-gst-reports.spec.ts |
| W12 | Trial balance, P&L, Day Book | Hitesh | w12-books-reports.spec.ts |
| W13 | Salary / payroll run | Hitesh | w13-payroll.spec.ts |
| W14 | Customer buy page (public) → checkout | Pawan | e2e/qa/buy-workspace.spec.ts |
| W15 | Ek company doosri ka data na dekh sake; sales role owner ka kaam na kar sake | Sab | cross-tenant.spec.ts, role-permissions.spec.ts |

W6–W13 ke specs R-053 mein bane (`production/e2e/wNN-*.spec.ts`, "E2E Test Co" ke andar owner / manager / sales / accountant ban kar). Kaise chalana hai: `production/e2e/README.md` → "Logged-in E2E". Naya bada feature aaye to yahan row jodo, aur uska spec bhi.

## 3a. Har bug = ek test

Jo bug ek baar pakda gaya, wo dobara chupke se wapas na aaye — isliye:

- **Fix karne wala (owner) usi commit mein regression test likhta hai** jo us bug ko pakadta: pehle fail hota (fix se pehle), fix ke baad pass. Paise/GST/role wale bug → `production/e2e/` (logged-in ho to `fixtures/roles.ts` use karo), pure hisaab → Vitest, DB/RLS → SQL test.
- Test ka naam/`test.describe` mein card number: jaise `R-0xx: credit note ke baad net due galat`. Commit message mein bhi card number.
- Card Review mein tabhi jaata hai jab test commit mein ho. Test likhna sach mein namumkin ho (jaise asli email ka inbox) to card mein ek line: *kyun nahi*, aur haath se check ka tarika.
- **AI tester (`reselleros-qa-now`) aur `reselleros-qa` jo bug card banaate hain, unme spec ka reference hota hai**: jis workflow (W1–W15) ka bug hai uska spec file naam, aur agar us spec ne hi pakda to test ka title. Fix ke baad retest = wahi spec chalana.
- Hafte ka sudhaar (neeche) dekhta hai ki kaunse fixed bugs bina test ke band hue.

## 3b. AI tester — har role mein login (sirf LOCAL, R-878)

Desktop AI tester apna dev server chalata hai (`npm run dev:local -- -p 3006` … `3012`; 3001/3005 nahi)
aur har role ke liye ek one-time link banata hai. Sab `production/` folder se:

```bash
E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs   # ek baar: "E2E Test Co" + 4 role users (.env.test passwords)
node scripts/dev/seed-e2e-catalog.mjs                   # ek baar: 5 products (google/microsoft/zoho) + 2 suppliers
node scripts/dev/local-login-link.mjs e2e-manager@example.test --host tester1.localhost:3008
#   → sirf ek line: http://tester1.localhost:3008/api/dev/login-link?token_hash=…  — browser mein kholo
```

- Roles: `e2e-owner@`, `e2e-manager@`, `e2e-sales@`, `e2e-accountant@example.test`. `--next /leads` = seedha us page par.
- Har tester ka apna host `testerN.localhost:<port>` — cookies port nahi dekhti, alag host = alag login.
- Link ek baar chalta hai, 1 ghante mein khatam. Dobara chahiye to command dobara.
- Mana karta hai: `@example.test` ke bina koi email, localhost / 127.0.0.1 / *.localhost ke bina koi host,
  local Supabase ke bina koi DB. App ka route (`/api/dev/login-link`) `dev:local` ke bina 404 deta hai — staging/live par hai hi nahi.
- Local auth GoTrue hai (default). `AUTH_PROVIDER=authjs` wale server par login page ke "Local test login" buttons use karo.

## 4. Bug ka safar

bug mila (AI QA / error routine / team / customer) → board par owner ke naam card (steps, expected, actual) → owner fix + **test** → push, CI green → Review → AI retest (ya bug batane wala) pass → Done.

## 5. Har hafte sudhaar (system ko behtar karte rehna)

Har Somvaar `reselleros-qa-improve` pichhle hafte ko dekhta hai:
- Kaunse bug **insaan ne pakde jo automatic system se chhoot gaye** → unke liye kaunsa test/check jode.
- Kaunse checks bekaar shor (false alarm) karte hain → hatao ya sudhaaro.
- Kaunse workflows (upar ki table) ka test ab bhi "—" hai.
- CI kitni baar laal hua, aur kyun.

Wo Pardeep ko 1–3 sudhaar suggest karta hai; Pardeep "haan" bole to card banta hai. Jo sudhaar ho gaya, neeche log mein ek line.

### Sudhaar log
- 30 Sep 2026 — system shuru: error routine, weekly sudhaar routine, 15 workflows ki list, R-053 (auth E2E).
- 30 Sep 2026 — R-053: "E2E Test Co" seed (4 roles, passwords sirf env se) + W6–W13 logged-in specs; "Har bug = ek test" niyam.
- 30 Sep 2026 — board par "🧪 AI se testing karwao" button + routine reselleros-qa-now (har 15 min request dekhta hai). Production kabhi nahi; logged-in testing sirf local app (3001) par.
