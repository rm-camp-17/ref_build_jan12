/**
 * Memo composer — turns the selected camps' source material into a structured
 * recommendation memo using Claude.
 *
 * The artifact we're reproducing is the "Conway" memo: a header, an "At a
 * Glance" comparison table, and tight per-camp "Quick Summaries". The five
 * qualities that make it work (generic about each camp, presents a set not a
 * pick, scannable, the expert's voice, short) are encoded in the system prompt
 * below — the format is the easy part; these qualities are the product.
 *
 * Output is constrained with structured outputs (output_config.format) so the
 * result is always valid JSON we can render straight to .docx.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

// ============================================================================
// Inputs
// ============================================================================

export interface MemoSessionInput {
  name: string;
  weeks: number;
  tuition: number;
  currency: string;
  startDate: string;
  endDate: string;
  ageMin: number | null;
  ageMax: number | null;
  notes: string;
}

export interface MemoCampInput {
  companyId: string;
  name: string;
  /** Location from the company record, e.g. "Beach Lake, PA". May be blank. */
  location: string;
  /** Website from the company record (hyperlinked in the memo). May be blank. */
  website: string;
  /** Resolved write-up text, or null when none is on file. */
  writeupText: string | null;
  writeupType: 'writeup' | 'recap' | null;
  sessions: MemoSessionInput[];
}

export interface MemoContext {
  /** e.g. "the Conway Family" — may be blank if unknown. */
  preparedFor: string;
  /** Camp Expert (deal owner) name — may be blank. */
  expertName: string;
  /** Summer year the recommendations are for, e.g. "2027". */
  summerYear: string;
  /** e.g. "For Archie (rising 5th) and Luke (rising 3rd)" — may be blank. */
  forLine: string;
  /** Free-text rep instructions to steer tone / framing / emphasis. */
  specialInstructions: string;
}

// ============================================================================
// Output shape
// ============================================================================

export interface MemoTableRow {
  camp: string;
  location: string;
  ages: string; // "7–16" or "Rising 2nd grade and up"
  size: string; // "Mid-sized", "Large", "Intimate"
  coed: string; // "Co-ed" | "All boys" | "All girls" | ""
  sessions: string; // "3 / 4 wk · full summer"
  /** Religious/cultural affiliation — usually "" (column only shows when ≥1 camp has one). */
  affiliation: string;
}

/**
 * One camp's Quick Summary. Every camp uses the SAME three parts — a one/two
 * sentence "snapshot" (size + sessions + how the program runs), then "The feel"
 * and "Known for" — so the structure stays consistent. The prose must draw the
 * camp's ACTUAL character from its write-up (not generic warmth). `location` and
 * `website` are threaded in from the company record (not written by the model)
 * so they are always accurate.
 */
export interface MemoSummary {
  camp: string; // display name, nicely cased by the model
  snapshot: string; // factual one/two-liner: "[Camp] is a [size], [sessions] camp. It runs a [structured/elective] program."
  theFeel: string; // "The feel" — the camp's real character, in the advisor's voice
  knownFor: string; // "Known for" — signature programs / strengths
  location: string; // from the company record, e.g. "Beach Lake, PA"
  website: string; // from the company record (shown subtly next to the name)
}

export interface ComposedMemo {
  /** "the Conway Family" (or "" if not derivable from the deal name). */
  familyName: string;
  /** "Archie, rising 5th · Luke, rising 3rd" (or ""). */
  childrenLine: string;
  /** "2027" — echoed by the model, then overridden from context. */
  summerYear: string;
  /** Camp Expert name — echoed, then overridden from context. */
  preparedBy: string;
  /**
   * A short, neutral "Advisor Take": a curated framing that contrasts the
   * camps' character so the set feels hand-picked. NEVER ranks, recommends an
   * order, or uses negatives.
   */
  advisorTake: string;
  table: MemoTableRow[];
  summaries: MemoSummary[];
}

// ============================================================================
// Prompt
// ============================================================================

