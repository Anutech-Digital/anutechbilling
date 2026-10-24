# Marketing Budget & Payments — kaise use karein

Jagah: **Marketing Hub → Budget & Payments**

| Kaun | Kya karta hai |
|---|---|
| **Marketing** (naya role) | Budget maangta hai, phir budget ke andar billing se payment maangta hai |
| **Owner** | Budget approve karta hai (kam bhi kar sakta hai) ya reject karta hai |
| **Billing / Accountant** | Payment karke **Paid** dabata hai (date, mode, UTR) — kharcha apne aap Expenses me judta hai |

## Flow
1. Marketing → **Ask for budget**: kis cheez ke liye (Google / Facebook / LinkedIn Ads, Event), product, mahina, amount.
2. Owner ko notification → **Approve** (amount badal sakta hai) ya **Reject** (wajah likhni zaroori).
3. Marketing → budget par **Ask billing to pay**: amount, kisko dena hai, bill link.
   - Budget me paisa bacha hai → seedha billing ke paas, owner se nahi poochna.
   - Bache se zyada → app rok deta hai: "Only ₹X is left — ask the owner for more budget."
4. Billing → **Paid** (ya **Send back** agar bill galat hai). Marketing ko notification.
5. Bacha paisa agle mahino me bhi chalta rehta hai. Khatam ho to naya budget maango.

## Niyam (database khud lagata hai)
- Budget **sirf owner** approve kar sakta hai.
- Payment **bache budget se zyada** nahi ho sakta.
- **Paid** sirf billing / accountant / owner kar sakte hain; paid hone ke baad badal nahi sakta.
- Request sirf maangne wala, owner aur billing dekh sakte hain.

## Local test logins (password: `production/db/local/demo-login.sql` jaisa)
- owner@demo.test (Owner) · marketing@demo.test (Marketing) · billing@demo.test (Billing)
- Teen alag logins ek saath: `localhost:3001`, `127.0.0.1:3001`, `[::1]:3001` — har address ka login alag rehta hai.
