# G-SOCIAL: organic Facebook + Instagram growth

Started 5 Nov 2026, from a request by Abhishek. Board goal card: `G-SOCIAL`.

## 1. Goal

The marketing team grows the followers of the company's connected Facebook Page and Instagram professional account.
- AI writes the posts and the comment replies.
- A person approves every post and every reply before it goes out.
- The app publishes at the planned time.

**Measure:** one post a week is planned, approved and published from the app for 4 weeks in a row, and the report shows the follower change for each week.

## 2. Users & flows

| Who | Screen | Does |
|---|---|---|
| Owner | Marketing → Facebook Page | Connects the Page once, which also links its Instagram account. |
| Marketing / manager / owner | Marketing → Social content | Writes a draft, or presses "AI write" on a topic. Sets the post time. Presses Submit for review. |
| Owner / manager | Social content | Approves the draft or sends it back. An approved post becomes Scheduled. |
| System (cron) | — | Publishes Scheduled posts when their time comes. Every Monday it prepares drafts, and never publishes them. |
| Marketing / manager / owner | Social content → Comments | Sees new comments with an AI reply draft. Edits it, then presses Send reply. |
| Owner / manager | Social content → Report | Sees followers, reach, the best post and AI advice for next week. |

## 3. Rules

- Nothing reaches Facebook or Instagram without a person's approval: neither a post nor a reply.
- Never auto-follow, auto-like, auto-DM or comment on other people's pages. These break Meta's rules and can get the Page blocked.
- Only owner and manager approve. Marketing writes drafts. Other roles cannot open the screen.
- Page tokens are sealed in `tenant_secrets` and never reach the browser.
- Instagram needs a public HTTPS image or video URL. Meta cannot fetch a `localhost` URL.
- Every time shown on screen is IST.

## 4. Data

- `tenant_secrets.facebook_page_*`: 7 columns, all secret.
- `social_content`: drafts and posts. Columns: status `draft → review → approved/scheduled → published | failed`, platform, format, caption, media_url, scheduled_at (R-2510), external_id, error.
- `social_content_settings`: auto_drafts, brief, last_generated_on.
- New in R-2511: `social_comments`, the comments fetched from our posts plus the AI reply and its reply status.
- New in R-2512: `social_follower_snapshots`, one row a day per platform.

## 5. Constraints

- Meta Graph API scopes:
  - Facebook Page: `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement` (to reply), `read_insights`.
  - Instagram: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`.
- New scopes need the Page to be connected again.
- Meta App Review is needed before these scopes work on Pages whose admins are not app testers.
- Rate limits are per Page token. The crons process at most 25 items per company per run.
- New migrations go in `prisma/migrations`. `supabase/migrations` is frozen.

## 6. Owner decisions

| Question | Answer | Who, date |
|---|---|---|
| Must a person approve every post and reply? | Yes, always | Abhishek, 5 Nov 2026 |
| Who may approve? | Owner and manager (default built) | decided in session, 5 Nov 2026 |
| How many posts a week? | 3–5 suggested. The Monday AI draft count is a setting (default 1 per platform) | decided in session, 5 Nov 2026 |

## 7. Cards graph

```
R-2509 (fix Codex work: tests, migrations, safety)
   ├─> R-2510 (scheduled auto-publish)  ──> R-2512 (weekly report)
   └─> R-2511 (comments + AI reply)
```

- Wave 1: R-2509.
- Wave 2: R-2510 and R-2511 run in parallel. They share no files, apart from each adding its own new migration folder.
- Wave 3: R-2512.
