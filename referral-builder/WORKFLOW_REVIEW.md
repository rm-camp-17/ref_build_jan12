# Camp Expert Workflow — End-to-End Review

_A stage-by-stage evaluation of the deal process from the Camp Expert's seat:
what the unified card does well today, where the friction is, and what to do
next. Written after auditing every view, route, and edge path in the system._

## The workflow in one picture

```
Setup ──► Referrals ──► Session ──► Won ──► (clone → next year)
 │            │            │         │
 └────────────┴────────────┴─────────┴──► Lost ──► (clone → next year)
```

| Stage | What the expert does | Card support today |
|---|---|---|
| **Setup** (New Lead) | Link child / household / parents | Checklist of the 3 required associations; Continue button |
| **Referrals** (Rec Plan Presented) | Build the slate: search camps, create referrals, copy from household history, send recs | Create form, one-click Copy / Copy & Edit from household, status + interest editing, **Generate Memo**, **Quick Email** (new) |
| **Session** (Tuition Undecided) | Pick the session / enter tuition | Session picker from the research DB; manual "Enter Tuition" when no sessions on file |
| **Won** (Program Selected) | Confirm, bill, keep the relationship | Session summary, billing, commission structure, **expert & split panel** (new), enrollment email, win reason, clone (+ red reminder when commission is outstanding) |
| **Lost** | Record why, keep the family if they'll return | 7 reasons incl. **Returning camper**; one-step "Mark as Lost & Clone"; clone any lost deal |

## What works well (keep)

- **One card, stage-routed.** The expert never hunts through HubSpot's raw
  property panels; the card shows what matters *at this stage* with a plain-
  language stepper and forward/back nav.
- **One-click paths for the common cases.** CREATE SIGN UP (referral →
  Selected → stage advance), Copy (household referral → created as
  "don't send"), Mark as Lost & Clone — each collapsed a 2–3 step chore into
  one action.
- **Clone logic matches the business.** Won → Tuition Undecided (family
  already chose the camp; enter next year's tuition). Lost with referrals →
  Rec Plan Presented. Lost without → New Lead. Dedup-guarded, idempotent,
  billing fields propagate, red reminder when commissions are outstanding.
- **Deliverables from the same slate.** The referral list drives both the
  full memo (AI-composed .docx, async job + poll) and the new Quick Email —
  one selection, two outputs at two depths.
- **Guardrails.** Commission-lock banner + confirmation flows, sacred-field
  audit log, INVALID_OPTION-proof status values matched from live options,
  admin alerting on pipeline failures.

## Edge scenarios — where they stand

| Scenario | Status |
|---|---|
| **Split referral / co-work deal** | Backend fully handles it (validation, audit log, clone propagation). **Now visible** in the card (Expert & split panel on Won). *Editing* still happens on the deal record — deliberate, since edits are billing-sensitive. |
| **No-credit referral afterwards** (returning camper, family re-enrolls direct) | Covered end-to-end: "Returning camper" lost reason (+ HubSpot enum option on your side) → Mark as Lost & Clone → next-year deal keeps the relationship without fake revenue. |
| **Already-sent referrals on a new year's deal** | One-click Copy creates them as "Don't send (already sent)"; clones stamp the same default. |
| **Camp with no sessions loaded for the year** | Manual "Enter Tuition" form (no more dead end). |
| **Deleted clone / re-clone** | Ledger self-heals; clone recreates. |
| **Second-year commission with no new placement** | Red "commissions remaining" reminder on Won + clone. |

## Gaps and recommendations (prioritized)

1. **Attach the memo to the email flow** *(next, medium effort)* — today the
   expert generates the memo, downloads it, then attaches it to their email by
   hand. Since both are built from the same camp selection, add "Draft email +
   memo" that runs both and puts the memo link inside the drafted email text.
2. **Send from HubSpot instead of copy/paste** *(needs a decision)* — the
   Quick Email is copy/paste by design (experts send from their own inboxes).
   If you'd rather send tracked one-to-one emails from HubSpot, that's a
   `marketing-email`/engagement scope + template decision, not a card change.
   Worth deciding before building.
3. **Split editing in-card** *(only if experts ask)* — the panel is read-only
   on purpose. If experts need to *set* splits themselves, reuse the existing
   validated `deal_split_email` update path with a confirm step; the audit log
   already covers it.
4. **Setup stage could self-serve** *(small)* — the checklist tells the expert
   what's missing but they fix it in the right rail. Inline "create child /
   link household" actions would close the loop for brand-new deals.
5. **Won view is getting long** *(cosmetic)* — six stacked panels. If it keeps
   growing, group into two columns (money left, actions right) like the
   Referrals view does.
6. **Auto-clone on wait-year arrival** *(process decision)* — `wait_until_year`
   is recorded, but nothing fires when that year arrives. A scheduled job (or
   HubSpot workflow) could surface "families due back this year" or auto-clone
   them. Today it relies on the expert remembering.

## What shipped with this review

- **Quick Email** — instant recommendation email (short program name, website,
  location, and the camp's "Four-Sentence Summary for Parents" per camp),
  logged as a note on the deal, shown in-card for copy/paste. Flags camps
  missing a parent summary. No AI latency; safe under the fetch gateway.
- **Expert & split panel** — the five commission-routing fields surfaced
  read-only on the Won view, so split deals are finally visible where the
  money is reviewed.

_Data hygiene note: the Quick Email is only as good as the company records —
`short_program_name`, `website_for_recommendation_entry`, and
`four_sentence_summary_for_parents`. The card flags gaps as it hits them; a
one-time sweep of the most-referred camps would pay off immediately._
