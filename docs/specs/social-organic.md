# G-SOCIAL: organic social growth (Facebook, Instagram, LinkedIn)

Started 5 Nov 2026 from Abhishek's request. Reshaped 12 Nov 2026 (v2): one place to grow the
company's organic audience, where an AI agent does every action the platforms allow, and a person
can watch it, change it, stop it, or do the same action by hand. Board goal card: `G-SOCIAL`.
v3 (12 Nov 2026, Abhishek): AI pictures per post (R-2697), a strategy per platform, post results,
and weekly learning (R-2705..R-2707).

## 1. Goal

The marketing person opens **Marketing → Social growth** and:
- sees the followers on Facebook, Instagram and LinkedIn and how they move week by week;
- sets each AI action to **Off / Ask me first / Autopilot**;
- reads a live list of what the AI did and will do, with Edit / Stop on every item, and one big
  **Stop all AI** switch;
- does any of the same actions by hand from the same page;
- gets a short daily to-do list for the actions the platforms do not let software do.

**Measure:** for 4 weeks in a row at least 3 posts a week go out on every connected platform from
the app, comments get an answer within a day, and the page shows the follower change each week.

## 2. What grows an organic audience — and who does it

| Action | AI (via API) | Notes |
|---|---|---|
| Post 3–5 times a week at good times, varied formats | ✅ FB, IG (needs a picture), LinkedIn Page | Picture library for IG |
| Answer comments on our posts quickly | ✅ FB, IG, LinkedIn | R-2689 |
| Learn what worked, write more of it | ✅ weekly report + next week's brief | R-2690 |
| Answer DMs | later | needs extra Meta permission and the 24-hour rule |
| Like / comment on others' posts, join groups, invite people to like the Page, follow accounts | ❌ never by software | breaks Meta / LinkedIn rules, can get the Page blocked → **daily to-do list** for the person (R-2691) |

## 3. Users & flows

| Who | Does |
|---|---|
| Owner | Connects Facebook Page (links Instagram) and LinkedIn Company Page once; adds a Gemini key; sets each AI action's mode; can press **Stop all AI**. |
| Marketing / manager | Writes posts and replies by hand; approves AI items when the mode is Ask me first; Stops / edits any scheduled item. |
| AI (crons) | Plans the week's posts (Monday), publishes approved items at their time, drafts or sends comment replies, takes a daily follower snapshot. Never acts while Stop all AI is on. |

## 4. Rules

- **Stop all AI** wins over every mode: while it is on, no AI item is planned or published; items
  already scheduled by the AI wait (shown as "Paused").
- Mode per action: Off (AI does nothing), Ask me first (AI items wait in Waiting for approval),
  Autopilot (AI items go out at their time). Items a person writes always follow the normal approval flow.
- Every AI or person action is written to the activity list (who, what, where, when, result).
- Never auto-follow, auto-like, auto-DM, or comment on other people's pages.
- Only the owner changes modes and resumes the AI; marketing (and owner/manager) approve, schedule, stop and change strategies (R-2709).
- Tokens stay sealed in `tenant_secrets`; never sent to the browser. Times shown in IST.
- **Same idea, not the same words (R-2705):** each platform has a strategy (kinds of post with %
  share, tone, length, hashtags, posting hour, avoid). Topic and picture are shared; the text is
  written per platform from its strategy, and each platform posts at its own hour.
- **Learning (R-2707):** weekly, before planning, with 3+ posts with results (last 6 weeks) on a
  platform, the AI keeps what worked and changes what did not. Autopilot → new version active;
  Ask me first → it waits as proposed for **Use it / Keep old**. Owner/manager may edit any time
  (a new version). Fewer results → no change, the plan note says how many more are needed.
- **Comments (R-2689):** Off / Ask me first (default) / Autopilot. The AI writes a reply to each new
  comment; on Autopilot it sends questions/praise itself, never complaints (a person answers) or
  spam. Checked every ~25 min by the social-publish cron and by "Check comments now". Needs Meta
  `pages_read_user_content`, `pages_manage_engagement`, `instagram_manage_comments` (switched on with
  `META_COMMENT_SCOPES=1` after adding them in the Meta app); without them the page says so.
