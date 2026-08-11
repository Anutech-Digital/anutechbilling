# Enquiries by email → Enquiries page (Google Workspace, no third-party)

Goal: when someone emails a sales enquiry to your Google Workspace mailbox, it
shows up on **Sales → Enquiries** (and genuine ones auto-become Leads).

The app side is **already built** — the `/api/webhooks/inbound-email` webhook
records the email in `inbound_emails`, runs Gemini triage, and creates a Lead
for genuine enquiries. All that's missing is **getting the email to the
webhook**. Because the mailbox is on Google Workspace, the cleanest route is a
tiny **Google Apps Script** that runs inside your own account — no Postmark /
Cloudflare, no MX changes, and no Gmail-API OAuth verification.

```
someone emails  →  your Gmail (sales@anutech.in)  →  Apps Script (every 5 min)
   →  POST JSON to  https://<YOUR-APP-URL>/api/webhooks/inbound-email?key=<SECRET>
   →  app records it + triages  →  Enquiries page + auto-Lead
```

---

## Prerequisites (one-time, on the app / Cloud Run side)

1. **Deploy** the app (the webhook must be a public URL).
2. Set these env vars on Cloud Run:
   - `INBOUND_EMAIL_SECRET` — any long random string (the webhook's only guard).
   - *(optional)* `GEMINI_API_KEY` (or the tenant's key in Settings) for smart
     triage. Without it, every email is treated as an enquiry and you triage on
     the Enquiries page — nothing is dropped.
   - Tenant routing needs **no change** — inbound enquiries already default to
     the Anutech tenant (`fbb976f1-…`). For any other reseller, set
     `INBOUND_EMAIL_TENANT_ID` to their tenant id.

> Recommended: give customers a dedicated **`sales@anutech.in`** alias/group and
> point the script at that, so your personal mail is never read and newsletters/
> OTPs don't create noise. You can also just use your main address + a Gmail
> filter+label if you prefer.

---

## The Apps Script (copy-paste)

1. Go to **https://script.google.com** (signed in as the Workspace user whose
   mailbox receives the enquiries).
2. **New project** → delete the sample → paste the code below.
3. Edit the three constants at the top (`WEBHOOK_URL`, `SECRET`, `SEARCH`).
4. Run `forwardEnquiries` once — approve the Gmail permission prompt (it's your
   own script accessing your own Gmail; no external app verification needed).
5. **Triggers** (clock icon) → **Add Trigger** → `forwardEnquiries`,
   *Time-driven*, *Minutes timer*, *Every 5 minutes*. Save.

```javascript
// ── ResellerOS — Gmail enquiry forwarder ──────────────────────────────────
const WEBHOOK_URL = 'https://<YOUR-APP-URL>/api/webhooks/inbound-email';
const SECRET      = '<INBOUND_EMAIL_SECRET>';          // must match Cloud Run env
// Only these mails are forwarded. Recommended: a dedicated sales alias.
// Examples:  'to:sales@anutech.in newer_than:3d'   OR   'label:enquiries newer_than:3d'
const SEARCH      = 'to:sales@anutech.in newer_than:3d';

function forwardEnquiries() {
  // Mark processed threads so we never send the same mail twice.
  const done = GmailApp.getUserLabelByName('erp-sent') || GmailApp.createLabel('erp-sent');
  const threads = GmailApp.search(SEARCH + ' -label:erp-sent', 0, 25);

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      const payload = {
        from:      m.getFrom(),               // "Name <email>"
        subject:   m.getSubject(),
        text:      m.getPlainBody().slice(0, 8000),
        messageId: m.getId(),                 // webhook also de-dupes on this
      };
      const res = UrlFetchApp.fetch(
        WEBHOOK_URL + '?key=' + encodeURIComponent(SECRET),
        {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        }
      );
      Logger.log(m.getSubject() + ' → ' + res.getResponseCode() + ' ' + res.getContentText());
    });
    thread.addLabel(done);                    // don't re-process this thread
  });
}
```

---

## How it behaves

- **Idempotent twice over:** the script labels processed threads `erp-sent`, and
  the webhook rejects duplicate `messageId`s — so no duplicate leads even if the
  trigger overlaps.
- **Genuine enquiry** → a Lead is created (source `email-inbound`) and you get an
  owner notification email; it also appears on **Enquiries** as `lead_created`.
- **Not an enquiry** (newsletter/receipt/OTP) → recorded on **Enquiries** as
  `skipped_non_enquiry` (only when Gemini is on); you can still convert by hand.
- **Reply to an existing open lead** (same sender email) → appended to that
  lead's timeline instead of creating a duplicate.

## Test it
Send a test email to `sales@anutech.in` (or your chosen address), wait up to 5
minutes (or Run the script manually), then open **Sales → Enquiries**.

## Multi-tenant note (later)
This Apps-Script approach is per-mailbox and needs no Google verification —
perfect for dogfooding. When other resellers onboard, either (a) each pastes the
same script into their own Workspace with their tenant's `INBOUND_EMAIL_TENANT_ID`
routing, or (b) build an in-app "Connect Gmail" (Gmail API) — note that Gmail is
a *restricted* scope and needs Google's security assessment before external use.
