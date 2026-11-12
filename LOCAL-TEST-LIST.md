# Raat ke cards — localhost par khud check karo

App: http://localhost:3001 (latest code 44bc94a1, local DB updated). Har card ke kadam neeche. Theek lage to board par card kholo → ✓ Theek hai; galat lage to ✗ Galat + ek line.

Sirf local test data hai — kuch bhi bana/mita sakte ho.

## R-1922 — Self-serve (G-ONBOARD) OB-1: New company: Send works on day 1 (link-first send; Customer messages decision)
1. Localhost par nayi company banao (signup), ek quote banao aur "Save & send" dabao: email chala jaata hai (Automation page par "Customer messages" ON dikhega, baaki scheduled jobs OFF).
2. Automation par Customer messages OFF karo, phir quote ka "Save & send" dabao: message me wajah dikhegi, saath me "Turn on customer messages" (dabane par seedha us switch par le jaata hai) aur "Copy link instead" button.
3. Quote page kholo: "Send on WhatsApp" ke paas "Copy customer link" button bahar dikhta hai (More me nahi). Dabao, naye tab me paste karo: accept page aapki company ke naam ke saath khulta hai.

## R-1923 — Self-serve (G-ONBOARD) OB-2: Pay online never uses the platform's Razorpay for another company
1. Kisi nayi company (jiski apni Razorpay keys nahi hain) ki quote ka customer link kholo: "Pay online" button nahi dikhna chahiye; agar company ka UPI ID hai to UPI QR dikhega.
2. Anutech ki quote ka customer link kholo: "Pay online" button abhi bhi dikhna chahiye.

## R-1924 — Self-serve (G-ONBOARD) OB-3: Remove Anutech's bank and name from the WhatsApp / campaign templates
1. In a new company, open Leads, then a lead, then WhatsApp, then the "Invoice reminder" template: it shows your own bank / UPI, or none, and never Anutech's ICICI.
2. Open the quote template: it says "Greetings from <your company>".

## R-1911 — Bills page par pay kiya bill + bank line = paisa do baar (vendor payment double)
1. 1) Bills → kisi unpaid bill par Pay → ₹5,000 (part) record karo. 2) Banking → us vendor ki ₹5,000 wali bank line → Reconcile: sabse upar "Already paid on <date> from the Bills page — match this bank line to it" pehle se tick dikhe, advance ₹0 → button dabao. 3) Bill par Paid ₹5,000 hi dikhe (₹10,000 nahi), aur bank account mein ₹5,000 hi out ho (do line nahi).

## R-1912 — Bank line undo karne par naya bill delete ho jaata hai — chahe us par aur payment ho (orphan bank line)
1. 1) Banking → Google jaise vendor ki ₹5,000 wali bank line → 'The bill is not in the books yet' se naya COGS bill ₹11,800 banao, ₹5,000 pay karo. 2) Bills → wahi bill → Pay ₹6,800 (bill 'Paid' dikhega). 3) Banking → pehli ₹5,000 line → Undo reconcile: line Unreconciled ho jaaye, aur Bills me wahi bill bacha rahe — 'Partly paid', ₹6,800 paid, ₹5,000 baaki.

## R-1917 — Money-out Reconcile sheet: vendor ke liye ek hi raasta — 'Book as expense' / 'Combine' se double kharcha band
1. 1) Expenses mein Sharma Associates ka ₹11,800 ka unpaid bill PS-2 banao. 2) Banking → Sharma ki ₹11,800 wali line → Reconcile kholo: upar sirf 'Paying a vendor?' khula hai, bill PS-2 pehle se tick hai, aur 'Record payment ₹11,800 to Sharma Associates' hi akela orange button hai. Baaki sab 'Not a payment to Sharma Associates?' ke andar band hai. 3) Use kholo → Book as expense mein category chuno: laal message aata hai 'Sharma Associates has an open bill PS-2 for ₹11,800 — pay it with Record payment above…', aur Book button band rehta hai.

## R-1913 — Vendor advance ko pehle se bane expense bill par adjust karo (part bhi) — duplicate kharcha nahi
1. 1) Banking → kisi vendor (jaise Verma) ki ₹30,000 ki money-out line → vendor chuno, bills tick mat karo → 'Record payment' (poora advance). 2) Expenses → usi vendor ka ₹50,000 ka unpaid bill daalo → us row par 'Apply advance ₹30,000' dabao. 3) Row par 'Advance ₹30,000 applied · ₹20,000 due' dikhe; Vendors → Verma popup mein 'You owe ₹20,000'; Expenses mein bill ek hi baar ₹50,000 (koi nayi row nahi). 'Undo advance' dabao to ₹50,000 due wapas.

## R-1915 — Expense (service) bill ka part payment — rent / CA / contractor ko aadha paisa
1. 1) Expenses → Sharma ka ₹59,000 ka unpaid bill banao (ya kholo). 2) Banking → Sharma ki ₹25,000 wali money-out line → Sharma chuno → bill tick karo, 'Pays ₹25,000' aur 'part payment — ₹34,000 stays due' dikhe → Record. 3) Expenses par bill 'Partly paid' aur '₹25,000 paid · ₹34,000 due' dikhe; Vendors → Sharma popup mein bhi ₹34,000 due.

## R-1952 — Applied vendor advance: bulk mark-paid, payment runs and Balance Sheet as-of date must respect it (R-1913 follow-up)
1. Expenses: ek bill par advance apply karo (₹5,000 me se ₹3,000) → Payment run me us bill ka amount ₹2,000 dikhe, ₹5,000 nahi.
2. Usi bill ko Expenses list me select karke Mark paid dabao → dialog me ₹2,000 hi bharne ko aaye, ₹5,000 nahi.
3. Balance Sheet ki tareekh advance apply hone se pehle ki rakho → payable poora ₹5,000 aur advance prepaid me dikhe.

## R-1918 — Naya vendor bank line se — naam, account no, IFSC, UPI narration se bhare aur save ho
1. 1) Banking → Reconcile mein kisi aise vendor ki money-out UPI ya IMPS line kholo jo abhi vendor list mein nahi hai → 'Add “Naam” as a new vendor' dabao: naam, IFSC, UPI ID / account no pehle se bhare hon, neeche 'Filled from the bank line: …' likha ho. 2) Advance ya bill chuno → 'Record payment … & reconcile' dabao. 3) Usi vendor ki agli line kholo → vendor khud select ho aur likha ho 'Guessed from the bank line has their UPI id …' ya '… their account number'.

## R-1919 — Vendor guess ek hi jagah se — Category Rules + seekha hua alias, app aur auto-reconcile dono mein
1. 1) Banking → koi line jiska vendor guess nahi hua → vendor chuno → Record. 2) Usi vendor ki agli line kholo → vendor khud chuna ho, 'learned from your last payment' likha ho.

## R-1896 — Employee exit (naukri chhodna) ka poora system: exit shuru → notice/last day → Full & Final hisaab → bhugtan → letters → band
1. 1) Payroll → Employees → kisi employee ke ⋯ menu me "Start exit" dabao (sirf owner ko dikhega) → resignation date, notice 30, last working day, reason bharo — last day pehle rakho to "10 days short" jaisa dikhe → Start exit. Status "Leaving <date>" ho jaaye. 2) Payroll tab me us mahine ka period chuno — wo employee dikhe aur Pay par salary "Final month — prorated to N of M days" ho; agle mahine ka period chuno — wo employee list me na ho. 3) Agar us employee ka login linked hai: last day ke agle din wo login khol kar dekho — "account deactivated" aa kar logout ho jaaye (password vault bhi band). ⋯ → "Cancel exit" se sab wapas.