const SYSTEM_PROMPT = `You are a Camp Experts placement advisor writing a polished, premium camp recommendation memo for a prospective family. A Camp Expert sends this one-pager to a parent after an intake call. It should feel curated and advisory — like a thoughtful person narrowed the universe for this family — while helping the parent get a FEEL for each camp.

WHAT THE MEMO CONTAINS:
1. A compact header (family, summer year, children, who prepared it).
2. An "Advisor Take": a short, warm paragraph (2–4 sentences) that frames the set and contrasts the camps' character, so the family feels these were hand-picked for them.
3. An "At a Glance" comparison table — one row per camp: Camp, Location, Ages, Size, Co-ed, Sessions, and Affiliation (religious/cultural affiliation, ONLY when it applies — leave blank otherwise).
4. "Quick Summaries" — one short write-up per camp. EVERY camp uses the SAME three parts, in this order:
   - "snapshot": ONE or TWO factual sentences in this shape — "[Camp] is a [size], [session options] [co-ed/all-boys/all-girls] camp[ in Location]. It runs a [structured / choice-based / mixed] program[, opening into electives as campers get older]." This is the concrete one-liner; it carries the basic facts so the prose doesn't have to.
   - "theFeel": 1–3 sentences on the camp's REAL character — its vibe, culture, and the texture that makes it distinct.
   - "knownFor": 1–3 sentences on its signature programs and genuine strengths.
   No extra sections, no deep dives, no restating the intake.

VOICE — THE MOST IMPORTANT THING:
Write the way a seasoned Camp Experts advisor writes. Your write-up source material already contains that voice — DRAW THE SPECIFIC CHARACTER FROM IT rather than inventing generic warmth. The concrete textures ARE the feel. Use the camp's actual distinguishing details (its culture, traditions, how it carries itself), in plain advisor language.
  GOOD (real advisor voice): "Down-to-earth and low-frills, with a classic, spirited culture where everyone genuinely knows everyone. Small traditions — partial uniform, no makeup, one-piece suits — keep social pressure low. An easy place for a younger or first-time camper to land."
  BAD (generic, invented): "A warm, traditional community with a broad activity menu where kids settle in fast."
If the write-up gives you a vivid, specific detail that captures the camp, use it. If it doesn't, say less — never pad with platitudes.

HOW IT MUST READ (this is the product):
1. WRITTEN FOR A PARENT, NOT A CAMP DIRECTOR. Give the big picture and the texture — the kind of place it is and the experience a kid would have. Skip purely operational minutiae (exact bunk counts, staff names, retention percentages, acreage). But DO keep the specific, characterful details that help a parent feel the place.
2. EASY TO READ AND ELEGANT. Plain, warm, confident sentences. No jargon, no bullet soup, no hedging ("could be a great fit", "worth considering"), no AI-sounding constructions.
   NO FILLER. Cut empty, generic feel-good lines — never write things like "Any of these would give the kids a wonderful summer", "you can't go wrong", "all three are fantastic options", or similar platitudes. Every sentence must carry real, specific information. The Advisor Take in particular must END on substance (a genuine point of difference), not a reassuring closer.
3. CONSISTENT. Same structure (snapshot, The feel, Known for) for every camp; similar length and depth across all of them.
4. PRESENTS A SET, NOT A PICK. Put the camps forward as a slate of strong options. The Advisor Take may contrast their character, but it must NOT rank them, recommend an order, say which to "start with", or imply one is better than another.
5. POSITIVE AND NEUTRAL. Describe what each camp IS and what it's good at. Do NOT include trade-offs, drawbacks, "considerations", "things to confirm", gaps, weaknesses, or anything that reads as a negative or a caveat. If something doesn't apply or you don't know it, leave it out — never write a placeholder like "Confirm" or "TBD".

GROUNDING RULES:
- Use ONLY the source material provided for each camp (its write-up and its structured session/tuition data). Do not invent facts, prices, or specifics.
- HEADER: derive familyName (e.g. "the Conway Family") and childrenLine (e.g. "Archie, rising 5th · Luke, rising 3rd") from the deal name / context if present; otherwise leave them blank. Echo summerYear and preparedBy from the context.
- LOCATION is provided from our records — copy it into the table's Location column exactly as given; do not derive your own.
- AGES: the camper age or grade range from the write-up (e.g. "7–16" or "Rising 2nd grade and up"). Leave blank if not stated.
- SIZE: a parent-friendly word/phrase (e.g. "Intimate", "Mid-sized", "Large"), optionally with an approximate count in the snapshot.
- CO-ED: state whether the camp is co-ed, all boys, or all girls based on the write-up. If the write-up genuinely doesn't say, leave it blank — never write "Confirm".
- SESSIONS: from the structured session data (lengths in weeks) when available, otherwise from the write-up.
- AFFILIATION: religious or cultural affiliation (e.g. "Jewish, pluralistic") ONLY when the write-up makes it a defining feature; otherwise leave it blank. Do not invent one.
- The "snapshot" sentence weaves size + sessions + how the program runs (structured vs. choice-based electives) into one or two plain sentences. Keep it factual; the feel/known-for carry the character.
- If a camp has no write-up on file, still include it: fill what the structured data supports and keep everything brief and general. Do not invent narrative and do not flag it as missing.
- Honor the rep's special instructions for tone and emphasis — but never let them push you into ranking, negativity, or fabrication.
- Order camps exactly as they were provided.`;

