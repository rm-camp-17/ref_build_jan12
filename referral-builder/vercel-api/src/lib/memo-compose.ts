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
  size: string;
  sessions: string;
  coed: string;
  programStyle: string;
}

/**
 * One camp's Quick Summary. Every camp uses the SAME two sections — "The feel"
 * and "Known for" — so the headers stay consistent across the document. The
 * prose is parent-friendly: enough to get a feel for the camp, not a
 * microscopic point-by-point. `location` and `website` are threaded in from the
 * company record (not written by the model) so they are always accurate.
 */
export interface MemoSummary {
  camp: string; // display name, nicely cased by the model
  theFeel: string; // "The feel" — character/vibe and who thrives there
  knownFor: string; // "Known for" — signature programs / strengths
  location: string; // from the company record, e.g. "Beach Lake, PA"
  website: string; // from the company record (hyperlinked next to the name)
}

export interface ComposedMemo {
  title: string; // "Camp Experts"
  preparedFor: string; // "Prepared for the Conway Family by Denise"
  subtitle: string; // "Summer 2027 — Camp Recommendations"
  forLine: string; // "For Archie (rising 5th) and Luke (rising 3rd)"
  table: MemoTableRow[];
  summaries: MemoSummary[];
}

// ============================================================================
// Prompt
// ============================================================================

const SYSTEM_PROMPT = `You are a Camp Experts placement advisor writing a camp recommendation memo for a prospective family. A Camp Expert sends this document to a parent after an intake call. Your job is to help the parent get a FEEL for each camp — not to brief a specialist.

WHAT THE MEMO IS:
1. A short header.
2. An "At a Glance" comparison table — one row per camp: Camp, Location, Size, Sessions, Co-ed / B-S, Program Style. This lets the parent take in the whole set at a glance.
3. "Quick Summaries" — one short write-up per camp. EVERY camp uses the SAME two sections, in this order:
   - "The feel": 1–3 sentences on the camp's character and who tends to thrive there (size, energy, setting, vibe, structure).
   - "Known for": 1–3 sentences on its signature programs and genuine strengths.
   That is the whole document. No extra sections, no deep dives, no "fit-for-your-family" closers, no restating the intake.

HOW IT MUST READ (this is the product):
1. WRITTEN FOR A PARENT, NOT A CAMP DIRECTOR. Give the big picture — the kind of place it is, the experience a kid would have. A parent is trying to get a feel for the different options. Skip the microscopic operational detail (exact bunk counts, staff names, retention percentages, dining logistics, precise acreage). Those details are for our experts, not the parent.
2. EASY TO READ. Plain, warm, confident sentences. No jargon, no bullet soup, no hedging ("could be a great fit", "worth considering"), no AI-sounding constructions. A real person wrote this.
3. CONSISTENT. Same two section headers for every camp, similar length and depth across all of them. The set should feel even-handed.
4. PRESENTS A SET, NOT A PICK. Put the camps forward as a slate of good options. Do not rank them or steer toward one.
5. POSITIVE AND NEUTRAL. Describe what each camp IS and what it's good at. Do NOT include trade-offs, drawbacks, "things to confirm", gaps, weaknesses, or anything that reads as a negative or a caveat. If something doesn't apply or you don't know it, simply leave it out — never write a placeholder like "Confirm" or "TBD" and never flag missing information.

GROUNDING RULES:
- Use ONLY the source material provided for each camp (its write-up and its structured session/tuition data). Do not invent facts, prices, or specifics.
- LOCATION is provided to you from our records — copy it into the table's Location column exactly as given; do not derive your own.
- For Co-ed / B-S, state whether the camp is co-ed, all-boys, or all-girls based on the write-up. If the write-up genuinely doesn't say, leave the column blank — never write "Confirm".
- Fill the table's Size and Program Style columns from the write-up at a parent-friendly altitude (e.g. Size: "Mid-sized"; Program Style: "Traditional, broad activity menu"). Fill Sessions from the structured session data (lengths in weeks) when available, otherwise from the write-up.
- If a camp has no write-up on file, still include it: fill what the structured data supports and keep "The feel" / "Known for" brief and general. Do not invent narrative and do not flag it as missing.
- Honor the rep's special instructions for tone and emphasis — but never let them push you into steering, negativity, or fabrication.
- Order camps exactly as they were provided.`;

export function buildUserPrompt(camps: MemoCampInput[], ctx: MemoContext): string {
  const lines: string[] = [];
  lines.push('CONTEXT FOR THE HEADER:');
  lines.push(`- Prepared for: ${ctx.preparedFor || '(unknown — use a neutral greeting)'}`);
  lines.push(`- Camp Expert (author): ${ctx.expertName || '(unknown)'}`);
  lines.push(`- Summer year: ${ctx.summerYear || '(unknown)'}`);
  lines.push(`- Children / for-line: ${ctx.forLine || '(unknown — omit if you have nothing)'}`);
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
    'Produce the memo as structured JSON: a header, an At-a-Glance table (one row per camp, in order), and Quick Summaries (one per camp, in order). Each summary has exactly two fields — "theFeel" and "knownFor" — both parent-friendly, positive, and similar in length across camps. No trade-offs, caveats, or placeholders.'
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
    title: { type: 'string' },
    preparedFor: { type: 'string' },
    subtitle: { type: 'string' },
    forLine: { type: 'string' },
    table: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          camp: { type: 'string' },
          location: { type: 'string' },
          size: { type: 'string' },
          sessions: { type: 'string' },
          coed: { type: 'string' },
          programStyle: { type: 'string' },
        },
        required: ['camp', 'location', 'size', 'sessions', 'coed', 'programStyle'],
      },
    },
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          camp: { type: 'string' },
          theFeel: { type: 'string' },
          knownFor: { type: 'string' },
        },
        required: ['camp', 'theFeel', 'knownFor'],
      },
    },
  },
  required: ['title', 'preparedFor', 'subtitle', 'forLine', 'table', 'summaries'],
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
  return applyCampFacts(normalizeComposed(parsed), camps);
}

/** Defensive normalization so the docx renderer never sees undefined holes. */
function normalizeComposed(m: ComposedMemo): ComposedMemo {
  return {
    title: m.title || 'Camp Experts',
    preparedFor: m.preparedFor || '',
    subtitle: m.subtitle || '',
    forLine: m.forLine || '',
    table: Array.isArray(m.table)
      ? m.table.map((r) => ({
          camp: r.camp || '',
          location: r.location || '',
          size: r.size || '',
          sessions: r.sessions || '',
          coed: r.coed || '',
          programStyle: r.programStyle || '',
        }))
      : [],
    summaries: Array.isArray(m.summaries)
      ? m.summaries.map((s) => ({
          camp: s.camp || '',
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
