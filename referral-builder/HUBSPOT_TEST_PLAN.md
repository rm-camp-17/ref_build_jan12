# HubSpot Test Plan — Referral Builder fixes (PR #49)

Most of this code can only be validated against live HubSpot, since the card UI
and the HubSpot-side pollers/automations don't run in CI. Work through this on a
**dedicated TEST deal** (and a couple of supporting test deals) before trusting
it on real records.

Legend: 🟢 = new behavior to confirm, 🔁 = regression check (must still work).

---

## 0. Pre-flight

- [ ] Vercel API deployed (health: `GET https://<api>/api/health` returns `{ ok: true }`).
- [ ] HubSpot card uploaded (`hs project upload`) and the card shows on the Deal sidebar.
- [ ] Pick a **TEST deal** in the active "Deal Pipeline" with an associated child + household + parent contact.
- [ ] (Optional) Set `RESEND_API_KEY` + `ALERT_FROM_EMAIL` in Vercel. If unset, failure alerts appear as HubSpot tasks assigned to Riley.

---

## 1. Closed Lost moves (item 3)

- [ ] 🟢 On a deal at any non-terminal stage, click **Mark as Lost**, pick a category, Save.
- [ ] 🟢 Deal stage actually changes to **Closed Lost** (check the pipeline header, not just the card).
- [ ] 🟢 Re-open the card → it shows the read-only Closed Lost summary.

## 2. Program appended to deal name (item 2)

- [ ] 🟢 Take a deal to **Closed Won** with tuition entered (via session select). Deal name becomes `… — {Camp/Program}`.
- [ ] 🟢 Move the deal **out** of Closed Won (drag the stage natively in HubSpot, then re-open the card) → the ` — {program}` suffix is removed.
- [ ] 🟢 Re-open the card twice in a row at Won → the program is **not** appended twice (idempotent).
- [ ] 🔁 A deal with no program set is unaffected.

## 3. "Other" tuition saves + advances (item 6)

- [ ] 🟢 At Tuition Undecided, choose **Other**, enter a plain amount (e.g. `4500`) + weeks, submit → deal advances to **Program Selected** and `tuition_at_enrollment` is saved.
- [ ] 🟢 Repeat with a formatted amount **`$1,200`** → it saves `1200` (no silent failure).
- [ ] 🔁 Selecting a normal listed session still advances to Won as before.

## 4. One-click program selection (item 5)

- [ ] 🟢 On a deal at Recommendation Plan Presented with ≥2 referrals (some Active/considering), click **"Client selected this program"** on one referral.
- [ ] 🟢 That referral becomes **Selected**, the deal advances (to Tuition Undecided), no confirm reload.
- [ ] 🟢 The deal's **other** referrals that were **Active/considering** flip to **Declined**; their company associations are still intact.
- [ ] 🟢 Referrals that were in other states (Shortlist/Neutral/Unlikely/already Declined/Selected) are left untouched.
- [ ] 🔁 The old **Edit → Interest → Selected** path still works (and also declines siblings now).

## 5. Copy note to company (item 8)

- [ ] 🟢 Edit a referral's note, click **"Copy note to other referrals"** → every other referral on the deal shows the same note.
- [ ] 🟢 Copying a note does **not** change any referral's Selected/interest state (esp. a Selected referral stays Selected, deal stays put).
- [ ] 🔁 Editing a single referral's note normally still saves.

## 6. Enrollment email at Won (item 4)

- [ ] 🟢 At Closed Won, the card shows the **Enrollment email** panel (tuition, enrollment status, dates).
- [ ] 🟢 Tick the checkbox + **Send enrollment email** → `send_enrollment_email` becomes true on the deal; within ~2 min your existing poller sends it and the card status flips to **Sent**.
- [ ] (Referral-email sending is intentionally NOT in this card — handled by your separate module.)

## 7. Clone is immediate, carries everything (item 1)

- [ ] 🟢 On a **Closed Won** deal, click **Create Next Year Deal** → a new deal is created **immediately** for next year.
- [ ] 🟢 New deal has the **same referrals** (same camps, notes; status/interest reset), the **same associations** (child, household, parent, company), and the **prior activity** (notes/calls/emails/meetings show on both deals).
- [ ] 🟢 New deal lands at **Recommendation Plan Presented** (because referrals carried over). On a deal with **no** referrals, it lands at **New Lead**.
- [ ] 🟢 On a **Closed Lost** deal with reason **"Waiting for next year"**, the card shows a **Clone to next year** button (pre-filled year) → clones immediately. For any other loss reason, **no** clone button.
- [ ] 🟢 Cloning the same deal/year twice does **not** create a duplicate (dedup via ledger).
- [ ] 🔁 Confirm the old nightly **auto-clone** no longer runs (it's removed). No WAIT_NEXT_YEAR deal should auto-spawn overnight.

## 8. Failure alerts (item 7)

- [ ] 🟢 Force a failure (e.g. temporarily point the card at a bad deal id, or revoke a scope) on a stage move/submit → you receive an **email** (Resend) or a **HubSpot task** (fallback) containing the deal, the action, and the exact error.

---

## Regression sweep (must still work unchanged)

- [ ] 🔁 New Lead setup checklist (child/household/parent) renders.
- [ ] 🔁 Add referrals / search companies / create a referral.
- [ ] 🔁 Commission-locked banner still disables editing on locked deals.
- [ ] 🔁 Win-reason and Loss-reason capture still save.
- [ ] 🔁 Billing panel (ce_* fields) still reads correctly on Won.

---

## Rollback

- **API:** Vercel → promote the previous production deployment (instant). The
  `clone_ledger` table/migration are untouched.
- **Card:** re-upload the prior card version (or `git revert` the card files +
  `hs project upload`).
- **Cron:** removing `vercel.json` crons stops the nightly auto-clone on deploy;
  to restore, redeploy the prior `vercel.json`.
