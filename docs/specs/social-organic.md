# G-SOCIAL: organic social growth (Facebook, Instagram, LinkedIn)

Started 5 Nov 2026 from Abhishek's request. Reshaped 12 Nov 2026 (v2): one place to grow the
company's organic audience, where an AI agent does every action the platforms allow, and a person
can watch it, change it, stop it, or do the same action by hand. Board goal card: `G-SOCIAL`.

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
- Only owner changes modes and Stop all AI; owner/manager approve; marketing writes.
- Tokens stay sealed in `tenant_secrets`; never sent to the browser. Times shown in IST.

## 5. Data

- `social_content` (posts, all platforms; R-2688 adds `linkedin`), `social_content_settings`
  (brief, autopilot, posts_per_week, picture_urls; R-2687 adds `ai_paused`).
- New `social_activity` (R-2687): tenant_id, at, actor (`ai` / user id), platform, action, detail,
  content_id, result.
- R-2689 `social_comments`; R-2690 `social_follower_snapshots` (one row a day per platform).

## 6. Constraints

- Meta scopes as before plus `pages_manage_engagement`, `instagram_manage_comments`,
  `read_insights`, `instagram_manage_insights` (reconnect needed). LinkedIn: `w_organization_social`,
  `r_organization_social`, follower stats need `rw_organization_admin`.
- Instagram needs a public HTTPS picture. Rate limits per token; crons ≤ 25 items per company per run.

## 7. Owner decisions

| Question | Answer | Who, date |
|---|---|---|
| Must a person approve every post? | Replaced: per action **Off / Ask me first / Autopilot**, plus Stop all AI | Abhishek, 11–12 Nov 2026 |
| Who may approve? | Owner and manager | decided in session, 5 Nov 2026 |
| Posts a week | 3 default, 1–7 setting | decided in session, 11 Nov 2026 |

## 8. Cards graph

```
R-2687 (Social growth page: platforms + modes + activity list + Stop all AI)
   ├─> R-2688 (LinkedIn posts in the same queue)
   ├─> R-2689 (comment replies: AI + manual)
   ├─> R-2690 (follower tracking + weekly report)
   └─> R-2691 (daily to-do list)
```

- Wave 1: R-2687. Wave 2: R-2688, R-2689. Wave 3: R-2690, R-2691.
