# Google Sign-In Setup — Supabase + Google Cloud

Code already built. Sirf 2 dashboards me credentials configure karne hain — total **~10 minutes**.

## Pre-existing infrastructure (already in place)

| Component | File | Status |
|---|---|---|
| "Sign in with Google" button | `src/app/(auth)/login/page.tsx` line 128-136 | ✅ Ready |
| OAuth flow trigger | `signInWithOAuth({ provider: "google" })` | ✅ Ready |
| Callback handler | `src/app/(auth)/callback/route.ts` | ✅ Ready |
| Session exchange | `exchangeCodeForSession()` | ✅ Ready |
| Auth middleware | `src/lib/supabase/middleware.ts` | ✅ Ready |

Bas dashboard pe credentials chahiye.

---

## Step 1 — Google Cloud Console (5 min)

### 1.1 Open / create a project

Go to: <https://console.cloud.google.com/>

- Top bar → project selector → **"New Project"** (ya existing project use karo, e.g., "ResellerOS")
- Project name: `ResellerOS` (ya jo accha lage)
- Note the **Project ID** (auto-generated, e.g., `resellersos-470213`)

### 1.2 Enable required APIs

Sidebar → **APIs & Services → Enabled APIs**:

- Click **"+ ENABLE APIS AND SERVICES"**
- Search and enable:
  - **Google People API** (for future contacts integration)
  - **Identity Toolkit API** (usually auto-enabled)

### 1.3 OAuth consent screen

Sidebar → **APIs & Services → OAuth consent screen**:

- User Type: **External** (unless you have Google Workspace org)
- App name: `ResellerOS` (or `Client A — ResellerOS`)
- User support email: `Pardeep@example.test`
- Developer email: `Pardeep@example.test`
- App domain: `https://resellersos.web.app` (or whatever your Cloud Run / Firebase URL is)
- Authorized domains: Add `supabase.co` AND your app domain
- **Scopes**: For now just default (`email`, `profile`, `openid`). Add `contacts.readonly` later when building Google Contacts import.

### 1.4 OAuth 2.0 Credentials

Sidebar → **APIs & Services → Credentials**:

- Click **"+ CREATE CREDENTIALS" → "OAuth 2.0 Client ID"**
- Application type: **Web application**
- Name: `ResellerOS Web Client`
- **Authorized JavaScript origins**:
  ```
  http://localhost:3000
  http://localhost:55277
  https://resellersos.web.app
  https://<your-cloud-run-url>
  ```
- **Authorized redirect URIs** ← critical, must be EXACT:
  ```
  https://ontpnqjoysjgrlsukecm.supabase.co/auth/v1/callback
  ```
  (This is your Supabase project's callback URL — `<project-ref>.supabase.co/auth/v1/callback`)
- Click **CREATE**
- Copy **Client ID** + **Client Secret** — needed in Step 2

---

## Step 2 — Supabase Dashboard (3 min)

Open: <https://app.supabase.com/project/ontpnqjoysjgrlsukecm/auth/providers>

- Find **Google** in the providers list
- Toggle **Enable Sign in with Google** ON
- Paste:
  - **Client ID** (from Step 1.4)
  - **Client Secret** (from Step 1.4)
- **Authorized Client IDs**: blank (single-provider)
- **Skip nonce check**: OFF (default secure)
- Click **Save**

The "Redirect URL" shown at the top of this page should match what you pasted in Step 1.4 — verify they match.

---

## Step 3 — Test (2 min)

1. Restart your local dev server (env may not need it, but cleanest)
2. Open <http://localhost:55277/login> (or wherever your preview runs)
3. Click **"Sign in with Google"**
4. Google consent screen aayegi — choose `pardeep@anutech.in` (or any other Google account)
5. Click **Continue / Allow**
6. Redirect → `/callback?code=...` → `/dashboard`

✅ If you land on dashboard, sign-in works.

### Common issues + fixes

| Error | Cause | Fix |
|---|---|---|
| "redirect_uri_mismatch" | Step 1.4 me URI galat ya different | Make sure exactly: `https://ontpnqjoysjgrlsukecm.supabase.co/auth/v1/callback` |
| "Access blocked: ResellerOS has not completed verification" | Consent screen me Publishing status = Testing | Add your test users in "Test users" tab (Step 1.3) — `pardeep@anutech.in`, etc. |
| Lands on `/login?error=auth_failed` | `exchangeCodeForSession` failed | Check Supabase dashboard → Auth → Logs for details |
| "This account doesn't exist in our system" | New user, no users row | Run `/scripts/create-user.mjs` for the email OR enable auto-signup in your code |

---

## Step 4 — New users from Google sign-in (production caveat)

Currently the app expects every auth user to have a row in `public.users` linked to a tenant. When someone signs in via Google for the first time:

- ✅ Supabase creates `auth.users` row
- ❌ App's `public.users` row does NOT exist yet
- ❌ App `useCurrentUser()` returns null → redirects to login or breaks

**Fix options:**

**Option A** — Existing-users-only Google sign-in (simplest):  
Only allow people who already have a `users` row to sign in. Show error if not.

**Option B** — Auto-onboard new signups:  
On callback, if `users` row doesn't exist:
- Show a "Welcome — set up your workspace" page
- Ask for company name → create tenant + users row → continue to dashboard

**Option C** — Manual invite-only:  
Pardeep manually adds an `auth.users` + `users` row for each new operator. Then they sign in.

For now, **Option A** is safe (you control who can sign in). When you want to invite teammates, add their email via the `/scripts/create-user.mjs` script first, then they sign in with Google.

---

## Future — Google Contacts scope

When building Google Contacts import (`/leads` → "Import from Google account"), add this to **Step 1.3** scopes:

```
https://www.googleapis.com/auth/contacts.readonly
```

Then in the existing `signInWithOAuth` call, pass:

```ts
await supabase.auth.signInWithOAuth({
  provider: "google",
  options: {
    scopes: "https://www.googleapis.com/auth/contacts.readonly",
    queryParams: { access_type: "offline", prompt: "consent" },
    redirectTo: ...,
  },
});
```

The `provider_token` in the resulting session will let you call People API server-side. (Code for that is already built — `/api/contacts/google-fetch`.)

---

## Verification checklist

- [ ] Google Cloud project created/exists
- [ ] OAuth consent screen configured
- [ ] OAuth 2.0 Client ID + Secret generated
- [ ] Authorized redirect URI matches Supabase callback EXACTLY
- [ ] Supabase Dashboard → Google provider enabled with credentials
- [ ] Test sign-in successful from /login
- [ ] Lands on /dashboard after consent

Once all checked, you can also do Google Contacts import (separate task).
