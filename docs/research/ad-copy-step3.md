# Ad copy (Co-pilot Step 3): research note

R-1897, 25 Oct 2026. Pardeep asked: "campaign me ad copy kaise banegi iska bhi poora logical system banao taki user aasani se kaam kar sake".
This note lists what the platforms themselves say, and what Step 3 does because of it. All numbers come from the official pages
linked below (read 25 Oct 2026). `production/src/lib/marketing/copilot/channel-specs.ts` stays the one place that holds them.

## Google Ads: responsive search ad (RSA)

Source: https://support.google.com/google-ads/answer/7684791

- 3 to 15 headlines, each up to 30 characters. 2 to 4 descriptions, each up to 90. Two display path fields, up to 15 each.
  Double-width characters count as 2.
- Google mixes the lines in any order. Each line has to make sense alone and next to any other line.
- **Pinning** is optional. Headline positions 1 and 2 and description position 1 always show; headline 3 and description 2 may not.
  Text that has to show in every ad (a disclaimer) is pinned to headline 1, headline 2 or description 1. Pinning cuts the number of
  combinations and can lower Ad Strength, so Google advises against it for most advertisers. If you pin, pin 2 or 3 different
  lines to the same position.
- **Ad Strength** rewards many *unique* headlines, at least one keyword in the headlines, and few pins. Google suggests at least
  2 RSAs per ad group rated Good or Excellent.
- Performance Max (our "sales" objective): 3 to 15 headlines of 30, 1 to 5 long headlines of 90, 2 to 5 descriptions of 90, a business
  name of 25 (https://support.google.com/google-ads/answer/14528373).

## Meta (Facebook / Instagram): feed image ad

Sources: Ads Guide https://www.facebook.com/business/ads-guide/update/image/facebook-feed/traffic ·
Marketing API asset feed options https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/options

- Meta publishes **recommended** lengths, not hard limits: primary text 50 to 150 characters, headline 27. Longer text is
  cut with "See more", so it is a warning, not a block.
- Meta takes several versions of each text and mixes them: the API allows up to 5 bodies (primary texts), 5 titles (headlines),
  5 descriptions and 5 call-to-actions per ad.
- The call-to-action is a button chosen from Meta's fixed list (Learn more, Shop now, Sign up, Contact us, Get quote, Apply now,
  Order now, Download, Get offer, Call now, Send WhatsApp message, Send message, Subscribe, and others). Some CTAs only show for some
  industries.
- Text inside the image: Meta removed the old 20% rule. The Ads Guide page above gives no text-in-image limit today. Less text
  on the image still reads better on a phone (the image slot is R-1909).

## Policy and quality (both platforms)

Google editorial policy and Meta advertising standards:
- No unproven claims ("best", "No. 1", "guaranteed") unless the advertiser can prove them.
- No ALL CAPS for emphasis, no repeated punctuation ("!!!"), no gimmicky symbols or emoji in Google text.
- Prices and offers must match the landing page. We go further: a rupee figure the person did not give is dropped (R-1876 money guard).
- Use other companies' trademarks only with permission.

## What Step 3 does because of this

| Platform says | Step 3 does |
|---|---|
| Lines are mixed in any order | Each line is its own row: edit, rewrite, keep or delete it alone |
| Hard limits (Google) | Live counter `28/30`, red past the limit; a red line blocks "Mark ready" |
| Recommended lengths (Meta) | Counter turns red past the recommendation; it warns but does not block |
| Many unique headlines help | "Write copy with AI" fills the full set: Google 15 headlines + 4 descriptions (+ 2 paths); Meta 3 primary texts, 3 headlines, 1 description and a CTA |
| Pinning is optional and costly | Google lines get an optional "Pin" (position 1/2/3 for headlines, 1/2 for descriptions); default is no pin |
| Some lines must stay | "Keep" locks a line: a new AI run replaces only the lines that are not kept |
| Several audiences | One block per platform and audience ("Main audience", "People like my customers" on Meta) |
| An ad needs a minimum set | "Mark ready" needs, for every chosen platform, one block that meets the platform's minimum (Google 3 headlines + 2 descriptions; Meta 1 primary text + 1 headline + a CTA) with no line over a hard limit; otherwise it lists what is missing |

Nothing is ever sent to Google or Meta from Step 3. The AI drafts; the person edits and approves; publishing is a later step.

Later cards: live previews and an Ad Strength meter (R-1908); per-line policy checks, landing URL with UTM, image slot (R-1909).
