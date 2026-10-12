# Supabase Setup — 15 minutes

Production-grade. Multi-tenant. Encrypted at rest. RLS-protected.

This guide gets you from "fresh project" to "logged-in user with seeded data" in 15 minutes.

---

## 1. Create your Supabase project (5 min)

1. Go to **https://supabase.com** → sign in with Google/GitHub
2. Click **"New Project"**
3. Fill in:
   - **Name**: `resellersos` (or whatever)
   - **Database password**: Generate a strong one and save it
   - **Region**: **South Asia (Mumbai)** for India performance
   - **Pricing plan**: Free tier is fine for development
4. Wait ~2 minutes for the project to provision

---

## 2. Copy credentials to your local .env (1 min)

In the Supabase dashboard:

1. Go to **Settings → API**
2. Copy these three values:

| Supabase field | Your `.env.local` variable |
|---|---|
| **Project URL** | `NEXT_PUBLIC_SUPABASE_URL` |
| **anon public** key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| **service_role secret** key | `SUPABASE_SERVICE_ROLE_KEY` |

3. Open `production/.env.local` and paste the values:

```env
NEXT_PUBLIC_SUPABASE_URL="https://abcdefghijk.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbG...your-real-key..."
SUPABASE_SERVICE_ROLE_KEY="eyJhbG...your-real-secret..."
```

4. **Restart the dev server**: stop `npm run dev` and start it again.

---

## 3. Run the migrations (5 min)

In the Supabase dashboard:

1. Go to **SQL Editor** (left sidebar)
2. Click **"+ New query"**
3. Open `production/supabase/migrations/0001_init.sql` in your editor
4. Copy the entire contents and paste into the SQL editor
5. Click **"Run"** (or press Ctrl+Enter)
6. You should see: `Success. No rows returned`
7. Repeat for `production/supabase/migrations/0002_rls.sql`

**Verify it worked:**
- Go to **Table Editor** (left sidebar)
- You should see 8 tables: `tenants`, `users`, `customers`, `items`, `leads`, `quotes`, `invoices`, `subscriptions`

---

## 4. Disable email confirmation for dev (1 min)

For local development, skip email verification:

1. Go to **Authentication → Providers**
2. Click on **Email**
3. Toggle OFF **"Confirm email"** (you can re-enable in production)
4. Save

---

## 5. Configure Google OAuth (optional, 3 min)

If you want Google login:

1. Go to **Authentication → Providers**
2. Find **Google** → click to expand
3. Get OAuth credentials from [Google Cloud Console](https://console.cloud.google.com):
   - Create OAuth Client ID (Web application)
   - Authorized redirect URI: `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
   - Copy Client ID + Secret to Supabase
4. Toggle **Google** ON in Supabase → Save

---

## 6. Sign up your first user (2 min)

Open `http://localhost:3000/signup` and fill in:

- **Company name**: `Client A Pvt Ltd`
- **GSTIN**: `27AABCE9876D1Z3` (optional)
- **Your name**: `Pardeep A`
- **Email**: your real email
- **Password**: at least 8 chars

Click **Create account**.

You should be auto-redirected to login. Sign in with the email/password you just used.

✅ You're now logged in as the owner of a new tenant.

---

## 7. (Optional) Seed sample data

Want to play with realistic data instead of an empty workspace?

1. In Supabase SQL Editor, open `production/supabase/seed.sql`
2. **Important**: The seed inserts a tenant with `id = '11111111-1111-1111-1111-111111111111'`. After running it, you need to **link your auth user to this tenant**:

```sql
-- Get your auth user ID (from auth.users)
select id, email from auth.users;

-- Replace 'YOUR-AUTH-USER-ID' with the result above
update public.users
set tenant_id = '11111111-1111-1111-1111-111111111111'
where id = 'YOUR-AUTH-USER-ID';

-- Optionally delete the auto-created tenant for your account
-- (carefully — keep the one you want)
```

After this, login at `/login` → you'll see 21 leads, 7 customers, 12 quotes, etc.

---

## 8. Verify it works

Visit these URLs:

| URL | Expected |
|---|---|
| `http://localhost:3000/` | Landing page |
| `http://localhost:3000/login` | Login form (Supabase configured banner GONE) |
| `http://localhost:3000/signup` | Signup form |
| `http://localhost:3000/dashboard` | Redirects to /login if not logged in, shows dashboard if logged in |
| `http://localhost:3000/leads` | Real Kanban with your leads (after seed) |

---

## 🚨 Troubleshooting

### "Supabase not configured" banner still shows
- Check `.env.local` values don't contain `your-project` (placeholder)
- Restart `npm run dev` after editing `.env.local`
- Hard refresh the browser (Ctrl+Shift+R)

### Login fails with "email not confirmed"
- Step 4 above: disable email confirmation in Supabase Auth → Providers → Email

### RLS policy errors when querying tables
- Make sure your auth user has a row in `public.users` with `tenant_id` set
- Step 6 should auto-create this. If signup failed mid-way, manually insert via SQL.

### "Cannot read tenant_id" in middleware
- The `current_tenant_id()` function is defined in `0001_init.sql`
- Verify it exists: SQL Editor → `select public.current_tenant_id();` (returns NULL if not logged in via auth context)

### Migrations fail with "permission denied for schema public"
- You're using the wrong key. Use **service_role** for migrations, not **anon**.
- In the dashboard SQL Editor, it should work by default.

---

## 📋 What's next

After this setup, you have:
- Multi-tenant DB with RLS
- Working auth (email + Google)
- Real Leads page wired up

Next pages to wire up (in order of importance):
1. **Customers** list + detail
2. **Quotes** list + builder
3. **Invoices** list with margin
4. **Subscriptions** + Renewals
5. **Dashboard** with real aggregates

Each follows the same pattern as `app/(app)/leads/page.tsx` — TanStack Query hook + RSC fetcher + page component.

---

## 🔒 Production checklist

Before going live:

- [ ] Enable email confirmation (Auth → Providers → Email → Confirm email ON)
- [ ] Set up custom SMTP (Auth → Email Templates) for branded emails
- [ ] Configure custom domain (Settings → Custom Domains)
- [ ] Enable PITR (Database → Backups → Point in Time Recovery)
- [ ] Rotate service_role key + put in Vercel env vars (NEVER commit)
- [ ] Set up Vercel deployment with all env vars
- [ ] Add CSP headers to `next.config.mjs`
- [ ] Run security advisor: Supabase dashboard → Database → Security Advisor