- **Followers + weekly report (R-2690):** today's count is saved daily (cron + page open); cards show
  the change over 7 / 30 days and a 30-day line. The weekly plan writes a report (followers, posts,
  best post, comments answered) with the AI's advice from real numbers only; "Make report now" too.
- **Daily to-do (R-2691):** 5 things only a person may do (invites, commenting on others' posts,
  sharing to groups, real photos, reviews), made once a day; ticks are saved and logged in Activity.
- **AI pictures (R-2697):** one picture per post, no words/logos/prices/real people, kept as an
  unpublished photo on the Page; the fresh image link is read just before posting.

## 5. Data

- `social_content` (posts, all platforms; R-2688 adds `linkedin`), `social_content_settings`
  (brief, autopilot, posts_per_week, picture_urls; R-2687 adds `ai_paused`).
- New `social_activity` (R-2687): tenant_id, at, actor (`ai` / user id), platform, action, detail,
  content_id, result.
- R-2689 `social_comments`; R-2690 `social_follower_snapshots` (one row a day per platform).
- R-2705 `social_strategy` (tenant, platform, version, plan jsonb, reason, status active /
  proposed / replaced / rejected; one active + one proposed per platform). `social_content` gains
  `post_type`, `strategy_version`, `stats` jsonb (reach, likes, comments, shares, saves), `stats_at`.
- R-2706 results are read 2+ days after posting (≤ 40 a run) when the week is planned.
- R-2689 `social_comments` (platform, external_id, author, message, kind, status new/draft/replied/
  ignored/failed, ai_reply, reply, replied_by ai/person); `social_followers` (one row per day per
  platform); `social_reports` (per week); `social_todo` (per day, items jsonb).
  `social_content_settings` gains `comment_mode`, `comments_checked_at`, `comments_problem`,
  `followers_checked_on`. Migration 20261113083000.

## 6. Constraints

- Meta scopes as before plus `pages_manage_engagement`, `instagram_manage_comments`,
  `read_insights`, `instagram_manage_insights` (reconnect needed). LinkedIn: `w_organization_social`,
  `r_organization_social`, follower stats need `rw_organization_admin`.
- Instagram needs a public HTTPS picture. Rate limits per token; crons ≤ 25 items per company per run.

## 7. Owner decisions

| Question | Answer | Who, date |
|---|---|---|
| Must a person approve every post? | Replaced: per action **Off / Ask me first / Autopilot**, plus Stop all AI | Abhishek, 11–12 Nov 2026 |
| Who may approve? | **The marketing person** approves the AI's posts (owner/manager may, need not). A person's own post is scheduled straight away ("Schedule post"). AI posts waiting → bell to marketing (owner when none). Resume AI + AI settings stay owner-only (R-2709) | Abhishek, 12 Nov 2026 (was: owner and manager, 5 Nov) |
| Posts a week | 3 default, 1–7 setting | decided in session, 11 Nov 2026 |
| Same text on every platform? | No — same topic + picture, text per platform from its strategy | Abhishek, 12 Nov 2026 |
| Strategy should update from data | Yes — weekly; keep what works, change what does not | Abhishek, 12 Nov 2026 |
| Score of a post | likes + 2×comments + 3×shares + 3×saves; 3 results minimum to learn | decided in session, 12 Nov 2026 |

## 8. Cards graph

```
R-2687 (Social growth page: platforms + modes + activity list + Stop all AI)
   ├─> R-2688 (LinkedIn posts in the same queue)
   ├─> R-2689 (comment replies: AI + manual)
   ├─> R-2690 (follower tracking + weekly report)
   └─> R-2691 (daily to-do list)
```

R-2697 (AI picture per post) → R-2705 (strategy per platform + per-platform text)
   → R-2706 (post results) → R-2707 (weekly learning)
```

- Wave 1: R-2687. Wave 2: R-2688, R-2689. Wave 3: R-2690, R-2691. R-2697 → R-2705 → R-2706 → R-2707 in order.
