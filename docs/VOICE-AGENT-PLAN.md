# AI Voice-Calling Agent — Design Plan (approved, build deferred)

> Status: **Design approved 4 Jun 2026** (Pardeep). Scope of this doc = design + cost + compliance. **No code built yet.** Build greenlight pending the 4 operator decisions at the bottom.

## Context
ResellerOS should be able to phone leads/customers in **Hindi/Hinglish** for: (1) outbound renewal/payment reminders, (2) lead qualification & callback, (3) inbound call answering, (4) async voice-note blasts. Deep-research flagged **"Hindi + WhatsApp + voice = the moat"** vs pre-AI competitors (Zoho/RackNap).

Decisions locked: **all four** use cases in-scope (phased) · **managed Hindi voice platform** (not self-built real-time pipeline) · this doc is **design only**.

**Honest framing:** a real-time two-way Hindi voice agent is a big system (telephony + STT + LLM + TTS + <800ms turn-taking + India compliance). Smart path = **rent the hard part** (managed agent platform), integrate via API + webhook, reuse ResellerOS's cadence/cron/webhook/credential/Gemini infra. Two hard constraints dominate: **money-correctness** (never speak a wrong ₹ figure) and **India calling compliance** (TRAI/DLT, consent, recording disclosure).

## Recommended architecture (managed-platform integration)
```
Trigger (cron cadence OR manual "Call with AI" button OR inbound ring)
  → ResellerOS builds a money-safe brief (name, plan, days-to-renewal, WhatsApp-sent flag; amounts ONLY if pre-verified)
  → POST to managed voice platform (Sarvam / Bolna / Vapi): start call with agent config + dynamic variables
  → Platform runs the real-time loop (PSTN + Indic STT + LLM + Hindi TTS + barge-in)
  → Platform webhook → /api/webhooks/voice (secret-guarded, idempotent)
       → write/update call_logs (status, duration, transcript, keypress, outcome)
       → advance subscriptions.renewal_state (reminder calls)
       → Gemini post-process transcript → summary + intent + next-best-action
       → write outcome to activity timeline; create a Task if human follow-up needed
```
The app never holds the audio stream — the platform owns real-time. ResellerOS owns: who/when to call, the money-safe brief, the audit log, the post-call action.

### Provider options (eval needed)
| Provider | Hindi/Hinglish | India telephony/DLT | Notes |
|---|---|---|---|
| **Sarvam AI** (recommend) | Best (Saaras STT / Bulbul TTS / Sarvam-M) | India-first | Research-flagged moat; best code-mixing. Confirm voice-agent + outbound-dial API maturity. |
| **Bolna** | Good (Indic) | Via Plivo/Exotel/Twilio | Indian voice-agent platform; open-source core + hosted. Strong fallback. |
| **Vapi / Retell / Bland** | OK (Hindi via ElevenLabs/Deepgram) | US-centric; India via Twilio | Mature infra; India compliance + Hinglish weaker. Alternative. |

**Recommendation:** evaluate Sarvam first, Bolna second. Decide after a 1-day spike calling Pardeep's own phone (judge Hinglish naturalness + latency + per-minute cost).

## Phased rollout (lowest-risk first)
- **Phase 0 — Voice-note blast (NO telephony):** TTS → audio → **WhatsApp voice note** via existing WhatsApp Cloud API media upload. One-way, async, no DLT/PSTN, near-zero compliance risk. Cheapest, days to ship, reuses the most infra. **Ship first.**
- **Phase 1 — Outbound reminder calls (managed platform):** existing customers only (transactional + consented). Money-safe script (no spoken ₹, route to WhatsApp). Cadence-triggered (e.g. T-3) + manual "Call with AI" button. Logs to `call_logs`.
- **Phase 2 — Two-way: lead qualification & callback.** Consent-gated. Gemini-driven dialog; qualify, book demo, route hot leads to human. Cold outbound stays off until compliance airtight.
- **Phase 3 — Inbound answering (IVR replacement).** FAQ + read-only verified status + route-to-human.

