# Sales → Billing: 20 mushkil test sawaal (7 Oct 2026)

AI tester inhe ek-ek karke **browser mein** chalata hai (localhost pehle, phir staging). Har sawaal ek poori
kahaani hai: lead se paisa aur books tak. Har kahaani ke ant mein "sahi tab hai jab" wali saari baatein
sach honi chahiye. Jo galat nikle → bug card (kind: "bug") → worker → dobara isi sawaal se jaanch.

**Niyam:** price hamesha catalog se uthao (khud number mat gadho). Har jaanch me 3 jagah ka number ek
hona chahiye: **screen = PDF = books/report**. Paise ki har rakam paise (2 decimal) tak milao.
Test data ke naam `T-<sawaal>-<date>` se shuru karo taaki asli data se na mile.

---

## A. Lead se pehla paisa

**1. Same-state customer, poora seedha raasta**
Lead (website se) → contact → quote: Google Workspace Business Standard × 10, saal bhar → customer accept →
pura NEFT payment → invoice.
Sahi tab hai jab: CGST + SGST aadha-aadha (IGST nahi); invoice apne aap bane; subscription bane jiska MRR =
mahine ka hissa; lead "won" ho; dashboard ki aamdani utni hi badhe.

**2. Doosre state ka customer + TDS kaata**
Wahi quote, customer Maharashtra ka (aap doosre state mein). Customer 2% TDS kaat kar baaki bhejta hai.
Sahi tab hai jab: sirf IGST; invoice "paid" ho, "partly paid" nahi; TDS ki rakam "TDS receivable" mein dikhe;
customer ka balance 0. (194C vs 194J ka default: R-390, CA ka jawab baaki.)

**3. Ek quote mein 5 tarah ki cheez**
Workspace × 25 (saal), M365 Business Basic × 5 (mahina), domain registration, support plan, migration (ek baar ka).
Sahi tab hai jab: ek quote mein ek hi billing term ka niyam lage (R-381: mix ho to saaf chetavni); migration
ka subscription NA bane; support ka MRR alag dikhe; PDF ki har line screen se mile; total paise tak sahi.

**4. Discount maanga, approval chahiye**
Sales wala 18% discount daale (seema se upar) → bheje.
Sahi tab hai jab: approval ke bina quote customer ko na jaa sake; manager approve kare tab jaaye; discount
ke baad bhi rate cost se neeche ho to laal chetavni; approval kisne diya, ye record mein ho.

**5. Quote ka naya version**
Customer bole "seats 25 se 30 karo". Quote revise karo, purana bhi customer ke paas tha.
Sahi tab hai jab: purana version accept na ho sake (ya saaf "badal gaya" dikhe); naya number/version alag;
sirf naye version par invoice bane.

**6. Quote ki muddat khatam**
Validity 7 din, 8ve din customer accept karne aaye.
Sahi tab hai jab: accept band ho aur wajah + agla kadam ("naya quote maangiye") dikhe; sales ko suchna jaaye.

## B. Paisa aane ke tarike

**7. Do kisht mein paisa**
Invoice ₹X, customer pehle 40% UPI se, 10 din baad 60% NEFT se.
Sahi tab hai jab: pehle ke baad "partly paid" + baaki rakam sahi; doosre ke baad "paid"; dono receipt alag;
seats/provisioning tab tak na ruke agar aapki policy partial par chalu karna hai (jo bhi niyam hai, saaf dikhe).

**8. Razorpay "Pay now" link se payment**
Invoice ka pay link → test mode card se payment.
Sahi tab hai jab: webhook se invoice apne aap "paid"; Razorpay fee + uska GST kharche mein alag dikhe (R-rzpfee);
paisa pehle "undeposited funds" mein, settlement ke baad bank mein (R-179).

**9. Ek hi payment do baar aaya**
Webhook dobara aaye ya cashier galti se same UTR do baar daale.
Sahi tab hai jab: doosri baar refuse ho ("ye UTR pehle se hai"); balance mein do baar na jude.

**10. Zyada paisa aa gaya**
Customer ne invoice se ₹5,000 zyada bhej diye.
Sahi tab hai jab: zyada rakam "advance / credit" ban kar customer ke khaate mein rahe; agle invoice mein
apne aap kaam aaye ya refund ka raasta ho; books mein "advance from customer" dikhe.

**11. Dollar wala customer**
Videshi customer, USD mein invoice (export, LUT ke saath).
Sahi tab hai jab: GST 0% (zero-rated) aur LUT number PDF par; rupaye mein rate us din ka; payment aane
par exchange gain/loss alag dikhe (R-invfx).

## C. Subscription chalne ke baad

**12. Beech saal seats badhana**
Saal ke 4 mahine baad 5 seats aur.
Sahi tab hai jab: sirf bache 8 mahine ka paisa (pro-rata) lage; naya invoice sirf badhi seats ka; MRR sahi
badhe; renewal date wahi rahe.

**13. Seats ghatana / downgrade**
Standard se Starter par, ya 30 se 20 seats.
Sahi tab hai jab: Workspace ke commitment niyam ke hisaab se (annual plan mein beech mein ghata nahi
sakte) app saaf mana kare ya agle renewal par lagaye; galti se credit note na bane.

**14. Trial se paid**
14 din ka trial → customer pay kare.
Sahi tab hai jab: payment aate hi trial subscription "active" bane (R-trialconv), naya alag subscription nahi;
renewal date payment ke din se gine.

**15. Renewal par naya rate**
Google ne price badhaya; renewal aaya.
Sahi tab hai jab: renewal invoice naye catalog rate par bane (R-renewrate), customer ko pehle suchna; purane
invoice na badlein.

**16. Mahine ka billing, 3 mahine lagaatar**
M365 monthly. Billing cron 3 baar chalao (ya dates aage karke).
Sahi tab hai jab: 3 invoice, har ek ek mahine ka (12 guna nahi — R-369); number series mein koi chhed nahi;
ek bhi mahina dobara na bane (R-375).

## D. Jab kuch galat ho

**17. Paisa nahi aaya (overdue)**
Invoice 30 din purana, payment nahi.
Sahi tab hai jab: yaad-dahani apne aap jaaye (sahi din); credit niyam ke hisaab se 18% saalana byaaj sirf
registered customer par, aur din ke hisaab se (decisions 7 Oct); dashboard "overdue" mein dikhe.

**18. Service band karna aur waapas chalu**
Overdue ke baad suspend → customer pay kare.
Sahi tab hai jab: suspend ka record + wajah; payment aate hi waapas active; beech ke din ka paisa niyam
ke hisaab se.

**19. Customer ne cancel kiya, refund**
Annual plan, 2 mahine baad cancel; aapki policy ke hisaab se kuch refund.
Sahi tab hai jab: credit note bane (GST ulta), invoice cancel NA ho (GST niyam); refund ki payment entry;
subscription "cancelled", MRR ghate; books mein sab tally.

## E. Mahine ka ant

**20. Sab milao**
Upar ke 19 ke baad: GST report (GSTR-1 jaisa), balance sheet, trial balance, customer statement.
Sahi tab hai jab: output GST = sabhi invoices ka GST − credit notes; trial balance bina "Difference" ke barabar;
har customer ka statement uske invoice − payment − credit se mile; dashboard ki aamdani report se mile.

---

**Chalane ka tarika:** manager AI ek sawaal browser mein chalata hai, screen + PDF + report ka number likhta hai,
farak mile to card banata hai. Pehle localhost, sab hare hone par staging par dobara.