export function buildUserPrompt(camps: MemoCampInput[], ctx: MemoContext): string {
  const lines: string[] = [];
  lines.push('CONTEXT FOR THE HEADER:');
  lines.push(`- Camp Expert / preparedBy (author): ${ctx.expertName || '(unknown)'}`);
  lines.push(`- Summer year: ${ctx.summerYear || '(unknown)'}`);
  lines.push(
    `- familyName + childrenLine: derive from the deal name in the instructions below (e.g. "Conway, Archie | 2027" → familyName "the Conway Family", childrenLine "Archie"). Leave blank if not derivable.`
  );
  lines.push('');
  if (ctx.specialInstructions && ctx.specialInstructions.trim()) {
    lines.push('SPECIAL INSTRUCTIONS FROM THE CAMP EXPERT (steer tone/framing/emphasis, never fabricate):');
    lines.push(ctx.specialInstructions.trim());
    lines.push('');
  }
  lines.push(`CAMPS TO INCLUDE (${camps.length}), in order:`);
  lines.push('');

  camps.forEach((camp, i) => {
    lines.push(`========== CAMP ${i + 1}: ${camp.name} ==========`);
    lines.push(
      `Location (from our records — use verbatim in the table): ${camp.location || '(not on file — leave Location blank)'}`
    );
    if (camp.website) {
      lines.push(`Website (for reference; do not put in the prose): ${camp.website}`);
    }
    if (camp.sessions.length > 0) {
      lines.push('Structured session data (from our tuition database):');
      for (const s of camp.sessions) {
        const age =
          s.ageMin != null || s.ageMax != null
            ? ` | ages ${s.ageMin ?? '?'}-${s.ageMax ?? '?'}`
            : '';
        const tuition = s.tuition ? ` | ${s.currency || 'USD'} ${s.tuition}` : '';
        const dates = s.startDate ? ` | ${s.startDate}–${s.endDate}` : '';
        lines.push(
          `  - ${s.name || 'Session'}: ${s.weeks || '?'} weeks${dates}${tuition}${age}${s.notes ? ` | ${s.notes}` : ''}`
        );
      }
    } else {
      lines.push('Structured session data: (none on file)');
    }
    lines.push('');
    if (camp.writeupText && camp.writeupText.trim()) {
      const kind = camp.writeupType === 'recap' ? 'CALL-NOTES / RECAP' : 'WRITE-UP';
      lines.push(`Narrative ${kind}:`);
      // Cap each camp's narrative so the prompt (and generation time) stays
      // bounded for multi-camp memos — the recaps run several KB and the memo
      // only summarizes them. Keeps the request under the upstream gateway
      // timeout. Overridable via MEMO_WRITEUP_CHAR_CAP.
      const text = camp.writeupText.trim();
      const cap = config.memo.writeupCharCap;
      lines.push(
        cap > 0 && text.length > cap
          ? text.slice(0, cap) + '\n…[truncated for length]'
          : text
      );
    } else {
      lines.push(
        'Narrative: (none on file — keep "theFeel" and "knownFor" brief and general from the structured data; do not invent specifics and do not flag it as missing)'
      );
    }
    lines.push('');
  });

  lines.push(
    'Produce the memo as structured JSON: header fields (familyName, childrenLine, summerYear, preparedBy), a short neutral advisorTake (no filler closer), an At-a-Glance table (one row per camp, in order: camp, location, ages, size, coed, sessions, affiliation [blank unless it applies]), and Quick Summaries (one per camp, in order, each with "snapshot", "theFeel", "knownFor"). Draw the real character from each write-up in the advisor\'s voice — no ranking, no trade-offs, no placeholders, no generic filler.'
  );
  return lines.join('\n');
}

// ============================================================================
// Structured-output schema (kept within structured-output limitations:
// additionalProperties:false everywhere, all properties required)
// ============================================================================

const MEMO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    familyName: { type: 'string' },
    childrenLine: { type: 'string' },
    summerYear: { type: 'string' },
    preparedBy: { type: 'string' },
    advisorTake: { type: 'string' },
    table: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          camp: { type: 'string' },
          location: { type: 'string' },
          ages: { type: 'string' },
          size: { type: 'string' },
          coed: { type: 'string' },
          sessions: { type: 'string' },
          affiliation: { type: 'string' },
        },
        required: ['camp', 'location', 'ages', 'size', 'coed', 'sessions', 'affiliation'],
      },
    },
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          camp: { type: 'string' },
          snapshot: { type: 'string' },
          theFeel: { type: 'string' },
          knownFor: { type: 'string' },
        },
        required: ['camp', 'snapshot', 'theFeel', 'knownFor'],
      },
    },
  },
  required: [
    'familyName',
    'childrenLine',
    'summerYear',
    'preparedBy',
    'advisorTake',
    'table',
    'summaries',
  ],
} as const;

