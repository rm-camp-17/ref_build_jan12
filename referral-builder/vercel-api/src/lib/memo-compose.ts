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

export interface MemoSummaryLine {
  /** e.g. "Why it's here", "Water", "Trade-off". Empty for a plain paragraph. */
  label: string;
  text: string;
}

export interface MemoSummary {
  camp: string;
  /** e.g. "Timber Lake West — Roscoe, NY". */
  header: string;
  lines: MemoSummaryLine[];
  /** True when this camp had no write-up on file (thin entry — flag it). */
  limitedInfo: boolean;
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

const SYSTEM_PROMPT = `You are a Camp Experts placement advisor writing a camp recommendation memo for a prospective family. A Camp Expert sends this document to a parent after an intake call. You must reproduce the QUALITIES below, not just the format — the format is the easy part.

WHAT THE MEMO IS:
1. A short header.
2. An "At a Glance" comparison table — one row per camp: Camp, Location, Size, Sessions, Co-ed / B-S, Program Style. This lets the parent take in the whole set at a glance.
3. "Quick Summaries" — one tight write-up per camp, in labeled lines (e.g. "Why it's here:", "Water:", "Medical:", "Trade-off:"). Two to five lines each. This is the whole document. No multi-tier deep dives, no "fit-for-your-family" closers, no restating the intake.

THE QUALITIES (reproduce all of these — missing any one is a failure):
1. GENERIC ABOUT EACH CAMP. Describe each camp on its own terms — what it is, who it serves, how it's structured, what it's known for. Do NOT re-narrate the family's situation back to them or frame each camp through this specific kid. The parent already knows their kid; they want to learn about the camps.
2. PRESENTS A SET, NOT A PICK. Put forward several legitimate options. Do not push toward one camp through ranking, emphasis, or asymmetric caveats. If a camp has a real factual flag (e.g. no required swim instruction), name it plainly and factually — never use it to steer.
3. SCANNABLE THEN DEEP. The table is for fast scan; the summaries are the deeper read. Keep them tight.
4. THE EXPERT'S VOICE. Direct, confident, no hedging, no AI-sounding constructions. A person wrote this. Avoid "could be a great fit", "worth considering", "as an AI", em-dash-heavy hedging.
5. SHORT. The smallest document that gives the parent enough to make the next decision.

FAILURE MODES TO AVOID:
- Marketing copy (features without substance).
- Steering toward one camp.
- Re-narrating the family's situation in each camp section.
- Bloat / repetition.
- Missing a factual flag that's relevant to something the family raised.
- Hedging tone.
- Reads like AI.

GROUNDING RULES:
- Use ONLY the source material provided for each camp (its write-up and its structured session/tuition data). Do not invent facts, prices, medical details, or policies. If the table needs a value you don't have, write a brief honest placeholder like "Confirm" rather than fabricating.
- For a camp marked LIMITED INFO (no write-up on file), still include it: build its table row from whatever structured data exists, write a 1–2 line summary from that data, and set limitedInfo=true so the rep knows to fill it in. Do not invent narrative for these.
- Fill the table's qualitative columns (Location, Size, Co-ed/B-S, Program Style) from the write-up narrative. Fill Sessions from the structured session data (lengths in weeks) when available, otherwise from the write-up.
- Honor the rep's special instructions for tone, framing, and emphasis — but never let them push you into steering or fabrication.
- Keep each summary to 2–5 labeled lines. Order camps as they were provided.`;

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
        'Narrative: (NO WRITE-UP ON FILE — mark this camp limitedInfo=true; build only from structured data; do not invent narrative)'
      );
    }
    lines.push('');
  });

  lines.push(
    'Produce the memo as structured JSON: a header, an At-a-Glance table (one row per camp, in order), and Quick Summaries (one per camp, in order).'
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
          header: { type: 'string' },
          limitedInfo: { type: 'boolean' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['label', 'text'],
            },
          },
        },
        required: ['camp', 'header', 'limitedInfo', 'lines'],
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
        effort: 'high',
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
  return normalizeComposed(parsed);
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
          header: s.header || s.camp || '',
          limitedInfo: Boolean(s.limitedInfo),
          lines: Array.isArray(s.lines)
            ? s.lines.map((l) => ({ label: l.label || '', text: l.text || '' }))
            : [],
        }))
      : [],
  };
}