## Reuse map (existing infra)
- **WhatsApp client + per-tenant creds** → mirror for voice: `src/lib/whatsapp/client.ts` (`sendWhatsApp`, `toE164`), `tenant_secrets`. Phase 0 reuses its **media upload** directly.
- **Renewal cadence** → add "call" action: `src/lib/renewals/cadence.ts` (`decideCadence`) + `src/app/api/cron/renewals/route.ts` (`CRON_SECRET`, daily idempotency).
- **Webhook patterns** → `src/app/api/webhooks/razorpay/route.ts` (signature) + `inbound-email/route.ts` (shared secret + dedup-by-id).
- **Gemini route + stub fallback** → `src/app/api/ai/draft-followup/route.ts` (transcript post-process + script gen).
- **Audit table** → new `call_logs`, mirror `inbound_emails` (mig 0069) + `renewal_email_log` (mig 0008).
- **Phone helpers** → `toE164`, `formatPhone` (`lib/utils.ts`), `toE164Digits`/`phoneDisplay` (`lib/portal/branding.ts`).
- **Manual trigger UI** → reuse `NextBestActionCard` (`src/components/features/customers/customer-insights.tsx`) → "Call with AI".

## New components (when greenlit)
- Migration `00xx_call_logs.sql`: `call_logs` (tenant_id, lead/customer/subscription id, provider_call_id UNIQUE, contact_phone, direction enum, status enum, duration, transcript, ai_summary, ai_intent, outcome, keypress, recording_url, error, started/ended_at) + RLS + types. Optional `voice_consent` flag on customers/leads.
- `src/lib/voice/client.ts` — provider client (`startOutboundCall`, `getCall`), `toE164` normalize, per-tenant creds from `tenant_secrets`, **stub fallback** for testing without spend.
- `src/app/api/webhooks/voice/route.ts` — secret-guarded + idempotent (provider_call_id): update `call_logs`, advance `renewal_state`, Gemini post-process, write activity + optional Task.
- `src/app/api/ai/voice-script/route.ts` (or extend draft-followup) — spoken Hinglish script from a money-safe brief.
- Cron hook — guarded "call" action in `cron/renewals` (tenant opt-in + calling window + money-safe).
- Settings → Integrations → Voice — provider creds in `tenant_secrets`; consent + calling-window + opt-out config.

## Money-correctness guardrails (compass-critical)
- Agent **never computes/improvises a ₹ figure**; any amount is a pre-verified variable said verbatim, or omitted.
- Default scripts route money specifics to **"exact amount aapke WhatsApp pe bhej diya hai"** (DB-derived figure lives there).
- No call performs a money-write; payment via existing Razorpay/portal link, never "confirmed" verbally.
- Transcripts logged for audit; amounts in transcripts are advisory, never authoritative.

## India compliance (before any live outbound)
- **TRAI/DLT + DND:** transactional calls to your **own consented customers** about their service = safe zone; promotional/cold needs DND scrub + registered headers/consent. **Start customers-only; defer cold-lead outbound.**
- **Calling window** ≈9am–9pm IST enforced in trigger.
- **Recording-consent disclosure** at call start; store `recording_url` + consent flag.
- **Opt-out** honored + persisted per contact.
- **Caller-ID / KYC** registration with telephony provider.

## Cost model (ESTIMATES — verify with quotes)
- Managed agent (STT+LLM+TTS): ~$0.05–0.20/min (≈₹4–17/min).
- India PSTN outbound: ~₹0.5–1.5/min + number rental ~₹500–2,000/mo.
- Blended ≈ ₹5–15/min → ~2-min reminder ≈ ₹10–30. 100 calls/day ≈ ₹1,000–3,000/day.
- Phase 0 (WhatsApp voice note) far cheaper. One-time: DLT/caller-ID + KYC.

## Verification (when built)
1. Provider sandbox spike (call own phone; judge Hinglish/latency/cost; pick provider).
2. Phase 0: TTS voice note → WhatsApp to a test number; confirm audio + dynamic data.
3. Phase 1 e2e on a test customer: reminder call → `call_logs` row → status/transcript via webhook → `renewal_state` advances → activity updated → **assert no ₹ spoken** unless pre-verified.
4. Compliance dry-run: window + consent enforced; recording disclosure plays; opt-out persists.
5. Cost check in sandbox before volume.

## Open decisions for Pardeep (build greenlight)
1. Monthly voice **budget** ceiling (drives volume + provider).
2. **Provider** after spike (Sarvam vs Bolna).
3. **Number + DLT/KYC** ownership (Client A).
4. **Consent** source for leads (web form / WhatsApp opt-in / missed-call callback).

## Honest risks
- Hinglish latency/naturalness varies — hear it before committing (a clunky agent hurts the brand more than no agent).
- Compliance missteps (cold calls, no consent) → real TRAI penalties; customers-only start is non-negotiable.
- Cost creep at volume — meter per-call and cap.
- Multi-week across phases; Phase 0 delivers value in days and de-risks the rest.
