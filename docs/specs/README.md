# docs/specs — one spec per goal (R-2420, 3 Nov 2026)

A **goal** is work bigger than one card (G-COLLECT, the Razorpay fee system, …). Its spec lives
here, in git, so every team member's Claude can read it — not only on one laptop
(`Anutech-HQ/drafts/` is a scratch place; the spec in this folder is the truth).

How a spec is made: load the repo skill [`goal-spec`](../../.claude/skills/goal-spec/SKILL.md).
Cards on the board point back with `goal: "<G-NAME>"`; workers read the spec before building.

## Sections (same order in every spec)

1. **Goal** — what the owner can do when it is finished, plus how we measure it.
2. **Users & flows** — who opens which screen and what they press, step by step.
3. **Rules** — money, GST, roles, what must never happen.
4. **Data** — tables / columns / functions it reads or adds.
5. **Constraints** — outside limits (gateway, law, CA to confirm).
6. **Owner decisions** — each question, the answer and who gave it (date). Open ones say the default that was built.
7. **Cards graph** — cards, `dependsOn`, waves; cards in the same wave never share files.
   No build status here — the board is the truth for that.

## Rules for writing a spec

- No customer names, customer amounts, GSTINs, keys or tenant ids — the repo is public and the
  push secret-scan rejects them. Say "customer A", "the staging company", "a ₹1 leftover".
- When the owner decides something on a card, copy it into **Owner decisions** in the same card's commit.
- Keep it short (about 100–150 lines). Research links stay in the spec only when a rule depends on them.

## Specs

Which cards are built lives on the board (filter by `goal`), not here.

| Spec | Goal |
|---|---|
| [g-collect.md](g-collect.md) | G-COLLECT — Payment Follow-up a team can work from |
| [razorpay-fee.md](razorpay-fee.md) | Who pays the online payment (Razorpay) fee |
| [g-network.md](g-network.md) | G-NETWORK — when my customer or vendor also uses ResellerOS |
