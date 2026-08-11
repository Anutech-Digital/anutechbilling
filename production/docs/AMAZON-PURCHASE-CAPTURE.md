# Amazon purchases → Purchase Inbox (auto-capture by email)

Goal: every Amazon (or other online) **order/invoice email** that lands in your
Gmail is auto-captured into **Purchases → Purchase Inbox**, where you review it
and one-tap **Add to expenses** (Amazon vendor + GST). Nothing hits your books
until you approve — money stays correct.

```
Amazon emails you  →  Gmail  →  Apps Script (every 15 min)
   →  POST JSON to  https://<APP-URL>/api/webhooks/inbound-purchase?key=<SECRET>
   →  app parses (Gemini) + stages it  →  Purchase Inbox  →  you Add to expenses
```

The app side is **already built** (webhook + Gemini parse + inbox + import). All
you set up once is the Gmail → webhook forwarder — same idea as the enquiry
forwarder, just pointed at Amazon mail.

---

## One-time setup

1. Go to **https://script.google.com** (signed in as the mailbox that receives
   your Amazon order emails).
2. **New project** → delete the sample → paste the code below.
3. Edit the two constants (`WEBHOOK_URL`, `SECRET`). `SECRET` must equal the
   Cloud Run env var **`INBOUND_EMAIL_SECRET`** (same secret the enquiry
   forwarder uses — reused on purpose).
4. Run `forwardAmazon` once → approve the Gmail permission prompt (your own
   script reading your own Gmail; no external verification).
5. **Triggers** (clock icon) → **Add Trigger** → `forwardAmazon`, *Time-driven*,
   *Minutes*, *Every 15 minutes*. Save.

```javascript
// ── ResellerOS — Amazon purchase forwarder ────────────────────────────────
const WEBHOOK_URL = 'https://<APP-URL>/api/webhooks/inbound-purchase';
const SECRET      = '<INBOUND_EMAIL_SECRET>';   // must match Cloud Run env

// Only real order/invoice mails. Tune the sender/subject to your Amazon locale.
// (Shipping/promo mails that slip through are auto-marked "ignored" by the app.)
const SEARCH =
  '(from:amazon.in OR from:amazon.com) ' +
  // Amazon India's order mail subject is literally `Ordered: "..."` — match that
  // exact token plus invoice / shipping words. (Gmail treats "Ordered" and
  // "order" as different tokens, so both are listed.)
  '(subject:Ordered OR subject:order OR subject:invoice OR subject:"tax invoice" OR subject:shipped OR subject:dispatched OR subject:delivered) ' +
  'newer_than:3d';

function forwardAmazon() {
  const done = GmailApp.getUserLabelByName('erp-purchase') || GmailApp.createLabel('erp-purchase');
  const threads = GmailApp.search(SEARCH + ' -label:erp-purchase', 0, 25);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      const payload = {
        from:      m.getFrom(),
        subject:   m.getSubject(),
        text:      m.getPlainBody().slice(0, 10000),
        messageId: m.getId(),
      };
      const res = UrlFetchApp.fetch(
        WEBHOOK_URL + '?key=' + encodeURIComponent(SECRET),
        { method: 'post', contentType: 'application/json',
          payload: JSON.stringify(payload), muteHttpExceptions: true });
      Logger.log(m.getSubject() + ' → ' + res.getResponseCode());
    });
    thread.addLabel(done);   // don't re-process
  });
}
```

---

## How it behaves

- **Idempotent twice over:** the script labels processed threads `erp-purchase`,
  and the webhook de-dupes on the email's `messageId` — no duplicate inbox rows.
- **Genuine order** → a **pending** row in Purchase Inbox with amount + GST +
  items parsed. You review → **Add to expenses** (draft, `paid=false`, vendor
  "Amazon", category "Office Supplies" — edit if needed) or **Ignore**.
- **Shipping/promo** → auto-marked `ignored` (kept out of your way).
- **Amount not parsed** (odd email) → still captured; you fix the amount in
  Expenses after adding.

## Tips
- Point this at a mailbox/alias that mainly gets your business Amazon orders, or
  add a Gmail filter that labels Amazon order mail and search `label:...` instead.
- Works for any online store — change the `from:`/`subject:` in `SEARCH`. Non-
  Amazon senders are tagged "Online" in the inbox.

## For bulk / back-fill
For hundreds of past orders, use **Amazon Business → order/transaction report
(CSV)**; a future "Import Amazon CSV" will bulk-load those as expenses. The email
forwarder above is for ongoing, day-to-day capture.
