# Memo Builder

Generates a client-facing **Word document** of camp recommendations for a deal,
in the form and quality of the hand-made "Conway" memo: a header, an **At a
Glance** comparison table, and tight per-camp **Quick Summaries**. (The original
artifact's long "Detailed Write-Ups" section is intentionally dropped — that was
the "too much detail" we're trimming.)

It lives on the deal sidebar card at the **Recommendation Plan Presented** stage:
the Camp Expert ticks the camps to include, optionally adds special
instructions, and clicks **Generate Memo**. The doc is composed by Claude from
each camp's write-up + our session data, uploaded to HubSpot Files, and attached
to the deal.

---

## Architecture

```
Card (ReferralTableView → MemoBuilderSection)
  └─ POST /api/v2/deal/:dealId/generate-memo  { companyIds[], specialInstructions }
        │
        ├─ getDeal()                      → year, owner (expert), deal name
        ├─ for each selected company:
        │     ├─ company name + programid (HubSpot)
        │     ├─ getSessionsForProgram()  → tuition/weeks/dates/ages (Postgres)
        │     └─ getWriteupForCompany()   → narrative (write-up store)
        ├─ composeMemo()  → Claude (claude-opus-4-8, structured output)
        ├─ renderMemoDocx()               → .docx Buffer (docx lib)
        └─ deliverMemoToDeal()            → HubSpot Files upload + Note on deal
        ←  { fileUrl, fileId, noteId, campsIncluded, limitedInfoCamps }
```

Key files (all under `vercel-api/src`):

| File | Role |
|---|---|
| `lib/writeups.ts` | Resolve a camp's write-up by fuzzy name match. Sources: committed seed (default) / Postgres / auto. |
| `lib/memo-compose.ts` | Build the prompt (encodes the Conway-quality rules) + call Claude with structured outputs. |
| `lib/memo-docx.ts` | Render the structured memo to a `.docx` matching the Conway layout. |
| `lib/hubspot-files.ts` | Upload the `.docx` to HubSpot Files + attach to the deal (note engagement). |
| `app/api/v2/deal/[dealId]/generate-memo/route.ts` | Orchestrates the above; alerts on failure (Resend / HubSpot task). |
| `data/writeups.json` | Committed mirror of the Drive write-ups (the default source). |
| `hubspot-card/.../ReferralTableView.tsx` → `MemoBuilderSection` | The card UI. |

### Where the write-ups come from

The qualitative camp write-ups live in a **Google Drive folder** owned by the
Camp Experts team. The Vercel runtime can't reach Drive, so we **mirror** them
into `vercel-api/data/writeups.json` (extracted from Drive) and read from there
by default — zero runtime setup, no Google credentials, no CRM clutter.

- Matching is **by camp name**: the card sends the deal's associated company
  names; `getWriteupForCompany` normalizes both sides (drops "Camp"/"Write-Up"
  noise, expands `&`) and fuzzy-matches. A true write-up beats a recap.
- A camp with **no** write-up on file is still included as a **thin entry**
  (table row + short summary from structured data) and visibly **flagged** in
  the doc and in the card response (`limitedInfoCamps`).

### Optional: serve write-ups from the database instead of the seed

Set `MEMO_WRITEUP_SOURCE=db` (or `auto`) and load the seed into Postgres:

```sh
cd referral-builder/vercel-api
# applies migrations/002_camp_writeups.sql and upserts data/writeups.json
EXTERNAL_DATABASE_URL=postgres://... npm run sync-writeups
```

### Refreshing the write-ups

The seed is a point-in-time export of the Drive folder. To refresh it, re-run
the Drive extraction into `data/writeups.json` (the folder is owned by
`riley@campexperts.com`; the extractor reads every Google Doc whose title looks
like a write-up/recap), commit it, and — if using the DB source — re-run
`npm run sync-writeups`.

---

## Configuration

In **Vercel** (backend env):

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | From console.anthropic.com. Without it the route returns a clear 503. |
| `MEMO_MODEL` | No | Default `claude-opus-4-8`. |
| `MEMO_FILES_FOLDER` | No | HubSpot Files folder (default `camp-recommendation-memos`). |
| `MEMO_WRITEUP_SOURCE` | No | `seed` (default) / `db` / `auto`. |

In **HubSpot** (private app behind `HUBSPOT_ACCESS_TOKEN`): add the **`files`**
scope (needed to upload to HubSpot Files), in addition to the deal/company
scopes already granted.

---

## Deploy

1. **Backend:** merge to `main` → Vercel redeploys. Set `ANTHROPIC_API_KEY` and
   add the `files` scope to the HubSpot private app. Confirm `/api/health`.
2. **Card:** `hs project upload` from your machine (after `git pull`) → the
   **Generate Memo** section appears at Recommendation Plan Presented.

The card's `API_BASE` is the prod Vercel URL, so the card and API are
backward-compatible: deploying the API first is safe (the old card just won't
show the section yet), and the new card calls the new route once both are live.

---

## HubSpot test checklist

Work through this on a **TEST deal** at **Recommendation Plan Presented** with a
few associated camps (a mix that includes at least one camp with no write-up,
e.g. Timber Lake West).

- [ ] 🟢 The **Generate Memo** section shows under the referrals, listing each
      associated camp as a checkbox (all ticked by default).
- [ ] 🟢 Untick a camp, add special instructions (e.g. "the Conway family, sons
      Archie rising 5th and Luke rising 3rd; co-ed preferred"), click
      **Generate Memo**. Within ~1 min a success alert shows a **Download** link.
- [ ] 🟢 The downloaded `.docx` has: header, an **At a Glance** table (one row
      per included camp), and **Quick Summaries** — and reads in the expert's
      voice (not AI-ish), presents a set (no steering), and is short.
- [ ] 🟢 The memo is **attached to the deal** (Notes/attachments show the file).
- [ ] 🟢 A camp with **no write-up** appears as a thin entry, flagged "Limited
      info — no write-up on file", and is listed back in the card under
      "review before sending".
- [ ] 🟢 Camps with write-ups have substantive, accurate summaries grounded in
      the source (no invented prices/medical/policy details).
- [ ] 🔁 On a commission-locked deal, the section still generates (it writes no
      sacred fields) — confirm this is acceptable, or hide it when locked.
- [ ] 🟢 Temporarily unset `ANTHROPIC_API_KEY` (or use a deal with no camps) →
      a clear error, and a failure alert (Resend email or HubSpot task) for the
      key case.

## Rollback

- **API:** Vercel → promote the previous deployment. The memo route is additive;
  nothing else depends on it. The `camp_writeups` table (if created) is unused
  when `MEMO_WRITEUP_SOURCE=seed`.
- **Card:** re-upload the prior card version (or `git revert` the card files +
  `hs project upload`).