// ============================================================================
// Compose
// ============================================================================

export class MemoComposeError extends Error {}

let _client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!_client) {
    if (!config.memo.anthropicApiKey) {
      throw new MemoComposeError(
        'ANTHROPIC_API_KEY is not configured. Set it in Vercel to enable memo generation.'
      );
    }
    _client = new Anthropic({ apiKey: config.memo.anthropicApiKey });
  }
  return _client;
}

/**
 * Compose the memo with Claude. Streams (to dodge SDK HTTP timeouts on the
 * longer, thinking-enabled request) and returns the validated structure.
 */
export async function composeMemo(
  camps: MemoCampInput[],
  ctx: MemoContext
): Promise<ComposedMemo> {
  if (camps.length === 0) {
    throw new MemoComposeError('No camps selected for the memo.');
  }

  const client = getClient();
  const userPrompt = buildUserPrompt(camps, ctx);

  let message;
  try {
    const stream = client.messages.stream({
      model: config.memo.model,
      max_tokens: 24000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: config.memo.effort,
        format: { type: 'json_schema', schema: MEMO_SCHEMA as unknown as Record<string, unknown> },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    } as Anthropic.MessageStreamParams);
    message = await stream.finalMessage();
  } catch (err: any) {
    throw new MemoComposeError(
      `Claude request failed: ${err?.message ?? String(err)}`
    );
  }

  if (message.stop_reason === 'refusal') {
    throw new MemoComposeError(
      'Claude declined to generate this memo (safety refusal).'
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new MemoComposeError(
      'Memo generation hit the output limit — try fewer camps or shorter instructions.'
    );
  }

  const textBlock = message.content.find((b: any) => b.type === 'text') as
    | { type: 'text'; text: string }
    | undefined;
  if (!textBlock || !textBlock.text) {
    throw new MemoComposeError('Claude returned no memo content.');
  }

  let parsed: ComposedMemo;
  try {
    parsed = JSON.parse(textBlock.text) as ComposedMemo;
  } catch {
    throw new MemoComposeError('Claude returned malformed memo JSON.');
  }
  // Year and author are known facts from context — don't trust the model's echo.
  if (ctx.summerYear) parsed.summerYear = ctx.summerYear;
  if (ctx.expertName) parsed.preparedBy = ctx.expertName;
  return applyCampFacts(normalizeComposed(parsed), camps);
}

/** Defensive normalization so the docx renderer never sees undefined holes. */
function normalizeComposed(m: ComposedMemo): ComposedMemo {
  return {
    familyName: m.familyName || '',
    childrenLine: m.childrenLine || '',
    summerYear: m.summerYear || '',
    preparedBy: m.preparedBy || '',
    advisorTake: m.advisorTake || '',
    table: Array.isArray(m.table)
      ? m.table.map((r) => ({
          camp: r.camp || '',
          location: r.location || '',
          ages: r.ages || '',
          size: r.size || '',
          coed: r.coed || '',
          sessions: r.sessions || '',
          affiliation: r.affiliation || '',
        }))
      : [],
    summaries: Array.isArray(m.summaries)
      ? m.summaries.map((s) => ({
          camp: s.camp || '',
          snapshot: s.snapshot || '',
          theFeel: s.theFeel || '',
          knownFor: s.knownFor || '',
          location: '',
          website: '',
        }))
      : [],
  };
}

/** Normalize a camp name for loose matching (case/punctuation-insensitive). */
function normName(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Thread the company-record facts (Location, Website) into the composed memo so
 * they're always accurate rather than model-derived: overrides each table row's
 * Location and attaches each summary's location + website. Matches by position
 * (the model is told to keep camp order) with a name-normalized fallback.
 */
function applyCampFacts(memo: ComposedMemo, camps: MemoCampInput[]): ComposedMemo {
  const byName = new Map<string, MemoCampInput>();
  for (const c of camps) byName.set(normName(c.name), c);

  const pick = (campName: string, index: number): MemoCampInput | undefined => {
    if (camps.length === memo.summaries.length && camps[index]) return camps[index];
    return byName.get(normName(campName));
  };

  return {
    ...memo,
    table: memo.table.map((row, i) => {
      const src =
        camps.length === memo.table.length && camps[i]
          ? camps[i]
          : byName.get(normName(row.camp));
      return src && src.location ? { ...row, location: src.location } : row;
    }),
    summaries: memo.summaries.map((s, i) => {
      const src = pick(s.camp, i);
      return {
        ...s,
        location: src?.location ?? '',
        website: src?.website ?? '',
      };
    }),
  };
}
