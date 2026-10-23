# Bolna AI call — setup (R-1437)

Lead par **AI call** button → Bolna ka voice agent customer ko call karta hai → call ke baad
baat-cheet aur **sujhaav** lead ki Activity me aata hai. Lead me kuch apne aap nahi badalta,
aur koi quote apne aap nahi banta — salesperson dekh ke khud karta hai.

## 1. Bolna par (ek baar, owner)

1. https://platform.bolna.ai par account banao (ek hi account — awaaz, number, AI sab isme).
2. **Phone number** kharido (Indian, +91). KYC/DLT ke kaagaz Bolna maangega.
3. **Agent** banao:
   - Language: Hindi / Hinglish. Voice: **Sarvam** ki Indian awaaz (sasti) ya ElevenLabs.
   - **Prompt me sirf ye likho:** `{{system_prompt}}`
     (poori script — kaun ho, kya poochna hai, daam — app har call ke saath bhejta hai, catalogue se.)
   - **Extraction** (call ke baad nikaalne wali cheezein), ye 5 naam bilkul isi spelling me:
     - `customer_asked_for_quote` — true/false
     - `customer_asked_for_callback` — true/false
     - `customer_confirmed_renewal` — true/false
     - `customer_not_interested` — true/false
     - `seats_discussed` — number
     (optional: `sentiment`)
   - **Call summary** on karo.
   - **Webhook URL:** `https://<app ka domain>/api/v1/telecalling/webhook?bolna_secret=<BOLNA_WEBHOOK_SECRET>`
4. Developers → **API Keys** → nayi key banao (sirf ek baar dikhti hai).

## 2. App ke server par (env)

```
TELECALL_PROVIDER=bolna
BOLNA_API_KEY=...        # chat me kabhi mat chipkao
BOLNA_AGENT_ID=...
BOLNA_FROM_NUMBER=+91...
BOLNA_WEBHOOK_SECRET=... # koi lambi random string, upar webhook URL me bhi wahi
```

## 3. Kaise kaam karta hai

| Kadam | Kya hota hai |
|---|---|
| Button | Salesperson lead me **AI call** dabata hai (Won/Lost lead par nahi dikhta). |
| Rok-tok | Wahi purane niyam: calling hours, 24 ghante me ek baar, max attempts, apna number nahi, band lead nahi. Workspace ka "automation off" switch sabse upar. |
| Call | `POST https://api.bolna.ai/call` — agent, customer ka number, apna number, `user_data` (script + naam). |
| Webhook | Bolna call khatam hone par bataata hai. App body par bharosa **nahi** karta — sirf execution id leta hai aur `GET /executions/{id}` se khud Bolna se padhta hai. |
| Nateeja | Transcript, summary, status `ai_telecall_logs` me; lead ki Activity me line + **"Sujhaav: AI ne suna N seats"**. |
| Quote maanga | Quote apne aap **nahi** banta. Lead "human attention" me flag hota hai: "customer ne quotation maanga — AI ne suna N seats, check karke quote bhejo". |

## 4. Bolna account aane par test

1. Apne hi mobile number ki ek test lead banao.
2. **AI call** dabao → phone uthao → Hinglish me "10 users chahiye Google Workspace ke, Delhi se hoon, quote bhej do".
3. 1–2 minute baad lead ki Activity me: AI call line, "Sujhaav: AI ne suna 10 seats", aur lead flagged.
